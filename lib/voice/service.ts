"use client";

export type VoiceState = "idle" | "recording" | "processing" | "ready" | "error";

export interface VoiceResult {
  text: string;
  mock: boolean;
  durationMs: number;
  blob?: Blob;
}

/**
 * VoiceService: microphone capture in the browser, transcription on the
 * server.
 *
 * There is one transcription path - POST /api/transcribe, which calls the
 * provider. Without credentials it returns an explicit error; it never
 * invents a transcript, and there is no browser SpeechRecognition fallback.
 */
export class VoiceService {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private startedAt = 0;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof window !== "undefined" &&
      typeof window.MediaRecorder !== "undefined";
  }

  async start(): Promise<void> {
    if (!VoiceService.isSupported()) {
      throw new Error("Microphone recording is not supported in this browser.");
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.startedAt = Date.now();

    const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(200);
  }

  /** Stops capture and returns the recorded audio. */
  async stop(): Promise<{ blob: Blob; durationMs: number }> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("Recording was not started.");

    const durationMs = Date.now() - this.startedAt;

    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      recorder.stop();
    });

    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    return { blob, durationMs };
  }

  cancel(): void {
    try { this.recorder?.stop(); } catch { /* already stopped */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }

  async transcribe(blob: Blob, durationMs: number): Promise<VoiceResult> {
    const form = new FormData();
    form.append("audio", new File([blob], "input.webm", { type: blob.type || "audio/webm" }));
    // The server records this against the transcription cost, so it has to
    // actually arrive rather than defaulting to zero.
    form.append("durationMs", String(durationMs));

    const res = await fetch("/api/transcribe", { method: "POST", body: form });
    const data = (await res.json()) as { text?: string; mock?: boolean; error?: string; hint?: string };

    if (!res.ok || !data.text) {
      // Never convert "transcription unavailable" into a fake transcript.
      throw new Error(data.hint ? `${data.error} ${data.hint}` : data.error ?? "Transcription failed.");
    }
    return { text: data.text, mock: Boolean(data.mock), durationMs, blob };
  }

  get isRecording(): boolean {
    return this.recorder?.state === "recording";
  }
}
