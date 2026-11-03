import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState, normalizeSignal, nativeSignal, createVisualizer, MOTION_STATES } from '../public/visualizer.js';
import { createDemoSignal } from '../public/demo-signal.js';
import { phaseFor } from '../public/cosmic.js';

test('five canonical states and safe application aliases', () => {
  assert.deepEqual(MOTION_STATES, ['idle', 'listening', 'thinking', 'speaking', 'error']);
  for (const state of MOTION_STATES) assert.equal(normalizeState(state), state);
  for (const value of ['working', 'processing']) assert.equal(normalizeState(value), 'thinking');
  for (const value of ['attention', 'interrupted']) assert.equal(normalizeState(value), 'error');
  for (const value of ['armed', 'approval', 'muted', 'ready', 'not-running', 'unknown', 'toString', '__proto__', undefined]) assert.equal(normalizeState(value), 'idle');
});
test('text generation never becomes speaking; approval retains application semantics', () => {
  for (const event of ['delta', 'tool', 'tool_done', 'status', 'working']) assert.equal(phaseFor(event), 'thinking');
  assert.equal(phaseFor('speaking'), 'speaking');
  assert.equal(phaseFor('listening'), 'listening');
  assert.equal(phaseFor('armed'), 'idle');
  assert.equal(phaseFor('approval'), 'approval');
  assert.equal(phaseFor('error'), 'attention');
});
test('signals clamp, resample, copy and expire without inventing live bands', () => {
  const bands = [2, -1, NaN, .5];
  const result = normalizeSignal({ source: 'spectrum', level: 4, bands, timestamp: 1000 }, 1100);
  assert.equal(result.level, 1); assert.equal(result.bands.length, 48);
  assert.equal(result.bands[0], 1); assert.equal(result.bands[12], 0); assert.equal(result.bands[24], 0); assert.equal(result.bands[36], .5);
  bands[0] = 0; assert.equal(result.bands[0], 1);
  for (const timestamp of [600, 1501, 1900, Infinity, NaN]) assert.equal(normalizeSignal({ source: 'spectrum', level: 1, bands, timestamp }, 1500).source, 'none');
  assert.equal(normalizeSignal({ source: 'native', level: .4, timestamp: 1000 }, 3500).source, 'native');
  assert.equal(normalizeSignal({ source: 'native', level: .4, timestamp: 1000 }, 3600).level, 0);
});
test('native scalar telemetry requires a live mic and fresh finite samples', () => {
  assert.equal(nativeSignal({ mic: true, audioLevel: 40, audioAgeMs: 50 }, 5000).level, .4);
  assert.equal(nativeSignal({ mic: true, audioLevel: 40, audioAgeMs: 50 }, 5000).bands.every(value => value === 0), true);
  for (const patch of [{ mic: false }, { audioAgeMs: 2500 }, { audioAgeMs: -1 }, { audioLevel: NaN }, { audioLevel: Infinity }]) {
    const signal = nativeSignal({ mic: true, audioLevel: 40, audioAgeMs: 50, ...patch }, 5000);
    assert.equal(signal.source, 'none'); assert.equal(signal.level, 0);
  }
});
test('synthetic source is explicit and only supplies listening/speaking', () => {
  const demo = createDemoSignal();
  assert.equal(demo('listening', 1000).source, 'demo');
  assert.equal(demo('speaking', 1000).source, 'demo');
  for (const state of ['idle', 'thinking', 'error']) assert.equal(demo(state, 1000).source, 'none');
});

function environment(t, { context = true, hidden = false } = {}) {
  const original = Object.fromEntries(['document', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'IntersectionObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let frames = new Map(), nextId = 0, frameTime = performance.now() + 20, mediaListener, visibilityListener, intersectionListener, resizeObserver;
  const listeners = new Map();
  const gradient = { addColorStop() {} };
  const ctx = context ? new Proxy({ createRadialGradient: () => gradient, createLinearGradient: () => gradient }, { get: (target, key) => key in target ? target[key] : () => {} }) : null;
  const parent = { classes: new Set(['is-static']), classList: { add(value) { parent.classes.add(value); }, remove(value) { parent.classes.delete(value); } } };
  const canvas = { width: 0, height: 0, dataset: {}, parentElement: parent, getContext: () => ctx, getBoundingClientRect: () => ({ width: 320, height: 320 }), addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  globalThis.document = { hidden, addEventListener: (name, fn) => { if (name === 'visibilitychange') visibilityListener = fn; }, removeEventListener: () => { visibilityListener = null; } };
  globalThis.matchMedia = () => ({ matches: false, addEventListener: (_, fn) => { mediaListener = fn; }, removeEventListener: () => { mediaListener = null; } });
  globalThis.requestAnimationFrame = fn => { frames.set(++nextId, fn); return nextId; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.ResizeObserver = class { constructor(fn) { resizeObserver = fn; } observe() {} disconnect() { resizeObserver = null; } };
  globalThis.IntersectionObserver = class { constructor(fn) { intersectionListener = fn; } observe() {} disconnect() { intersectionListener = null; } };
  t.after(() => { for (const [key, descriptor] of Object.entries(original)) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]; });
  return { canvas, parent, listeners, now: () => frameTime, frame: () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) (frameTime += 20, fn(frameTime)); }, media: matches => mediaListener?.({ matches }), visibility: value => { document.hidden = value; visibilityListener?.(); }, intersect: value => intersectionListener?.([{ isIntersecting: value }]), cleanup: () => ({ mediaListener, visibilityListener, intersectionListener, resizeObserver }) };
}

test('renderer lifecycle: RAF, reduced motion, visibility, intersection and idempotent destroy', t => {
  const env = environment(t); const motion = createVisualizer(env.canvas);
  assert.equal(motion.getDiagnostics().running, true); assert.equal(env.parent.classes.has('is-static'), false);
  motion.setReducedMotion(true); assert.equal(motion.getDiagnostics().running, false);
  motion.setReducedMotion(false); assert.equal(motion.getDiagnostics().running, true);
  env.visibility(true); assert.equal(motion.getDiagnostics().running, false);
  env.visibility(false); assert.equal(motion.getDiagnostics().running, true);
  env.intersect(false); assert.equal(motion.getDiagnostics().running, false);
  env.intersect(true); assert.equal(motion.getDiagnostics().running, true);
  motion.destroy(); motion.destroy(); assert.equal(motion.getDiagnostics().disposed, true); assert.equal(motion.getDiagnostics().running, false);
  assert.equal(env.cleanup().visibilityListener, null); assert.equal(env.cleanup().resizeObserver, null); assert.equal(env.listeners.size, 0);
});
test('missing context retains fallback; lost context can restore; explicit reduced override survives OS changes', t => {
  const missing = environment(t, { context: false }); const fallback = createVisualizer(missing.canvas);
  assert.equal(missing.parent.classes.has('is-static'), true); assert.equal(fallback.getDiagnostics().running, false); fallback.destroy();
  const env = environment(t); const motion = createVisualizer(env.canvas, { reducedMotion: false });
  env.media(true); assert.equal(motion.getDiagnostics().reducedMotion, false);
  env.listeners.get('contextlost')({ preventDefault() {} }); assert.equal(env.parent.classes.has('is-static'), true);
  env.listeners.get('contextrestored')(); assert.equal(env.parent.classes.has('is-static'), false);
  motion.destroy();
});
test('provider failures/stale data fall back to none; error repeats do not continually restart', t => {
  const env = environment(t); let fail = false;
  const motion = createVisualizer(env.canvas, { signalProvider: () => { if (fail) throw Error('device lost'); return { source: 'spectrum', level: .5, timestamp: performance.now() }; } });
  env.frame(); assert.equal(motion.getDiagnostics().source, 'spectrum');
  fail = true; env.frame(); assert.equal(motion.getDiagnostics().source, 'none');
  motion.setState('error'); env.frame(); motion.setState('error'); assert.equal(motion.getDiagnostics().state, 'error');
  motion.destroy();
});
