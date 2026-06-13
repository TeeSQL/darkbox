import { keccak256, toHex, type Hex } from "viem";

export function audioHash(bytes: Uint8Array | string): Hex {
  if (typeof bytes === "string") return keccak256(toHex(`darkbox:audio:${bytes}`));
  return keccak256(toHex(bytes));
}

export function transcriptHash(text: string): Hex {
  return keccak256(toHex(`darkbox:transcript:${text}`));
}

export function instructionHash(text: string): Hex {
  return keccak256(toHex(text.trim()));
}
