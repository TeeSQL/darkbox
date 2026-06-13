/**
 * Pluggable speech-to-text.
 *
 * - "stub": deterministic, no network. Produces a stable placeholder transcript
 *   derived from the audio so the whole stack is runnable offline and in CI, and
 *   so the demo's audio path works without a paid STT provider. The gateway also
 *   has a typed-instruction fallback, so STT is never the demo critical path.
 * - "http": POST the audio to an OpenAI-compatible `/audio/transcriptions`
 *   endpoint (e.g. a self-hosted whisper in the TEE, or a provider).
 */
import { config } from "./config.js";

export interface TranscribeInput {
  audio?: Uint8Array;
  audioUrl?: string;
  telegramFileId?: string;
  languageHint?: string;
}

export interface TranscribeResult {
  transcript: string;
  language: string;
  durationMs: number;
}

function stubTranscribe(input: TranscribeInput): TranscribeResult {
  const size = input.audio?.byteLength ?? 0;
  // Deterministic, clearly-labelled placeholder. Never fabricate plausible
  // strategy text — make it obvious this is a stub so it can't be mistaken for
  // a real transcription in a demo.
  const ref = input.telegramFileId ?? input.audioUrl ?? `bytes:${size}`;
  return {
    transcript: `[[stub-transcript for ${ref} — set STT_MODE=http for real STT]]`,
    language: input.languageHint ?? "en",
    durationMs: size > 0 ? Math.min(60000, Math.round(size / 16)) : 0,
  };
}

async function httpTranscribe(input: TranscribeInput): Promise<TranscribeResult> {
  if (!config.sttUrl) throw new Error("STT_URL not configured for http mode");
  let audio = input.audio;
  if (!audio && input.audioUrl) {
    const r = await fetch(input.audioUrl);
    if (!r.ok) throw new Error(`fetch audio failed: ${r.status}`);
    audio = new Uint8Array(await r.arrayBuffer());
  }
  if (!audio) throw new Error("no audio bytes to transcribe");

  const form = new FormData();
  form.append("model", config.sttModel);
  if (input.languageHint) form.append("language", input.languageHint);
  form.append("file", new Blob([audio as BlobPart], { type: "audio/ogg" }), "audio.ogg");

  const headers: Record<string, string> = {};
  if (config.sttApiKey) headers["authorization"] = `Bearer ${config.sttApiKey}`;

  const res = await fetch(config.sttUrl, { method: "POST", headers, body: form });
  if (!res.ok) throw new Error(`stt provider ${res.status}`);
  const json = (await res.json()) as { text?: string; language?: string; duration?: number };
  return {
    transcript: (json.text ?? "").trim(),
    language: json.language ?? input.languageHint ?? "en",
    durationMs: json.duration ? Math.round(json.duration * 1000) : 0,
  };
}

export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  return config.sttMode === "http" ? httpTranscribe(input) : stubTranscribe(input);
}
