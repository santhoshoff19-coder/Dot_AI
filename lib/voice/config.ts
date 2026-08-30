/** Transcription model. Configurable; priced per second of audio. */
export const TRANSCRIPTION_MODEL =
  process.env.TRANSCRIPTION_MODEL ?? "openai/whisper-large-v3";

/** OpenRouter caps uploads at 25 MB; stay comfortably under it. */
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

export const ALLOWED_AUDIO_MIME = new Set([
  "audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg",
  "audio/mp3", "audio/mp4", "audio/flac",
]);

export function audioFormatFor(mime: string): string {
  const m = mime.split(";")[0];
  return {
    "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav",
    "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/mp3": "mp3",
    "audio/mp4": "mp4", "audio/flac": "flac",
  }[m] ?? "webm";
}
