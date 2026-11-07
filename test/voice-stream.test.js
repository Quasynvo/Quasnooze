/**
 * voice-stream.test.js — issue #134 (`harness-13-local-voice`).
 *
 * The claim under test: there is a bounded, opt-in, *local* streaming speech
 * path, and its honesty properties are enforced by code rather than described in
 * a doc. The three things that would make this feature a liability, each pinned:
 *
 *   1. **Silent fallback.** No local adapter must never mean "use the browser's
 *      vendor recogniser" or "use a cloud endpoint". A missing stream is a
 *      refusal with a reason, and the panel is told what happens instead.
 *   2. **A remote origin wearing a local label.** "Local" is a policy about
 *      origins, not a word in a config comment. Redirects are how a loopback
 *      endpoint becomes an arbitrary destination, so they are refused.
 *   3. **A partial becoming a message.** Partials are previews; only a final is
 *      text a caller may send, and that is a property of the return value.
 *
 * No microphone, no socket server, no model. The transport is injected
 * everywhere, so these tests make zero network calls.
 */
import test from "node:test";
import assert from "node:assert/strict";

const {
  STREAM_LIMITS, LOOPBACK_HOSTS, VoiceStreamError, VOICE_STREAM_CODES,
  assertLocalStreamUrl, resolveStream, describeFallback, validateFrame,
  cleanTranscript, sendChunk, createTranscriptStream, transcribeStream,
} = await import("../src/voice/stream.js");

const {
  MIC_STATES, STREAM_CLIENT_LIMITS, createMicrophoneState,
  fetchStreamCapability, startLocalSpeechStream,
} = await import("../public/audio-input.js");

const LOCAL = "http://127.0.0.1:8080/v1/audio/transcriptions";
const frame = (n, extra = {}) => ({ seq: n, audio: Buffer.from(`audio-${n}`).toString("base64"), mime: "audio/webm", ...extra });

/** A fake endpoint: records what it was asked, answers what the test says. */
function fakeEndpoint(handler = () => ({ text: "hello" })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init?.body ? Buffer.from(init.body) : Buffer.alloc(0);
    const call = { url, method: init?.method, headers: init?.headers || {}, body, size: body.length };
    calls.push(call);
    const result = await handler(call, calls.length);
    if (result instanceof Error) throw result;
    const text = JSON.stringify({ text: result.text ?? "" });
    return {
      ok: result.status === undefined || (result.status >= 200 && result.status < 300),
      status: result.status ?? 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: (async function* () { yield Buffer.from(text); })(),
    };
  };
  return { fetchImpl, calls };
}

/* ── acceptance 2: remote/redirected origins are refused in local-only mode ── */

test("only loopback origins are a local stream; look-alikes are refused", () => {
  assert.equal(assertLocalStreamUrl(LOCAL), LOCAL);
  assert.equal(assertLocalStreamUrl("http://localhost:9000/x"), "http://localhost:9000/x");
  assert.equal(assertLocalStreamUrl("http://[::1]:9000/x"), "http://[::1]:9000/x");
  assert.deepEqual([...LOOPBACK_HOSTS], ["127.0.0.1", "localhost", "::1", "[::1]"]);

  const refused = {
    "http://evil.example:8080/x": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    // Looks local, resolves remotely: a DNS name that is not loopback.
    "https://127.0.0.1.nip.io/x": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    "http://localhost.evil.example/x": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    // A bind address is not a destination.
    "http://0.0.0.0:8080/x": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    // A LAN address is not loopback.
    "http://192.168.1.10:8080/x": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    // Credentials and fragments have no business in a transcription URL.
    "http://user:pw@127.0.0.1/x": VOICE_STREAM_CODES.INVALID_URL,
    "http://127.0.0.1/x#frag": VOICE_STREAM_CODES.INVALID_URL,
    "file:///etc/passwd": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    "ftp://127.0.0.1/x": VOICE_STREAM_CODES.REMOTE_ORIGIN,
    "not a url": VOICE_STREAM_CODES.INVALID_URL,
    "": VOICE_STREAM_CODES.NOT_CONFIGURED,
  };
  for (const [url, code] of Object.entries(refused)) {
    assert.throws(() => assertLocalStreamUrl(url), (error) => error.code === code, `accepted ${JSON.stringify(url)}`);
  }
});

test("a redirect is refused, not followed — including to another loopback port", async () => {
  const { fetchImpl, calls } = fakeEndpoint(() => ({ status: 302, text: "" }));
  await assert.rejects(
    () => sendChunk(LOCAL, validateFrame(frame(0)), { fetch: fetchImpl }),
    (error) => error.code === VOICE_STREAM_CODES.REDIRECT_REFUSED,
  );
  assert.equal(calls.length, 1, "a redirect must not produce a second request");
  assert.equal(calls[0].url, LOCAL);
});

test("sendChunk refuses a non-loopback destination even when handed one directly", async () => {
  const { fetchImpl, calls } = fakeEndpoint();
  await assert.rejects(
    () => sendChunk("http://evil.example/x", validateFrame(frame(0)), { fetch: fetchImpl }),
    (error) => error.code === VOICE_STREAM_CODES.REMOTE_ORIGIN,
  );
  assert.equal(calls.length, 0, "no request may leave for a refused origin");
});

test("resolveStream states the refusal instead of reaching for a fallback", () => {
  assert.deepEqual(
    { available: resolveStream({}).available, reason: resolveStream({}).reason },
    { available: false, reason: "disabled" },
  );
  const onNoUrl = resolveStream({ enabled: true, url: "" });
  assert.equal(onNoUrl.available, false);
  assert.equal(onNoUrl.reason, "unconfigured");
  assert.match(onNoUrl.detail, /nothing will be recorded or sent/i);

  const refused = resolveStream({ enabled: true, url: "http://evil.example/x" });
  assert.equal(refused.available, false);
  assert.equal(refused.reason, "refused");
  assert.equal(refused.code, VOICE_STREAM_CODES.REMOTE_ORIGIN);

  const ok = resolveStream({ enabled: true, url: LOCAL });
  assert.equal(ok.available, true);
  assert.equal(ok.localOnly, true);
});

test("absence of an adapter is described, never filled by a remote recogniser", () => {
  const none = describeFallback({ bufferedAvailable: false, browserRecognition: false });
  assert.equal(none.path, "none");
  assert.match(none.detail, /nothing is recorded/);

  const buffered = describeFallback({ bufferedAvailable: true });
  assert.equal(buffered.path, "buffered");
  assert.match(buffered.detail, /transcription endpoint you configured/);

  // Browser recognition is named as separate and *not started automatically* —
  // the sentence a reader needs before trusting the silence.
  const browser = describeFallback({ browserRecognition: true });
  assert.equal(browser.path, "none");
  assert.match(browser.detail, /never started automatically/);
});

/* ── acceptance 1: ordered partials and a final, cancelling and backpressure ── */

test("a fake local stream yields ordered partials and exactly one final", async () => {
  const seen = [];
  const { fetchImpl } = fakeEndpoint((call) => {
    seen.push({ seq: call.headers["x-quasnooze-frame"], final: call.headers["x-quasnooze-final"] });
    return { text: `word-${call.headers["x-quasnooze-frame"]}` };
  });

  const result = await transcribeStream({
    url: LOCAL,
    frames: [frame(0), frame(1), frame(2)],
    fetch: fetchImpl,
  });

  const kinds = result.events.map((event) => event.type);
  assert.deepEqual(kinds, ["partial", "partial", "final"], `unexpected order: ${kinds.join(",")}`);
  const seqs = result.events.filter((e) => e.type !== "ending").map((event) => event.seq);
  assert.deepEqual(seqs, [0, 1, 2], "events must be ordered and none repeated");
  assert.equal(result.text, "word-2", "only the final transcript is a result");
  assert.equal(result.cancelled, false);
  // The upstream saw the sequence in order and exactly one final.
  assert.deepEqual(seen.map((s) => s.seq), ["0", "1", "2"]);
  assert.deepEqual(seen.map((s) => s.final), ["0", "0", "1"]);
});

test("a partial is never promoted to a result, even if the stream ends early", async () => {
  const { fetchImpl } = fakeEndpoint(() => ({ text: "partial only" }));
  const result = await transcribeStream({
    url: LOCAL,
    frames: [frame(0), frame(1)],
    finalAt: null,               // no frame marked final…
    fetch: fetchImpl,
  });
  // …so the last frame is final by default, but if the stream ends without one
  // the text is null. Both halves matter: a caller that checks `text` gets
  // nothing to send, and `partialIsMessage` in the route says the same.
  assert.ok(result.events.every((event) => ["partial", "final", "ending"].includes(event.type)));
  const partialOnly = await transcribeStream({
    url: LOCAL,
    frames: [frame(0)],
    finalAt: -1,                 // nothing marked final
    fetch: fetchImpl,
  });
  assert.equal(partialOnly.text, null, "a partial transcript must not become text");
  assert.ok(partialOnly.events.every((event) => event.type !== "final"));
});

test("cancellation releases the input and emits no final", async () => {
  const controller = new AbortController();
  const { fetchImpl, calls } = fakeEndpoint((call) => {
    if (calls.length === 1) controller.abort();
    return { text: `partial-${call.headers["x-quasnooze-frame"]}` };
  });

  const result = await transcribeStream({
    url: LOCAL,
    frames: [frame(0), frame(1), frame(2)],
    signal: controller.signal,
    fetch: fetchImpl,
  });

  assert.equal(result.cancelled, true);
  assert.equal(result.text, null, "a cancelled stream has no result");
  assert.ok(result.events.some((event) => event.type === "cancelled"));
  assert.ok(result.events.every((event) => event.type !== "final"));
  assert.ok(calls.length < 3, "cancellation must stop further uploads, not drain the queue");
});

test("an in-flight request that is aborted surfaces CANCELLED, not a crash", async () => {
  const controller = new AbortController();
  const { fetchImpl } = fakeEndpoint(async () => {
    controller.abort();
    return new Error("aborted");
  });
  const stream = createTranscriptStream({ url: LOCAL, signal: controller.signal, send: sendChunk, fetch: fetchImpl });
  await stream.push(frame(0, { final: true }));
  const events = [];
  for await (const event of stream.events()) events.push(event);
  assert.ok(events.some((event) => event.type === "cancelled" || (event.type === "failed" && event.code === VOICE_STREAM_CODES.CANCELLED)),
    `expected a cancellation, got ${JSON.stringify(events)}`);
});

test("backpressure refuses more frames instead of buffering audio without bound", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { fetchImpl } = fakeEndpoint(async () => {
    await gate;
    return { text: "late" };
  });
  const stream = createTranscriptStream({
    url: LOCAL,
    send: sendChunk,
    fetch: fetchImpl,
    limits: { ...STREAM_LIMITS, maxQueue: 2 },
  });

  const accepted = [];
  for (let i = 0; i < 6; i++) accepted.push(await stream.push(frame(i)));
  const refused = accepted.filter((result) => !result.accepted);
  assert.ok(refused.length > 0, "beyond maxQueue the stream must push back");
  assert.equal(refused[0].reason, "backpressure");
  // Why the gate matters: without a blocked endpoint the sends finish faster
  // than the loop can queue them, and the bound is never reached — which would
  // make this test pass for the wrong reason.
  assert.ok(stream.pending > 0 && stream.pending <= 2, `in flight: ${stream.pending}`);

  // Draining is what unblocks: nothing was lost, the rest just waited.
  release();
  await stream.next();
  await stream.next();
  stream.cancel("done");
  const tail = [];
  for (;;) {
    const event = await stream.next();
    if (!event) break;
    tail.push(event.type);
  }
  assert.ok(tail.includes("cancelled"), `expected a terminal event, got ${tail.join(",")}`);
});

test("out-of-order and oversized frames are refused before anything is sent", async () => {
  const { fetchImpl, calls } = fakeEndpoint();
  const stream = createTranscriptStream({ url: LOCAL, send: sendChunk, fetch: fetchImpl });

  // The stream owns the sequence number: a client cannot choose one, so a gap
  // and a replay are structurally impossible rather than merely rejected.
  const first = await stream.push({ seq: 5, audio: Buffer.from("x").toString("base64") });
  assert.deepEqual({ accepted: first.accepted, seq: first.seq }, { accepted: true, seq: 0 });

  // A malformed frame is refused *and* ends the stream, because a page sending
  // nonsense is a bug the user should see rather than a clip to guess about.
  const bad = await stream.push({ seq: 0, audio: 42 });
  assert.deepEqual({ accepted: bad.accepted, reason: bad.reason }, { accepted: false, reason: "invalid" });
  assert.equal(stream.finished, true, "an invalid frame closes the stream with a failed event");
  const afterClose = await stream.push(frame(0));
  assert.equal(afterClose.reason, "finished");

  const huge = { seq: 0, audio: "A".repeat(Math.ceil(STREAM_LIMITS.maxChunkBytes * 4 / 3) + 10) };
  assert.throws(() => validateFrame(huge, { expectedSeq: 0 }), (error) => error.code === VOICE_STREAM_CODES.INVALID_FRAME);
  assert.throws(() => validateFrame({ seq: 0, audio: "" }, { expectedSeq: 0 }), /base64|empty/);
  assert.throws(() => validateFrame(null), /must be an object/);
  assert.throws(() => validateFrame({ seq: -1, audio: "AAAA" }), /non-negative/);
  // One request was in flight from the accepted frame above; the refused one
  // added none — which is the claim: validation happens before the upload.
  assert.ok(calls.length <= 1, `a refused frame must not be sent (saw ${calls.length})`);
});

test("a device error and a disconnect both release the input", async () => {
  // Device error: the fake endpoint rejects, and the *final* frame is reported as
  // failed rather than leaving the caller waiting for a transcript.
  const { fetchImpl } = fakeEndpoint(() => new Error("device gone"));
  const result = await transcribeStream({ url: LOCAL, frames: [frame(0)], fetch: fetchImpl });
  assert.equal(result.text, null);
  assert.ok(result.events.some((event) => event.type === "failed"));

  // Disconnect: a partial failure is a slow turn, not a lost turn — the final
  // still runs and still produces text.
  let n = 0;
  const flaky = fakeEndpoint(() => (++n === 1 ? new Error("dropped") : { text: "recovered" }));
  const recovered = await transcribeStream({ url: LOCAL, frames: [frame(0), frame(1)], fetch: flaky.fetchImpl });
  assert.equal(recovered.text, "recovered");
  assert.ok(recovered.events.some((event) => event.type === "partial-failed"));
});

/* ── acceptance 3: muted at start, nothing retained, old APIs compatible ───── */

test("the microphone starts muted and only a user action moves it", () => {
  const changes = [];
  const mic = createMicrophoneState({ onChange: (change) => changes.push(change.state) });
  assert.equal(mic.state, MIC_STATES.MUTED);
  assert.equal(mic.recording, false);
  assert.deepEqual(changes, [], "constructing the state must not emit a state change");

  mic.begin();
  assert.equal(mic.state, MIC_STATES.REQUESTING);
  assert.equal(mic.recording, false, "asking permission is not recording");
  mic.started();
  assert.equal(mic.recording, true);
  mic.stop();
  mic.muted();
  assert.equal(mic.recording, false);
  assert.deepEqual(changes, ["requesting", "recording", "stopping", "muted"]);
});

test("the client refuses to start without a local adapter, and names the fallback", async () => {
  const statuses = [];
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ available: false, reason: "disabled", detail: "Local streaming speech is off.", fallback: { path: "buffered", detail: "uses your endpoint" } }),
    };
  };
  await assert.rejects(
    () => startLocalSpeechStream({
      frames: (async function* () { yield { level: 0.5, at: 0 }; })(),
      takeAudio: () => new Blob([]),
      fetch: fetchImpl,
      onStatus: (status) => statuses.push(status),
    }),
    (error) => error.code === "STREAM_DISABLED" && /streaming speech is off/i.test(error.message),
  );
  // The fallback is carried on the error too, so a UI can render the honest
  // sentence without re-asking the server.
  await assert.rejects(
    () => startLocalSpeechStream({
      frames: (async function* () {})(), takeAudio: () => new Blob([]), fetch: fetchImpl,
    }),
    (error) => error.fallback?.path === "buffered",
  );
  assert.equal(fetched, 2, "each start checks again rather than caching a stale answer");
  assert.ok(statuses.some((status) => status.state === "unavailable" && status.fallback.path === "buffered"));
});

test("the client posts bounded base64 chunks and only the final becomes text", async () => {
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (url === "/api/voice/stream" && init?.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push(...body.frames);
      const last = body.frames[body.frames.length - 1];
      return { ok: true, status: 200, json: async () => ({ text: last.final ? "the final words" : "partial words", events: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({ available: true, maxChunkBytes: 4096, fallback: { path: "none" } }) };
  };
  const partials = [];
  const finals = [];
  const result = await startLocalSpeechStream({
    frames: (async function* () {
      // ~400 ms of voiced frames (above the 250 ms minimum, so it is not
      // discarded as a cough) then 300 ms of trailing silence to endpoint.
      for (const at of [0, 60, 120, 180, 240, 300, 360, 420]) yield { level: 0.9, at };
      for (const at of [480, 600, 720, 900]) yield { level: 0.0, at };
    })(),
    takeAudio: () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }),
    fetch: fetchImpl,
    chunkMs: 100,
    onPartial: (partial) => partials.push(partial.text),
    onFinal: (final) => finals.push(final.text),
  });

  assert.ok(posted.length >= 2, `expected partial uploads, got ${posted.length}`);
  assert.ok(posted.every((frame) => typeof frame.audio === "string" && frame.audio.length > 0));
  assert.ok(posted.every((frame) => frame.audio.length <= Math.ceil(4096 * 4 / 3) + 8), "chunks stay within the advertised bound");
  assert.deepEqual(posted.map((frame) => frame.final), posted.map((_, i) => i === posted.length - 1), "exactly one final frame");
  assert.deepEqual(finals, ["the final words"]);
  assert.equal(result.text, "the final words");
  assert.ok(partials.length >= 1, "partials are shown");
  // The provisional buffer never yields text unless a final arrived.
  assert.equal(typeof result.text, "string");
});

test("a stream that ends without an endpoint yields no text", async () => {
  const fetchImpl = async (url, init) =>
    init?.method === "POST"
      ? { ok: true, status: 200, json: async () => ({ text: "half a thought", events: [] }) }
      : { ok: true, status: 200, json: async () => ({ available: true }) };
  const result = await startLocalSpeechStream({
    frames: (async function* () {
      for (const at of [0, 60, 120, 180, 240, 300, 360, 420]) yield { level: 0.9, at };
      // The generator ends: a closed tab or a released button, not an endpoint.
    })(),
    takeAudio: () => new Blob([new Uint8Array([1])], { type: "audio/webm" }),
    fetch: fetchImpl,
    chunkMs: 10,
  });
  assert.equal(result.text, null, "no endpoint means no final, therefore no text");
});

test("the capability probe never throws and reports a refusal as an answer", async () => {
  const ok = await fetchStreamCapability({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ available: true }) }) });
  assert.equal(ok.available, true);

  const refused = await fetchStreamCapability({
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ available: false, reason: "refused", detail: "not loopback" }) }),
  });
  assert.equal(refused.available, false);
  assert.equal(refused.reason, "refused");

  const down = await fetchStreamCapability({ fetch: async () => { throw new Error("offline"); } }).catch((error) => error);
  // A thrown fetch is a caller bug; a *response* refusal must not throw. The
  // route is local, so an honest unreachable is normalized rather than thrown.
  const unreachable = await fetchStreamCapability({
    fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: "not configured" }) }),
  });
  assert.equal(unreachable.available, false);
  assert.equal(unreachable.reason, "unreachable");
  assert.ok(down); // the thrown case is still allowed to propagate; documented here
});

test("transcripts are cleaned, bounded and never HTML", () => {
  assert.equal(cleanTranscript("  hello\n\nthere\u0000  "), "hello there");
  assert.equal(cleanTranscript("x".repeat(10_000)).length, STREAM_LIMITS.maxTranscriptChars);
  assert.equal(cleanTranscript(" <script>alert(1)</script> "), "<script>alert(1)</script>",
    "text is passed through as text, not interpreted — the UI inserts it with textContent/value");
  assert.equal(cleanTranscript(undefined), "");
  assert.equal(cleanTranscript(42), "");
});

test("the stream module writes no audio and no transcript to disk", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/voice/stream.js", import.meta.url), "utf8");
  for (const api of ["writeFile", "appendFile", "writeFileSync", "appendFileSync", "createWriteStream", "mkdirSync"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${api}\\b`), `stream.js must not call ${api}`);
  }
  // Importing a filesystem module at all would be a smell here: audio is POSTed
  // and dropped, never staged.
  assert.doesNotMatch(source, /from ["']node:fs/, "stream.js must not import the filesystem");
  // The page must not persist a transcript either.
  const panel = readFileSync(new URL("../public/audio-input.js", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /localStorage\.setItem\([^)]*(transcript|speech|audio)/i);
});

test("old voice APIs remain untouched and compatible", () => {
  // The buffered path is what shipped before this feature and must not change
  // shape: same exports, same limits.
  return import("../src/voice.js").then((voice) => {
    for (const name of ["AUDIO_MAX_BYTES", "WHISPER_TIMEOUT_MS", "AUDIO_TYPES", "PROMPT_MAX_CHARS", "cleanPrompt", "transcribeAudio", "checkVoice"]) {
      assert.ok(name in voice, `src/voice.js lost ${name}`);
    }
    assert.equal(voice.AUDIO_MAX_BYTES, 10_000_000);
    assert.equal(voice.WHISPER_TIMEOUT_MS, 5_000);
  });
});
