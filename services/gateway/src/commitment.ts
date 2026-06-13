/**
 * Instruction commitment hashing for the whisper → registration flow.
 *
 * The confirmed transcript is the instruction preimage. We commit to it with
 * keccak256 so the registration can bind an `instructionHash` without revealing
 * the strategy until reveal. `transcriptHash` is a separate digest used for
 * audit/integrity of the exact confirmed text.
 */
import { keccak256, toHex, type Hex } from "viem";

export function instructionHash(transcript: string): Hex {
  return keccak256(toHex(transcript.trim()));
}

export function transcriptHash(transcript: string): Hex {
  return keccak256(toHex(`darkbox:transcript:${transcript}`));
}

export function audioHash(bytesOrRef: string): Hex {
  return keccak256(toHex(`darkbox:audio:${bytesOrRef}`));
}
