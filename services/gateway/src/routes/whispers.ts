/**
 * Whisper transcription flow (two-step: draft → confirm).
 *
 *  POST /api/whispers/transcriptions            — upload audio OR type text
 *  GET  /api/whispers/transcriptions/:whisperId — poll draft
 *  POST /api/whispers/transcriptions/:whisperId/confirm — confirm/edit → commit
 *
 * Privacy: raw audio + draft transcripts are sensitive and never exposed via any
 * public/leaderboard surface. Only the *confirmed* transcript becomes the
 * instruction preimage, and only its hash leaves the boundary in registration.
 *
 * Transcriber wiring: when `TRANSCRIBER_URL` is set and the request carries
 * audio, we proxy to the (private/TEE) transcriber service. Otherwise we accept
 * a typed transcript directly — the handover-sanctioned fallback so the demo
 * flow works even if STT slips (04_DAN_TODO #4).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { db, type Whisper } from "../store.js";
import { newId } from "../ids.js";
import { instructionHash, transcriptHash, audioHash } from "../commitment.js";
import { upstreamJson } from "../upstream.js";

// NOTE: no arbitrary `audioUrl`. Accepting a public URL here and forwarding it to
// the private transcriber would be an SSRF / resource-fetch vector from the
// confidential plane. Audio enters only as a Telegram file id or typed text.
const createBody = z.object({
  text: z.string().min(1).max(100000).optional(),
  telegramFileId: z.string().max(512).optional(),
  languageHint: z.string().max(16).optional(),
});

const confirmBody = z.object({
  finalTranscript: z.string().min(1),
  commitmentSalt: z.string().regex(/^0x[0-9a-fA-F]+$/).optional(),
});

function present(w: Whisper) {
  return {
    whisperId: w.whisperId,
    status: w.status,
    transcript: w.transcript,
    language: w.language,
    durationMs: w.durationMs,
    audioHash: w.audioHash,
    transcriptHash: w.transcriptHash,
    instructionHash: w.instructionHash,
    updatedAt: w.updatedAt,
  };
}

export async function whispersRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/whispers/transcriptions", async (req, reply) => {
    const parsed = createBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const { text, telegramFileId, languageHint } = parsed.data;
    const hasAudio = Boolean(telegramFileId);

    if (!text && !hasAudio) {
      return reply.status(400).send({ error: "need_text_or_audio" });
    }
    if (text && text.length > config.whisperMaxChars) {
      return reply.status(413).send({ error: "transcript_too_long", maxChars: config.whisperMaxChars });
    }

    let transcript: string;
    let language = languageHint ?? "en";
    let durationMs = 0;
    let aHash;
    let source: Whisper["source"];

    if (hasAudio && config.transcriberUrl) {
      // Proxy to the private transcriber service.
      try {
        const r = await upstreamJson<{
          transcript: string;
          language?: string;
          durationMs?: number;
          audioHash?: `0x${string}`;
        }>(`${config.transcriberUrl}/api/whispers/transcriptions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ telegramFileId, languageHint }),
          timeoutMs: 20000,
        });
        transcript = r.transcript;
        language = r.language ?? language;
        durationMs = r.durationMs ?? 0;
        aHash = r.audioHash ?? audioHash(telegramFileId ?? "");
        source = "audio";
      } catch (err) {
        req.log.error({ err }, "transcriber upstream failed");
        return reply.status(502).send({ error: "transcriber_unavailable" });
      }
    } else if (hasAudio && !config.transcriberUrl) {
      // Audio submitted but no transcriber configured yet.
      return reply.status(503).send({
        error: "transcriber_not_configured",
        hint: "submit { text } to use the typed-instruction fallback",
      });
    } else {
      // Typed fallback.
      transcript = text!.trim();
      aHash = audioHash(`typed:${transcript}`);
      source = "typed";
    }

    const w: Whisper = {
      whisperId: newId("whsp"),
      telegramId: req.telegramUser.id,
      status: "draft_ready",
      transcript,
      language,
      durationMs,
      audioHash: aHash,
      transcriptHash: transcriptHash(transcript),
      source,
      updatedAt: new Date().toISOString(),
    };
    db.putWhisper(w);
    return reply.send(present(w));
  });

  app.get<{ Params: { whisperId: string } }>(
    "/api/whispers/transcriptions/:whisperId",
    async (req, reply) => {
      const w = db.getWhisper(req.params.whisperId);
      if (!w) return reply.status(404).send({ error: "not_found" });
      if (w.telegramId !== req.telegramUser.id) {
        return reply.status(403).send({ error: "forbidden" });
      }
      return reply.send(present(w));
    },
  );

  app.post<{ Params: { whisperId: string } }>(
    "/api/whispers/transcriptions/:whisperId/confirm",
    async (req, reply) => {
      const w = db.getWhisper(req.params.whisperId);
      if (!w) return reply.status(404).send({ error: "not_found" });
      if (w.telegramId !== req.telegramUser.id) {
        return reply.status(403).send({ error: "forbidden" });
      }
      const parsed = confirmBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
      }
      const finalTranscript = parsed.data.finalTranscript.trim();
      if (finalTranscript.length > config.whisperMaxChars) {
        return reply.status(413).send({ error: "transcript_too_long", maxChars: config.whisperMaxChars });
      }

      w.transcript = finalTranscript;
      w.transcriptHash = transcriptHash(finalTranscript);
      w.instructionHash = instructionHash(finalTranscript);
      w.status = "confirmed";
      w.updatedAt = new Date().toISOString();
      db.putWhisper(w);

      return reply.send({
        whisperId: w.whisperId,
        status: "confirmed",
        instructionHash: w.instructionHash,
        commitmentPayload: {
          instructionHash: w.instructionHash,
          transcriptHash: w.transcriptHash,
        },
        updatedAt: w.updatedAt,
      });
    },
  );
}
