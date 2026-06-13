import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

process.env["STT_MODE"] = "stub";
process.env["MAX_TRANSCRIPT_CHARS"] = "50";

const { buildServer } = await import("../src/server.js");
const { store } = await import("../src/store.js");

const b64 = (s: string) => Buffer.from(s).toString("base64");

let app: Awaited<ReturnType<typeof buildServer>>;
before(async () => {
  app = await buildServer();
});
beforeEach(() => store._reset());
after(async () => {
  await app.close();
});

test("stub transcription returns a draft", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    payload: { audioBase64: b64("fake-ogg-bytes"), languageHint: "en" },
  });
  assert.equal(res.statusCode, 200);
  const d = res.json();
  assert.equal(d.status, "draft_ready");
  assert.match(d.transcript, /stub-transcript/);
  assert.match(d.audioHash, /^0x[0-9a-f]{64}$/);
});

test("missing audio is rejected", async () => {
  const res = await app.inject({ method: "POST", url: "/api/whispers/transcriptions", payload: {} });
  assert.equal(res.statusCode, 400);
});

test("a path-traversal / non-token telegramFileId is rejected (SSRF guard)", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    payload: { telegramFileId: "../../etc/passwd" },
  });
  assert.equal(res.statusCode, 400);
});

test("arbitrary audioUrl is no longer an accepted field", async () => {
  // audioUrl is dropped from the schema; with no audioBase64/telegramFileId this
  // must fall through to need_audio, never fetch the URL.
  const res = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    payload: { audioUrl: "http://169.254.169.254/latest/meta-data" },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "need_audio");
});

test("unknown whisper id is 404", async () => {
  const res = await app.inject({ method: "GET", url: "/api/whispers/transcriptions/nope" });
  assert.equal(res.statusCode, 404);
});

test("confirm commits an instruction hash and drops raw audio", async () => {
  const draft = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    payload: { audioBase64: b64("audio") },
  });
  const id = draft.json().whisperId;
  assert.ok(store.get(id)?.rawAudio, "raw audio retained pre-confirm");

  const confirm = await app.inject({
    method: "POST",
    url: `/api/whispers/transcriptions/${id}/confirm`,
    payload: { finalTranscript: "Buy NO on wrappers." },
  });
  assert.equal(confirm.statusCode, 200);
  const c = confirm.json();
  assert.equal(c.status, "confirmed");
  assert.match(c.instructionHash, /^0x[0-9a-f]{64}$/);
  assert.equal(store.get(id)?.rawAudio, undefined, "raw audio dropped on confirm");
});

test("over-long confirmed transcript is rejected", async () => {
  const draft = await app.inject({
    method: "POST",
    url: "/api/whispers/transcriptions",
    payload: { audioBase64: b64("audio") },
  });
  const id = draft.json().whisperId;
  const confirm = await app.inject({
    method: "POST",
    url: `/api/whispers/transcriptions/${id}/confirm`,
    payload: { finalTranscript: "x".repeat(200) },
  });
  assert.equal(confirm.statusCode, 413);
});
