import { NextRequest } from "next/server";
import { getOpenRouterKey } from "@/lib/credentials/store";
import { isMockMode } from "@/lib/providers";
import {
  ALLOWED_AUDIO_MIME, MAX_AUDIO_BYTES, TRANSCRIPTION_MODEL, audioFormatFor,
} from "@/lib/voice/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;


const ENDPOINT = "https://openrouter.ai/api/v1/audio/transcriptions";
const TIMEOUT_MS = 55_000;



/**
 * Transcribes recorded audio through OpenRouter.
 *
 * Audio is held in memory for the duration of the request and never written
 * to disk, logged, or retained. The key stays server-side.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "Expected an audio upload." }, { status: 400 });
  }

  const file = form.get("audio");
  if (!(file instanceof File)) {
    return Response.json({ error: "No audio was received." }, { status: 400 });
  }
  if (file.size === 0) {
    return Response.json({ error: "The recording was empty." }, { status: 400 });
  }
  if (file.size > MAX_AUDIO_BYTES) {
    return Response.json({
      error: `Recording is too large (${Math.round(file.size / 1e6)} MB). Keep it under 20 MB.`,
    }, { status: 413 });
  }
  const mime = file.type || "audio/webm";
  if (!ALLOWED_AUDIO_MIME.has(mime.split(";")[0])) {
    return Response.json({ error: `Unsupported audio type '${mime}'.` }, { status: 415 });
  }

  const durationMs = Number(form.get("durationMs") ?? 0);

  // Without a key there is nothing to transcribe against. Saying so is the
  // honest answer; inventing a transcript would be far worse.
  const key = await getOpenRouterKey();
  if (!key) {
    return Response.json({
      error: "No OpenRouter key is connected. Add one in Settings to use voice input.",
      code: "NO_CREDENTIALS",
      simulated: isMockMode(),
    }, { status: 400 });
  }

  const started = Date.now();
  try {
    const bytes = Buffer.from(await file.arrayBuffer());

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "dotAI",
      },
      body: JSON.stringify({
        model: TRANSCRIPTION_MODEL,
        input_audio: { data: bytes.toString("base64"), format: audioFormatFor(mime) },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      const code =
        res.status === 401 ? "AUTHENTICATION_ERROR"
        : res.status === 402 ? "INSUFFICIENT_CREDITS"
        : res.status === 429 ? "RATE_LIMIT"
        : res.status >= 500 ? "PROVIDER_UNAVAILABLE" : "INVALID_REQUEST";
      return Response.json({
        error: friendly(code),
        code,
        // Trimmed, and never echoing the key back.
        detail: detail.slice(0, 200),
      }, { status: res.status === 401 ? 401 : 502 });
    }

    const json = (await res.json()) as {
      text?: string;
      usage?: { total_cost?: number; cost?: number; seconds?: number };
    };

    const text = (json.text ?? "").trim();
    if (!text) {
      return Response.json({
        error: "Nothing could be transcribed from that recording.",
        code: "EMPTY_TRANSCRIPT",
      }, { status: 422 });
    }

    return Response.json({
      text,
      model: TRANSCRIPTION_MODEL,
      costUsd: json.usage?.total_cost ?? json.usage?.cost ?? 0,
      audioDurationMs: durationMs,
      latencyMs: Date.now() - started,
      simulated: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = /timeout|abort/i.test(message);
    return Response.json({
      error: timedOut
        ? "Transcription timed out. Try a shorter recording."
        : "Transcription failed.",
      code: timedOut ? "TIMEOUT" : "PROVIDER_ERROR",
    }, { status: 504 });
  }
}

function friendly(code: string): string {
  return {
    AUTHENTICATION_ERROR: "OpenRouter rejected the configured key.",
    INSUFFICIENT_CREDITS: "The OpenRouter account has insufficient credits.",
    RATE_LIMIT: "OpenRouter rate limit reached. Try again shortly.",
    PROVIDER_UNAVAILABLE: "The transcription provider is unavailable.",
    INVALID_REQUEST: "The transcription request was rejected.",
  }[code] ?? "Transcription failed.";
}
