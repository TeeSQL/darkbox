/** Opaque, sortable-ish id generation for gateway-owned records. */
import { randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
