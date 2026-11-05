import test from 'node:test';
import assert from 'node:assert/strict';
import { startAudioAnalysis } from '../public/audio-input.js';

function fixture(t, { getUserMedia, resume } = {}) {
  const original = Object.fromEntries(['isSecureContext', 'navigator', 'AudioContext'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const track = { readyState: 'live', onended: null, stop() { this.readyState = 'ended'; } };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const source = { disconnected: false, connect(node) { this.connected = node; }, disconnect() { this.disconnected = true; } };
  const analyser = { disconnected: false, frequencyBinCount: 512, fftSize: 1024, getByteFrequencyData(bytes) { bytes.fill(128); }, getFloatTimeDomainData(samples) { samples.fill(.1); }, disconnect() { this.disconnected = true; } };
  const context = { state: 'running', sampleRate: 48000, closed: false, resume: resume || (async () => { context.state = 'running'; }), createAnalyser: () => analyser, createMediaStreamSource: () => source, close: async () => { context.closed = true; context.state = 'closed'; } };
  Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { mediaDevices: { getUserMedia: getUserMedia || (async () => stream) } }, configurable: true });
  Object.defineProperty(globalThis, 'AudioContext', { value: class { constructor() { return context; } }, configurable: true });
  t.after(() => { for (const [key, descriptor] of Object.entries(original)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return { track, stream, source, analyser, context };
}

test('opt-in analysis produces bounded local FFT/RMS signals and never monitors the mic', async t => {
  const f = fixture(t); const session = await startAudioAnalysis();
  const signal = session.sample();
  assert.equal(signal.source, 'spectrum'); assert.equal(signal.bands.length, 48); assert.ok(signal.level > 0 && signal.level <= 1);
  assert.ok(signal.bands.every(value => value >= 0 && value <= 1)); assert.equal(f.source.connected, f.analyser);
  assert.equal(Object.hasOwn(f.analyser, 'connect'), false, 'analyser must not connect to a destination');
  session.stop(); session.stop(); assert.equal(f.track.readyState, 'ended'); assert.equal(f.context.closed, true);
  assert.equal(f.source.disconnected, true); assert.equal(f.analyser.disconnected, true); assert.equal(session.sample(), null); assert.equal(session.active, false);
});
test('permission denial closes the AudioContext and gives an actionable error', async t => {
  const f = fixture(t, { getUserMedia: async () => { throw new DOMException('Denied', 'NotAllowedError'); } });
  await assert.rejects(startAudioAnalysis(), /permission was denied/);
  assert.equal(f.context.closed, true);
});
test('aborting a pending prompt releases a late stream and rejects AbortError', async t => {
  let resolve;
  const f = fixture(t, { getUserMedia: () => new Promise(done => { resolve = done; }) });
  const abort = new AbortController(); const pending = startAudioAnalysis({ signal: abort.signal });
  abort.abort(); resolve(f.stream);
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.track.readyState, 'ended'); assert.equal(f.context.closed, true);
});
test('already-aborted requests never ask for a microphone', async t => {
  let calls = 0; fixture(t, { getUserMedia: async () => { calls++; throw Error('unexpected'); } });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(startAudioAnalysis({ signal: abort.signal }), error => error.name === 'AbortError');
  assert.equal(calls, 0);
});
test('device ended invalidates sampling and releases resources', async t => {
  const f = fixture(t); const session = await startAudioAnalysis();
  f.track.readyState = 'ended'; f.track.onended();
  assert.equal(session.active, false); assert.equal(session.sample(), null); assert.equal(f.context.closed, true);
});
test('resume failure does not leave a stream live or an unhandled rejection', async t => {
  const f = fixture(t, { resume: async () => { throw Error('Audio output device unavailable'); } });
  await assert.rejects(startAudioAnalysis(), /Audio output device unavailable/);
  assert.equal(f.track.readyState, 'ended'); assert.equal(f.context.closed, true);
});
test('invalid FFT sizes are rejected before capture', async t => {
  let calls = 0; fixture(t, { getUserMedia: async () => { calls++; } });
  await assert.rejects(startAudioAnalysis({ fftSize: 123 }), RangeError); assert.equal(calls, 0);
});

/* ───────── endpointing: the thing that decides you have stopped ─────────── */

import { createEndpointer, createProvisionalTranscript, startLocalDictation, ENDPOINTER_DEFAULTS } from '../public/audio-input.js';

/** Synthetic frames: a scripted level every `frameMs`, no microphone anywhere. */
function frames(script, { frameMs = 60 } = {}) {
  let at = 0;
  return script.flatMap(([level, ms]) => {
    const count = Math.max(1, Math.round(ms / frameMs));
    return Array.from({ length: count }, () => ({ level, at: (at += frameMs) }));
  });
}

function endpointOf(script, options = {}) {
  const endpointer = createEndpointer(options);
  const events = [];
  for (const frame of frames(script)) {
    const event = endpointer.push(frame.level, frame.at);
    if (event) events.push(event);
  }
  return { events, endpointer };
}

test('endpointing: trailing silence ends the utterance inside the configured window', () => {
  // 600 ms of speech, then quiet. The endpoint is a fact about silence, not a timer in the UI.
  const { events } = endpointOf([[0.2, 600], [0.01, 1200]]);
  const endpoint = events.find((e) => e.type === 'endpoint');
  assert.ok(endpoint, 'silence never produced an endpoint');
  assert.equal(endpoint.reason, 'silence');
  assert.ok(endpoint.endpointMs >= ENDPOINTER_DEFAULTS.silenceMs, `fired after ${endpoint.endpointMs} ms`);
  assert.ok(endpoint.endpointMs <= ENDPOINTER_DEFAULTS.silenceMs + 60, `fired after ${endpoint.endpointMs} ms, past the window`);
  assert.equal(endpoint.discarded, false);
});

test('endpointing: speech onset needs consecutive loud frames, not one click', () => {
  const oneClick = endpointOf([[0.2, 60], [0.01, 1200]]);
  assert.equal(oneClick.events.filter((e) => e.type === 'speech-start').length, 0, 'a single frame is not speech');
  const real = endpointOf([[0.2, 300], [0.01, 1200]]);
  assert.equal(real.events.filter((e) => e.type === 'speech-start').length, 1);
});

test('endpointing: hysteresis means a dip during speech is not the end of it', () => {
  // 0.05 sits between the silence and speech thresholds: quiet, but not a stop.
  const { events } = endpointOf([[0.2, 300], [0.05, 600], [0.2, 300], [0.01, 1200]]);
  assert.equal(events.filter((e) => e.type === 'endpoint').length, 1, 'the dip split the utterance');
});

test('endpointing: a maximum utterance cap ends a monologue without sending a lecture', () => {
  const { events } = endpointOf([[0.2, 2000]], { maxUtteranceMs: 900 });
  const endpoint = events.find((e) => e.type === 'endpoint');
  assert.equal(endpoint.reason, 'max-length');
  assert.ok(endpoint.speechMs <= 960, `let it run ${endpoint.speechMs} ms past a 900 ms cap`);
});

test('endpointing: a blip shorter than the minimum is endpointed and marked discarded', () => {
  const { events } = endpointOf([[0.2, 120], [0.01, 1200]]);
  const endpoint = events.find((e) => e.type === 'endpoint');
  assert.equal(endpoint.discarded, true);
  assert.ok(endpoint.speechMs < ENDPOINTER_DEFAULTS.minSpeechMs);
});

test('endpointing: reset forgets the utterance, so a stopped session cannot leak into the next', () => {
  const endpointer = createEndpointer();
  for (const frame of frames([[0.2, 300]])) endpointer.push(frame.level, frame.at);
  assert.equal(endpointer.speaking, true);
  endpointer.reset();
  assert.equal(endpointer.speaking, false);
  const endpoint = frames([[0.01, 1200]]).map((f) => endpointer.push(f.level, f.at)).filter(Boolean);
  assert.equal(endpoint.length, 0, 'a reset endpointer endpointed silence that was never speech');
});

/* ─────────── partials are provisional; only the final is a message ──────── */

test('partials replace each other and never become the committed text', () => {
  const buffer = createProvisionalTranscript();
  assert.equal(buffer.update('open the').provisional, true);
  assert.equal(buffer.update('open the garage').provisional, true);
  assert.equal(buffer.text, 'open the garage');
  assert.equal(buffer.committed, null, 'a partial was treated as committed');
  assert.deepEqual(buffer.commit(), { text: 'open the garage', provisional: false });
  assert.equal(buffer.text, '');
});

test('discarding a provisional transcript leaves nothing to send', () => {
  const buffer = createProvisionalTranscript();
  buffer.update('never mind');
  buffer.discard();
  assert.equal(buffer.commit(), null);
});

/* ───────────── the local pipeline: streaming and whole-clip ─────────────── */

/** The states a caller acts on, in order. `speech` is informational. */
const states = (h) => h.statuses.map((s) => s.state).filter((s) => s !== 'speech');

/** A recorder/poster fake: bounded audio, scripted transcripts, no network. */
function harness({ streaming = true, script = ['open the', 'open the garage'], finalText = 'open the garage door' } = {}) {
  const partials = [];
  const finals = [];
  const statuses = [];
  const posts = [];
  let chunk = 0;
  return {
    partials, finals, statuses, posts,
    frames: frames([[0.2, 600], [0.01, 1200]]),
    takeAudio: () => new Blob([`chunk-${chunk++}`], { type: 'audio/webm' }),
    post: async (blob, options) => {
      posts.push({ bytes: blob.size, prompt: options?.prompt ?? null, final: Boolean(options?.final) });
      // The terminal post is the one that decides the answer; a partial never does.
      return { text: options?.final ? finalText : script[Math.min(posts.length - 1, script.length - 1)] };
    },
    onPartial: (p) => partials.push(p),
    onFinal: (f) => finals.push(f),
    onStatus: (s) => statuses.push(s),
    streaming,
  };
}

test('streaming dictation sends bounded chunks with the previous transcript as prompt', async () => {
  const h = harness();
  const result = await startLocalDictation({
    frames: h.frames, takeAudio: h.takeAudio, post: h.post,
    onPartial: h.onPartial, onFinal: h.onFinal, onStatus: h.onStatus,
    streaming: true, chunkMs: 180,
  });
  assert.ok(h.posts.length >= 2, 'streaming produced no partial uploads');
  // Every upload after the first carries the previous transcript as context.
  assert.equal(h.posts[0].prompt, null);
  assert.equal(h.posts[1].prompt, 'open the');
  assert.equal(h.partials.length, h.posts.length - 1);
  assert.ok(h.partials.every((p) => p.provisional === true));
  assert.equal(h.finals.length, 1, 'a partial reached the final consumer');
  assert.equal(h.finals[0].text, 'open the garage door');
  assert.equal(result.text, 'open the garage door');
  assert.deepEqual(states(h), ['listening', 'endpoint', 'final']);
});

test('with streaming disabled the same utterance takes the whole-clip path', async () => {
  const h = harness({ streaming: false });
  const result = await startLocalDictation({
    frames: h.frames, takeAudio: h.takeAudio, post: h.post,
    onPartial: h.onPartial, onFinal: h.onFinal, onStatus: h.onStatus,
    streaming: false, chunkMs: 180,
  });
  assert.equal(h.posts.length, 1, 'the whole-clip path must post exactly once');
  assert.equal(h.posts[0].prompt, null);
  assert.deepEqual(h.partials, [], 'the whole-clip path must not render partials');
  assert.equal(h.finals.length, 1);
  assert.equal(result.text, 'open the garage door');
  // Same shape of events for the caller: only the intermediate partials differ.
  assert.deepEqual(states(h), ['listening', 'endpoint', 'final']);
});

test('an endpoint that discards a blip sends no audio and no transcript', async () => {
  const h = harness();
  const result = await startLocalDictation({
    frames: frames([[0.2, 120], [0.01, 1200]]),
    takeAudio: h.takeAudio, post: h.post,
    onPartial: h.onPartial, onFinal: h.onFinal, onStatus: h.onStatus,
    streaming: true, chunkMs: 60,
  });
  assert.equal(h.posts.length, 0, 'a discarded blip uploaded audio');
  assert.deepEqual(h.finals, []);
  assert.equal(result.text, null);
  assert.equal(h.statuses.at(-1).state, 'discarded');
});

test('a failed partial does not kill the utterance; a failed final reports and stops', async () => {
  const h = harness();
  let call = 0;
  const result = await startLocalDictation({
    frames: h.frames,
    takeAudio: h.takeAudio,
    post: async (blob, options) => {
      call++;
      if (call === 1) throw new Error('HTTP 502');
      return { text: 'the transcript that worked' };
    },
    onPartial: h.onPartial, onFinal: h.onFinal, onStatus: h.onStatus,
    streaming: true, chunkMs: 180,
  });
  assert.equal(result.text, 'the transcript that worked');
  assert.ok(h.statuses.some((s) => s.state === 'partial-failed'), 'a failed partial was swallowed silently');
});

test('aborting mid-utterance stops capture and sends nothing further', async () => {
  const h = harness();
  const abort = new AbortController();
  const pending = startLocalDictation({
    frames: (async function* () {
      yield* h.frames.slice(0, 3);
      abort.abort();
      yield* h.frames.slice(3);
    })(),
    takeAudio: h.takeAudio, post: h.post,
    onPartial: h.onPartial, onFinal: h.onFinal, onStatus: h.onStatus,
    streaming: true, chunkMs: 60, signal: abort.signal,
  });
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.deepEqual(h.finals, [], 'an aborted utterance produced a message');
});

/* ─────────── the deck: where this is actually reachable ─────────────────── */

test('the deck falls back to local dictation when the browser has no recogniser', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('public/index.html', 'utf8');
  // The old behaviour was a dead mic button. The new behaviour is a real path.
  assert.match(html, /if \(!SR\) \{/, 'the no-recogniser branch is gone');
  assert.match(html, /toggleLocalDictation\(\)/, 'the no-recogniser branch does not start local dictation');
  assert.match(html, /if \(SR\) \$\("mic"\)\.onclick/, 'the recognition click is not guarded by SR availability');
  // Local dictation talks to this machine, not to a browser vendor.
  assert.match(html, /fetch\("\/api\/transcribe"/);
  assert.match(html, /x-quasnooze-prompt/);
  assert.match(html, /startLocalDictation/);
});

test('a partial transcript is shown as provisional and never sent as a message', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('public/index.html', 'utf8');
  // Provisional marking exists...
  assert.match(html, /onPartial: \(\{ text \}\) => \{[\s\S]{0,400}aria-busy/, 'a partial is not marked provisional');
  // ...and the only call to send() from dictation sits behind a final transcript.
  assert.match(html, /if \(result\.text\) send\(\);/, 'the final transcript does not gate send()');
  const dictation = html.slice(html.indexOf('async function toggleLocalDictation'));
  const body = dictation.slice(0, dictation.indexOf('function showVoiceStatus'));
  assert.doesNotMatch(body, /addMsg\(/, 'dictation wrote to the conversation directly');
  assert.equal((body.match(/send\(\)/g) || []).length, 1, 'dictation can send more than once');
});

test('the deck never opens a second microphone for the same button', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync('public/audio-input.js', 'utf8');
  const html = readFileSync('public/index.html', 'utf8');
  // The session exposes the stream it already captured, and the deck records from it.
  assert.match(source, /get stream\(\) \{ return stream; \}/);
  assert.match(html, /new MediaRecorder\(session\.stream/);
  // A capability check may mention it; a call would be a second permission prompt.
  assert.doesNotMatch(html, /getUserMedia\s*\(/, 'the deck asks for the microphone itself');
  assert.match(html, /navigator\.mediaDevices\?\.getUserMedia\)/, 'the capability check was dropped');
});

/* ───── the design decision behind the silence rule, made checkable ──────── */

test('no request is made while the frames are silent, and no audio is dropped', async () => {
  // A natural pause mid-sentence (240 ms, under the 300 ms endpoint window) must
  // not cost a request, and must not cost audio either: the paused frames are
  // still captured and travel with the next chunk.
  const script = [[0.22, 360], [0.005, 240], [0.22, 300], [0.005, 600]];
  let frameAt = 0;
  let produced = 0;
  const duringSilence = [];
  const posts = [];
  const h = harness();
  await startLocalDictation({
    frames: (async function* () {
      for (const frame of frames(script)) { frameAt = frame.at; yield frame; }
    })(),
    takeAudio: () => new Blob([new Uint8Array(100).fill(++produced)], { type: 'audio/webm' }),
    post: async (blob, options) => {
      // The final upload necessarily happens *after* the silence that ended the
      // utterance; it is the partials that must never be paid for on silence.
      posts.push({ bytes: blob.size, at: frameAt, final: Boolean(options?.final) });
      return h.post(blob, options);
    },
    onPartial: h.onPartial, onFinal: h.onFinal, onStatus: h.onStatus,
    streaming: true, chunkMs: 180,
  });
  const silentFrames = new Set(frames(script).filter((f) => f.level < ENDPOINTER_DEFAULTS.silenceThreshold).map((f) => f.at));
  for (const post of posts) if (!post.final && silentFrames.has(post.at)) duringSilence.push(post.at);
  assert.deepEqual(duringSilence, [], 'a chunk was uploaded while the room was silent');
  // Every byte captured reached the server exactly once — nothing was dropped on
  // the floor just because the upload paused.
  const sent = posts.reduce((sum, post) => sum + post.bytes, 0);
  assert.equal(sent, produced * 100, `sent ${sent} bytes of ${produced * 100} captured`);
  assert.ok(posts.length >= 3, 'the pause stopped the partials entirely');
});
