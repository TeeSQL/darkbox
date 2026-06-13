/**
 * Thin client for internal upstream services (indexer, bridge, transcriber).
 *
 * These calls go gateway → internal service over the private network. Responses
 * are re-shaped into public-safe bodies by the routes; raw upstream payloads are
 * never streamed straight to the client. Every call is timeout-bounded so a
 * hung upstream can't wedge a player request.
 */
export class UpstreamError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function upstreamJson<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 5000, ...rest } = init;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ac.signal });
    if (!res.ok) {
      throw new UpstreamError(res.status, `upstream ${url} -> ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
