import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";

/**
 * OpenRouter credential store.
 *
 * Requirements this satisfies:
 *  - the key is never returned to the client in plaintext
 *  - it is never written to the database in plaintext
 *  - it is never placed in a prompt or sent to CAI as content
 *  - it never reaches the browser bundle (this module is server-only)
 *
 * For a local prototype the key is encrypted at rest with AES-256-GCM under a
 * machine-local secret. This is not a substitute for a real secrets manager,
 * but it is meaningfully better than plaintext on disk.
 */

const STORE_PATH = path.join(process.cwd(), ".credentials.json");
const ALGO = "aes-256-gcm";

interface StoredCredential {
  iv: string;
  tag: string;
  ciphertext: string;
  hint: string;      // last 4 characters only, safe to display
  createdAt: string;
}

function secret(): Buffer {
  // A deployment should set CREDENTIAL_SECRET. Without it we derive a stable
  // machine-local key so the prototype still protects the value at rest.
  const raw = process.env.CREDENTIAL_SECRET ?? `dotai-local-${process.cwd()}`;
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(plain: string): StoredCredential {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, secret(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    hint: plain.slice(-4),
    createdAt: new Date().toISOString(),
  };
}

function decrypt(stored: StoredCredential): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      ALGO, secret(), Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

async function read(): Promise<StoredCredential | null> {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, "utf8")) as StoredCredential;
  } catch {
    return null;
  }
}

/** Server-side only. Never call this from a client component. */
export async function getOpenRouterKey(): Promise<string | null> {
  const stored = await read();
  if (stored) {
    const key = decrypt(stored);
    if (key) return key;
  }
  // .env remains available for developer configuration.
  return process.env.OPENROUTER_API_KEY || null;
}

export async function setOpenRouterKey(key: string): Promise<void> {
  await fs.writeFile(STORE_PATH, JSON.stringify(encrypt(key)), { mode: 0o600 });
}

export async function clearOpenRouterKey(): Promise<void> {
  await fs.rm(STORE_PATH, { force: true });
}

/** Safe to send to the client: presence and a 4-character hint, never the key. */
export async function credentialStatus(): Promise<{
  connected: boolean;
  source: "stored" | "env" | "none";
  hint: string | null;
  createdAt: string | null;
}> {
  const stored = await read();
  if (stored && decrypt(stored)) {
    return { connected: true, source: "stored", hint: stored.hint, createdAt: stored.createdAt };
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      connected: true, source: "env",
      hint: process.env.OPENROUTER_API_KEY.slice(-4), createdAt: null,
    };
  }
  return { connected: false, source: "none", hint: null, createdAt: null };
}

/** Validates a key against OpenRouter without persisting it. */
export async function testOpenRouterKey(key: string): Promise<{ ok: boolean; detail: string }> {
  if (!key.startsWith("sk-or-")) {
    return { ok: false, detail: "An OpenRouter key normally begins with 'sk-or-'." };
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, detail: "Key accepted by OpenRouter." };
    if (res.status === 401) return { ok: false, detail: "OpenRouter rejected this key." };
    return { ok: false, detail: `OpenRouter returned ${res.status}.` };
  } catch (err) {
    return {
      ok: false,
      detail: `Could not reach OpenRouter: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
