/**
 * Transcriber configuration.
 *
 * This is a PRIVATE/confidential service (hidden/TEE plane). It is reachable only
 * from the gateway over an internal network — never from the public internet.
 * Raw audio and draft transcripts are sensitive (they are the strategy preimage)
 * and are bounded by a retention window; only hashes + the confirmed transcript
 * leave the boundary.
 */
export const config = {
  port: parseInt(process.env["PORT"] ?? "8095", 10),

  // STT backend: "stub" (deterministic, no external calls — default so the stack
  // is runnable offline) or "http" (OpenAI-compatible /audio/transcriptions).
  sttMode: (process.env["STT_MODE"] ?? "stub") as "stub" | "http",
  sttUrl: process.env["STT_URL"] ?? "",
  sttApiKey: process.env["STT_API_KEY"] ?? "",
  sttModel: process.env["STT_MODEL"] ?? "whisper-1",

  // Optional: resolve Telegram file ids to a downloadable URL (bot file API).
  telegramFileBaseUrl: process.env["TELEGRAM_FILE_BASE_URL"] ?? "",

  // Upload + retention guards.
  maxAudioBytes: parseInt(process.env["MAX_AUDIO_BYTES"] ?? "5000000", 10),
  maxTranscriptChars: parseInt(process.env["MAX_TRANSCRIPT_CHARS"] ?? "2000", 10),
  // Raw audio + draft transcript are purged this long after creation.
  retentionMs: parseInt(process.env["RETENTION_MS"] ?? "900000", 10), // 15 min
};

export type Config = typeof config;
