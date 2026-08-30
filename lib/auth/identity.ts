import { cookies } from "next/headers";
import crypto from "crypto";

/**
 * Minimal owner identity.
 *
 * The application has no authentication layer, so Library ownership is scoped
 * to a signed, http-only session cookie. This is deliberately modest: it
 * isolates one browser's prompts from another's and gives every record a
 * stable owner, which is what the Library needs. It is NOT authentication and
 * must be replaced before multi-user deployment.
 */
export const DEV_USER = "local-user";
const COOKIE = "dotai_uid";

function secret(): string {
  return process.env.SESSION_SECRET ?? `dotai-local-${process.cwd()}`;
}

function sign(id: string): string {
  const mac = crypto.createHmac("sha256", secret()).update(id).digest("base64url");
  return `${id}.${mac}`;
}

function verify(value: string): string | null {
  const idx = value.lastIndexOf(".");
  if (idx <= 0) return null;
  const id = value.slice(0, idx);
  return sign(id) === value ? id : null;
}

/** Resolves the current owner, minting a session id on first use. */
export async function currentUserId(): Promise<string> {
  try {
    const jar = await cookies();
    const raw = jar.get(COOKIE)?.value;
    const existing = raw ? verify(raw) : null;
    if (existing) return existing;

    const id = `u_${crypto.randomUUID()}`;
    jar.set(COOKIE, sign(id), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      secure: process.env.NODE_ENV === "production",
    });
    return id;
  } catch {
    // Outside a request context (tests, scripts) fall back to the dev owner.
    return DEV_USER;
  }
}

/** Non-throwing read, for places that must not mint a cookie. */
export async function peekUserId(): Promise<string> {
  try {
    const jar = await cookies();
    const raw = jar.get(COOKIE)?.value;
    return (raw ? verify(raw) : null) ?? DEV_USER;
  } catch {
    return DEV_USER;
  }
}
