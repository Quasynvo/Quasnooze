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
