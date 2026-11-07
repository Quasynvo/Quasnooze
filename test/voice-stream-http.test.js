/**
 * voice-stream-http.test.js — the streaming speech routes, over a real socket.
 *
 * `voice-stream.test.js` covers the policy and the state machine with injected
 * transports. This file covers the part that only shows up when a browser talks
 * to the server: does the panel get an honest capability answer, is a remote
 * origin refused *at the route* rather than the module, and does a redirect from
 * a loopback endpoint still get refused when it happens over TCP?
 *
 * The upstream is a real HTTP server on 127.0.0.1 — no cloud account, no model,
 * no microphone — so the loopback policy is exercised against a real origin
 * instead of a string.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const PORT = 8020 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;

let child;
let upstream;
let upstreamPort;
const upstreamHits = [];

/** A local "recogniser": one JSON line of text per chunk, and a redirect trap. */
async function startUpstream() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      upstreamHits.push({ url: req.url, bytes: body.length, final: req.headers["x-quasnooze-final"], seq: req.headers["x-quasnooze-frame"] });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://example.com/collect" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json" });
      const text = body.toString("utf8");
      // Echoing the payload makes "the invalid frame never arrived" provable.
      res.end(JSON.stringify({ text: text ? `heard ${text}` : "upstream received nothing" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function spawnServer(env = {}) {
  const proc = spawn(process.execPath, [join(root, "src", "index.js")], {
    cwd: root,
    env: {
      ...process.env,
      LLM_PROVIDER: "mock",
      PINCH_KEY: "",
      PINCH_PORT: String(PORT),
      PINCH_HOST: "127.0.0.1",
      PINCH_DATA: mkdtempSync(join(tmpdir(), "pinch-stream-data-")),
      PINCH_WORKSPACE: mkdtempSync(join(tmpdir(), "pinch-stream-ws-")),
      TELEGRAM_TOKEN: "",
      WHISPER_URL: "",
      ...env,
    },
    stdio: "ignore",
  });
  return proc;
}

async function waitFor(url, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.status) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${url} did not come up`);
}

const b64 = (text) => Buffer.from(text).toString("base64");

before(async () => {
  upstream = await startUpstream();
  upstreamPort = upstream.address().port;
  child = spawnServer();
  await waitFor(`${BASE}/api/health`).catch(() => waitFor(`${BASE}/`));
});

after(async () => {
  child?.kill("SIGKILL");
  await new Promise((resolve) => upstream.close(resolve));
});

test("with no adapter the panel is told so, and gets the honest fallback sentence", async () => {
  const response = await fetch(`${BASE}/api/voice/stream`);
  assert.equal(response.status, 200, "a missing feature is an answer, not an error");
  const data = await response.json();
  assert.equal(data.available, false);
  assert.equal(data.reason, "disabled");
  assert.match(data.detail, /off/i);
  // Nothing recorded, nothing sent: the sentence the UI renders verbatim.
  assert.equal(data.fallback.path, "none");
  assert.match(data.fallback.detail, /nothing is recorded/);
  assert.equal(data.limits.timeoutMs, 5_000);
});

test("posting audio with no adapter is refused instead of forwarded anywhere", async () => {
  const response = await fetch(`${BASE}/api/voice/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ frames: [{ seq: 0, audio: b64("fake-audio"), final: true }] }),
  });
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.available, false);
  assert.match(data.code, /^STREAM_/);
  assert.equal(upstreamHits.length, 0, "no request may leave for a recogniser");
});

test("a loopback stream produces ordered partials and one final over real HTTP", async () => {
  const proc = spawnServer({
    QUASNOOZE_VOICE_STREAM: "on",
    QUASNOOZE_VOICE_STREAM_URL: `http://127.0.0.1:${upstreamPort}/v1/stream`,
    PINCH_PORT: String(PORT + 100),
  });
  const base = `http://127.0.0.1:${PORT + 100}`;
  try {
    await waitFor(`${base}/api/voice/stream`);

    const capability = await (await fetch(`${base}/api/voice/stream`)).json();
    assert.equal(capability.available, true);
    assert.equal(capability.localOnly, true);
    assert.ok(!("url" in capability), "the endpoint URL is not echoed to the page");

    upstreamHits.length = 0;
    const response = await fetch(`${base}/api/voice/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frames: [
          { seq: 0, audio: b64("chunk-one"), final: false },
          { seq: 1, audio: b64("chunk-two"), final: false },
          { seq: 2, audio: b64("chunk-three"), final: true },
        ],
      }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    const types = data.events.map((event) => event.type);
    assert.deepEqual(types, ["partial", "partial", "final"], `order was ${types.join(",")}`);
    assert.equal(data.text, "heard chunk-three", "only the final transcript is a result");
    assert.equal(data.partialIsMessage, false, "the route says out loud that a partial is not a message");
    // The upstream saw three chunks in order, exactly one of them final.
    assert.deepEqual(upstreamHits.map((hit) => hit.seq), ["0", "1", "2"]);
    assert.deepEqual(upstreamHits.map((hit) => hit.final), ["0", "0", "1"]);
  } finally {
    proc.kill("SIGKILL");
  }
});

test("a redirected loopback endpoint is refused, and the redirect is not followed", async () => {
  const proc = spawnServer({
    QUASNOOZE_VOICE_STREAM: "on",
    QUASNOOZE_VOICE_STREAM_URL: `http://127.0.0.1:${upstreamPort}/redirect`,
    PINCH_PORT: String(PORT + 200),
  });
  const base = `http://127.0.0.1:${PORT + 200}`;
  try {
    await waitFor(`${base}/api/voice/stream`);
    upstreamHits.length = 0;
    const response = await fetch(`${base}/api/voice/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [{ seq: 0, audio: b64("x"), final: true }] }),
    });
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.equal(data.code, "STREAM_REDIRECT_REFUSED");
    assert.equal(data.text ?? null, null);
    // One hit — the request — and no second request to the redirect target.
    assert.equal(upstreamHits.length, 1);
  } finally {
    proc.kill("SIGKILL");
  }
});

test("a configured remote origin is refused at startup and at the route", async () => {
  const proc = spawnServer({
    QUASNOOZE_VOICE_STREAM: "on",
    QUASNOOZE_VOICE_STREAM_URL: "https://api.example.com/v1/audio/transcriptions",
    PINCH_PORT: String(PORT + 300),
  });
  const base = `http://127.0.0.1:${PORT + 300}`;
  try {
    await waitFor(`${base}/api/voice/stream`);
    const capability = await (await fetch(`${base}/api/voice/stream`)).json();
    assert.equal(capability.available, false);
    assert.equal(capability.reason, "refused");
    assert.equal(capability.code, "STREAM_REMOTE_ORIGIN");
    assert.match(capability.detail, /not a loopback origin/i);

    const response = await fetch(`${base}/api/voice/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [{ seq: 0, audio: b64("x"), final: true }] }),
    });
    assert.equal(response.status, 400);
    const data = await response.json();
    assert.equal(data.code, "STREAM_REMOTE_ORIGIN");
  } finally {
    proc.kill("SIGKILL");
  }
});

test("a malformed frame is a 400, not a transcription", async () => {
  const proc = spawnServer({
    QUASNOOZE_VOICE_STREAM: "on",
    QUASNOOZE_VOICE_STREAM_URL: `http://127.0.0.1:${upstreamPort}/v1/stream`,
    PINCH_PORT: String(PORT + 400),
  });
  const base = `http://127.0.0.1:${PORT + 400}`;
  try {
    await waitFor(`${base}/api/voice/stream`);
    upstreamHits.length = 0;
    const response = await fetch(`${base}/api/voice/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames: [{ seq: 0, audio: "", final: true }] }),
    });
    const status = response.status;
    const data = await response.json();
    // Either the route rejects the frame up front (400) or the stream closes
    // with a failed event and no text — both mean nothing was transcribed. What
    // must never happen is a transcript from an empty clip.
    assert.ok([400, 502].includes(status), `unexpected status ${status}`);
    if (status === 400) assert.equal(data.code, "STREAM_INVALID_FRAME");
    assert.equal(data.text ?? null, null, "an empty frame must not produce a transcript");
    assert.equal(upstreamHits.length, 0, "an invalid frame is never forwarded");
  } finally {
    proc.kill("SIGKILL");
  }
});
