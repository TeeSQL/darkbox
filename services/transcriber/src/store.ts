/**
 * Transcriber state — in-memory, retention-bounded. Raw audio and draft
 * transcripts are purged `retentionMs` after creation (and the raw audio is
 * dropped immediately on confirm). Behind a narrow interface so it can move to a
 * sealed store later.
 */
import type { Hex } from "viem";
import { config } from "./config.js";

export type WhisperStatus = "draft_ready" | "confirmed" | "expired";

export interface WhisperRecord {
  whisperId: string;
  status: WhisperStatus;
  transcript: string;
  language: string;
  durationMs: number;
  audioHash: Hex;
  transcriptHash: Hex;
  instructionHash?: Hex;
  /** Retained raw audio (purged on confirm or after retentionMs). */
  rawAudio?: Uint8Array;
  createdAt: number;
  updatedAt: number;
}

const records = new Map<string, WhisperRecord>();

export const store = {
  put(r: WhisperRecord): WhisperRecord {
    records.set(r.whisperId, r);
    return r;
  },
  get(id: string): WhisperRecord | undefined {
    const r = records.get(id);
    if (r && r.status !== "confirmed" && Date.now() - r.createdAt > config.retentionMs) {
      // Lazily expire: drop sensitive material, keep only hashes.
      r.status = "expired";
      r.rawAudio = undefined;
      r.transcript = "";
    }
    return r;
  },
  dropRawAudio(id: string): void {
    const r = records.get(id);
    if (r) r.rawAudio = undefined;
  },
  /** Periodic sweep so sensitive data doesn't linger even if never re-fetched. */
  sweep(): void {
    const now = Date.now();
    for (const r of records.values()) {
      if (r.status !== "confirmed" && now - r.createdAt > config.retentionMs) {
        r.status = "expired";
        r.rawAudio = undefined;
        r.transcript = "";
      }
    }
  },
  _reset(): void {
    records.clear();
  },
};
