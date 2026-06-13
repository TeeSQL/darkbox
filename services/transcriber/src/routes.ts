/**
 * Whisper transcription API (private; called by the gateway only).
 *
 *  POST /api/whispers/transcriptions            — audio in → draft transcript
 *  GET  /api/whispers/transcriptions/:whisperId — poll draft (no raw audio)
 *  POST /api/whispers/transcriptions/:whisperId/confirm — confirm/edit → commit
 *
 * Accepts audio as base64 JSON, an `audioUrl`, or a `telegramFileId` (resolved
 * via the bot file API when `TELEGRAM_FILE_BASE_URL` is set). The confirmed
 * transcript is the instruction preimage; its hash is what the gateway commits.
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { config } from "./config.js";
import { store, type WhisperRecord } from "./store.js";
import { transcribe } from "./stt.js";
import { audioHash, transcriptHash, instructionHash } from "./hash.js";

const newId = () => `whsp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

const createBody = z.object({
  audioBase64: z.string().optional(),
  audioUrl: z.string().url().max(2048).optional(),
  telegramFileId: z.string().max(512).optional(),
  languageHint: z.string().max(16).optional(),
});

const confirmBody = z.object({
  finalTranscript: z.string().min(1),
});

function draftView(r: WhisperRecord) {
  // Never returns rawAudio.
  return {
    whisperId: r.whisperId,
    status: r.status,
    transcript: r.transcript,
    language: r.language,
    durationMs: r.durationMs,
    audioHash: r.audioHash,
    transcriptHash: r.transcriptHash,
    instructionHash: r.instructionHash,
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function whisperRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/whispers/transcriptions", async (req, reply) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const { audioBase64, audioUrl, telegramFileId, languageHint } = parsed.data;

    let audio: Uint8Array | undefined;
    if (audioBase64) {
      const buf = Buffer.from(audioBase64, "base64");
      if (buf.byteLength > config.maxAudioBytes) {
        return reply.status(413).send({ error: "audio_too_large", maxBytes: config.maxAudioBytes });
      }
      audio = new Uint8Array(buf);
    }

    let resolvedUrl = audioUrl;
    if (!audio && !resolvedUrl && telegramFileId && config.telegramFileBaseUrl) {
      resolvedUrl = `${config.telegramFileBaseUrl}/${telegramFileId}`;
    }
    if (!audio && !resolvedUrl && !telegramFileId) {
      return reply.status(400).send({ error: "need_audio" });
    }

    let result;
    try {
      result = await transcribe({ audio, audioUrl: resolvedUrl, telegramFileId, languageHint });
    } catch (err) {
      req.log.error({ err }, "stt failed");
      return reply.status(502).send({ error: "stt_failed" });
    }

    const now = Date.now();
    const rec: WhisperRecord = {
      whisperId: newId(),
      status: "draft_ready",
      transcript: result.transcript,
      language: result.language,
      durationMs: result.durationMs,
      audioHash: audioHash(audio ?? (telegramFileId ?? resolvedUrl ?? "")),
      transcriptHash: transcriptHash(result.transcript),
      rawAudio: audio,
      createdAt: now,
      updatedAt: now,
    };
    store.put(rec);
    return reply.send(draftView(rec));
  });

  app.get<{ Params: { whisperId: string } }>(
    "/api/whispers/transcriptions/:whisperId",
    async (req, reply) => {
      const r = store.get(req.params.whisperId);
      if (!r) return reply.status(404).send({ error: "not_found" });
      return reply.send(draftView(r));
    },
  );

  app.post<{ Params: { whisperId: string } }>(
    "/api/whispers/transcriptions/:whisperId/confirm",
    async (req, reply) => {
      const r = store.get(req.params.whisperId);
      if (!r) return reply.status(404).send({ error: "not_found" });
      if (r.status === "expired") return reply.status(410).send({ error: "expired" });

      const parsed = confirmBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
      }
      const finalTranscript = parsed.data.finalTranscript.trim();
      if (finalTranscript.length > config.maxTranscriptChars) {
        return reply.status(413).send({ error: "transcript_too_long", maxChars: config.maxTranscriptChars });
      }

      r.transcript = finalTranscript;
      r.transcriptHash = transcriptHash(finalTranscript);
      r.instructionHash = instructionHash(finalTranscript);
      r.status = "confirmed";
      r.updatedAt = Date.now();
      store.dropRawAudio(r.whisperId); // raw audio no longer needed once confirmed
      store.put(r);

      return reply.send({
        whisperId: r.whisperId,
        status: "confirmed",
        instructionHash: r.instructionHash,
        commitmentPayload: { instructionHash: r.instructionHash, transcriptHash: r.transcriptHash },
        updatedAt: new Date(r.updatedAt).toISOString(),
      });
    },
  );
}
