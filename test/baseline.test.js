/**
 * Latency baseline (#85): synthetic, content-free phase timings.
 *
 * The two properties under test are the two the artifact exists for:
 *   1. the numbers are reproducible-shaped — deterministic percentiles, cold vs warm,
 *      handler vs first-text vs full-answer kept apart, mocks labelled as mocks;
 *   2. no content can ride along — a response, an error message, an environment built
 *      from the real config (which holds every token) must all fail to leak a canary.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  BASELINE_SCHEMA_VERSION,
  assertContentFree,
  collectEnvironment,
  configuredSecrets,
  percentile,
  renderBaseline,
  runBaseline,
  summarizeSamples,
} from "../src/baseline.js";

const CANARY = "canary-secret-4d91b7e2-do-not-log";

/** A clock the test advances by hand, so sample values are exact rather than plausible. */
function manualClock() {
  const state = { t: 0 };
  return { clock: { now: () => state.t }, advance: (ms) => { state.t += ms; } };
}

function fakeEnv(provider = "ollama") {
  return collectEnvironment({
    cfg: { numCtx: 8192, numPredict: 2048, llm: { provider, ollamaModel: "local:7b", openaiModel: "cloud-1" } },
    nodeVersion: "v22.11.0",
  });
}

/* ─────────────────────── percentiles and summaries ─────────────────────── */

test("percentiles are nearest-rank and deterministic", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([10], 95), 10);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([5, 15, 25], 50), 15);
});

test("summaries ignore samples that are not facts", () => {
  const summary = summarizeSamples([30, Number.NaN, -1, 10, Number.POSITIVE_INFINITY, 20], ["TIMEOUT"]);
  assert.deepEqual(summary, { n: 3, errors: 1, p50_ms: 20, p95_ms: 30, min_ms: 10, max_ms: 30 });
  assert.deepEqual(summarizeSamples([]), { n: 0, errors: 0, p50_ms: null, p95_ms: null, min_ms: null, max_ms: null });
});

/* ───────────────────────────── a measured run ──────────────────────────── */

test("handler, first-text and full-answer timings are measured separately", async () => {
  const { clock, advance } = manualClock();
  const artifact = await runBaseline({
    clock,
    environment: fakeEnv(),
    sampleCount: 3,
    handler: () => { advance(5); return { tier: "read" }; },
    chat: async (_messages, { onDelta }) => {
      advance(10);
      onDelta("ready");
      advance(20);
      return { content: "ready", provider: "ollama", toolCalls: [] };
    },
    now: "2026-11-03T00:00:00.000Z",
    peakRssMb: () => 42,
  });

  assert.equal(artifact.kind, "quasnooze-latency-baseline");
  assert.equal(artifact.schema_version, BASELINE_SCHEMA_VERSION);
  assert.equal(artifact.evidence_kind, "local-model");
  assert.equal(artifact.content_free, true);
  assert.equal(artifact.sample_count, 3);
  assert.equal(artifact.peak_rss_mb, 42);
  assert.deepEqual(artifact.providers_observed, ["ollama"]);

  const handler = artifact.phases.deterministic_handler;
  assert.equal(handler.measured, true);
  assert.deepEqual(handler.samples_ms, [5, 5, 5]);
  assert.equal(handler.cold_ms, 5);
  assert.equal(handler.warm.n, 2);

  assert.deepEqual(artifact.phases.first_text.samples_ms, [10, 10, 10]);
  assert.equal(artifact.phases.first_text.p50_ms, 10);
  assert.deepEqual(artifact.phases.full_answer.samples_ms, [30, 30, 30]);
  assert.equal(artifact.phases.full_answer.p95_ms, 30);
  assert.equal(artifact.phases.full_answer.errors, 0);

  assert.equal(artifact.phases.audio.measured, false);
  assert.equal(artifact.phases.audio.reason_code, "CONSENT_REQUIRED");
});

test("the first successful model sample is reported cold, the rest warm", async () => {
  const { clock, advance } = manualClock();
  let calls = 0;
  const artifact = await runBaseline({
    clock,
    environment: fakeEnv(),
    sampleCount: 3,
    handler: () => advance(1),
    chat: async (_messages, { onDelta }) => {
      calls += 1;
      advance(calls === 1 ? 900 : 30);
      onDelta("ready");
      return { content: "ready", provider: "ollama" };
    },
  });
  assert.equal(artifact.phases.full_answer.cold_ms, 900);
  assert.equal(artifact.phases.full_answer.warm.p50_ms, 30);
  assert.match(artifact.warm_cold, /cold/);
});

test("warm-up runs are executed, unrecorded, and the run is labelled warm", async () => {
  const { clock, advance } = manualClock();
  let calls = 0;
  const artifact = await runBaseline({
    clock,
    environment: fakeEnv(),
    sampleCount: 2,
    warmupCount: 2,
    handler: () => advance(1),
    chat: async (_messages, { onDelta }) => { calls += 1; advance(10); onDelta("x"); return { content: "x", provider: "ollama" }; },
  });
  assert.equal(calls, 4);
  assert.equal(artifact.phases.full_answer.n, 2);
  assert.match(artifact.warm_cold, /^warm/);
});

test("a provider that never streams has no first-text number, not an invented one", async () => {
  const { clock, advance } = manualClock();
  const artifact = await runBaseline({
    clock,
    environment: fakeEnv(),
    sampleCount: 1,
    handler: () => advance(1),
    chat: async () => { advance(25); return { content: "ready", provider: "ollama" }; },
  });
  assert.equal(artifact.phases.first_text.measured, false);
  assert.equal(artifact.phases.first_text.reason_code, "NO_STREAMING_DELTAS");
  assert.deepEqual(artifact.phases.full_answer.samples_ms, [25]);
});

test("without a chat function the model phases are not measured, with the caller's reason", async () => {
  const artifact = await runBaseline({
    environment: fakeEnv(),
    handler: () => {},
    modelSkip: { reason_code: "UNREACHABLE_BACKEND", reason: "Model phases were not run because readiness stopped them." },
  });
  assert.equal(artifact.phases.deterministic_handler.measured, true);
  for (const phase of [artifact.phases.first_text, artifact.phases.full_answer]) {
    assert.equal(phase.measured, false);
    assert.equal(phase.reason_code, "UNREACHABLE_BACKEND");
    assert.equal(phase.p50_ms, null);
  }
});

test("mock runs are labelled as mock evidence, never as a hardware measurement", async () => {
  const artifact = await runBaseline({
    environment: fakeEnv("mock"),
    handler: () => {},
    chat: async (_m, { onDelta }) => { onDelta("ready"); return { content: "ready", provider: "mock" }; },
  });
  assert.equal(artifact.evidence_kind, "mock");
  assert.deepEqual(artifact.providers_observed, ["mock"]);
});

/* ─────────────────────── consent gates the audio phase ─────────────────── */

test("an audio probe without consent is never called", async () => {
  let probed = 0;
  const artifact = await runBaseline({
    environment: fakeEnv(),
    handler: () => {},
    audioProbe: async () => { probed += 1; },
    consentAudio: false,
  });
  assert.equal(probed, 0);
  assert.equal(artifact.phases.audio.reason_code, "CONSENT_REQUIRED");
});

test("consent without a probe still measures nothing (the CLI opens no microphone)", async () => {
  const artifact = await runBaseline({ environment: fakeEnv(), handler: () => {}, consentAudio: true });
  assert.equal(artifact.phases.audio.measured, false);
  assert.equal(artifact.phases.audio.reason_code, "NO_AUDIO_PROBE");
});

test("consent plus a caller-owned probe is the only measured audio path", async () => {
  const { clock, advance } = manualClock();
  const artifact = await runBaseline({
    clock,
    environment: fakeEnv(),
    sampleCount: 2,
    handler: () => advance(1),
    consentAudio: true,
    audioProbe: async () => { advance(120); },
  });
  assert.equal(artifact.phases.audio.measured, true);
  assert.deepEqual(artifact.phases.audio.samples_ms, [120, 120]);
});

/* ────────────────────────── content-free, enforced ─────────────────────── */

test("model output is timed and discarded: a canary reply never lands in the artifact", async () => {
  const artifact = await runBaseline({
    environment: fakeEnv(),
    handler: () => {},
    sampleCount: 2,
    chat: async (_messages, { onDelta }) => {
      onDelta(CANARY);
      return { content: CANARY, provider: "ollama" };
    },
    secrets: [CANARY],
  });
  const json = JSON.stringify(artifact);
  assert.ok(!json.includes(CANARY), "model output leaked into the artifact");
  assert.ok(!json.includes("Reply with exactly"), "the synthetic prompt leaked into the artifact");
});

test("a provider error carrying a secret is recorded as a code only", async () => {
  const artifact = await runBaseline({
    environment: fakeEnv(),
    handler: () => {},
    sampleCount: 2,
    chat: async () => { throw new Error(`fetch failed, key=${CANARY}, ECONNREFUSED`); },
    secrets: [CANARY],
  });
  assert.equal(artifact.phases.full_answer.errors, 2);
  assert.deepEqual(artifact.phases.full_answer.error_codes, ["UNREACHABLE", "UNREACHABLE"]);
  assert.ok(!JSON.stringify(artifact).includes(CANARY), "error text leaked into the artifact");
});

test("the environment is picked field-by-field: config tokens cannot leak through it", () => {
  const cfg = {
    authKey: CANARY,
    numCtx: 8192,
    numPredict: 512,
    llm: { provider: "ollama", ollamaModel: "local:7b", openaiKey: CANARY, openaiModel: "cloud-1" },
    telegram: { token: CANARY }, discord: { token: CANARY }, slack: { token: CANARY },
  };
  const env = collectEnvironment({
    cfg,
    modelInfo: { digest: "sha256:deadbeef", quantization: "Q4_K_M", parameter_size: "7B", family: "llama" },
    nodeVersion: "v22.11.0",
  });
  assert.ok(!JSON.stringify(env).includes(CANARY), "a configured secret leaked into the environment record");
  assert.equal(env.model, "local:7b");
  assert.equal(env.model_digest, "sha256:deadbeef");
  assert.equal(env.model_quantization, "Q4_K_M");
  assert.equal(env.settings.num_ctx, 8192);
  assert.equal(env.settings.temperature, null, "settings this run did not set are null, not invented");
  assert.equal(env.gpu, null, "unmeasurable hardware is an explicit null");
  assert.ok(env.cpu.cores >= 1);
  assert.ok(env.memory_gb > 0);

  // auth key, cloud key, and the three channel tokens are all scan inputs.
  assert.deepEqual(configuredSecrets(cfg), [CANARY, CANARY, CANARY, CANARY, CANARY]);
  assert.deepEqual(configuredSecrets({ authKey: "abc" }), [], "short non-secret values are not treated as canaries");
});

test("assertContentFree fails closed, and its error never echoes the secret", () => {
  assert.throws(
    () => assertContentFree({ phases: { full_answer: { note: CANARY } } }, [CANARY]),
    (err) => err.code === "CONTENT_FREE_VIOLATION" && !err.message.includes(CANARY),
  );
  assert.throws(
    () => assertContentFree({ prompt: "hello" }, []),
    (err) => err.code === "CONTENT_FREE_VIOLATION" && /prompt/.test(err.message),
  );
  assert.throws(
    () => assertContentFree({ nested: { clipboard: "x" } }, []),
    /CONTENT_FREE|clipboard/,
  );
});

test("the default deterministic handler is real and spawns nothing", async () => {
  const artifact = await runBaseline({ environment: fakeEnv(), sampleCount: 2 });
  const phase = artifact.phases.deterministic_handler;
  assert.equal(phase.measured, true);
  assert.equal(phase.n, 2);
  assert.equal(phase.errors, 0);
  assert.ok(phase.p50_ms >= 0);
});

test("sample counts are clamped to a bounded run", async () => {
  let handlerCalls = 0;
  const artifact = await runBaseline({ environment: fakeEnv(), sampleCount: 500, handler: () => { handlerCalls += 1; } });
  assert.equal(artifact.sample_count, 20);
  assert.equal(handlerCalls, 20);
});

test("the human rendering names every phase and carries no content", async () => {
  const artifact = await runBaseline({
    environment: fakeEnv(),
    handler: () => {},
    chat: async (_m, { onDelta }) => { onDelta(CANARY); return { content: CANARY, provider: "ollama" }; },
    secrets: [CANARY],
  });
  const text = renderBaseline(artifact);
  for (const phase of ["deterministic_handler", "first_text", "full_answer", "audio"]) {
    assert.ok(text.includes(phase), `missing ${phase} in the rendering`);
  }
  assert.ok(!text.includes(CANARY));
});
