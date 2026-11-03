/**
 * baseline.js — a reproducible, content-free latency baseline.
 *
 * "It feels slow" is not a measurement, and a timing artifact that contains what the user
 * asked would be a second copy of their conversations. This module produces the middle
 * ground: a versioned JSON artifact of *phase timings only*, taken from fixed synthetic
 * scenarios, with enough environment recorded (hardware class, OS, model digest, settings)
 * that two artifacts can be compared without guessing what changed.
 *
 * The phases are separated on purpose, because they have different owners:
 *
 *   deterministic_handler  in-process classification of a fixed read-only command. No
 *                          process is spawned and no model is consulted — this is the
 *                          orchestration floor everything else sits on.
 *   first_text             synthetic prompt → first streamed delta. Inference warm-up lives here.
 *   full_answer            synthetic prompt → complete reply.
 *   audio                  only when a caller passes BOTH explicit consent and an audio
 *                          probe it owns. This module never opens a microphone; the CLI
 *                          provides no probe at all.
 *
 * Content-free is enforced, not promised:
 *   • the synthetic prompt is a constant that is sent to the model but never written out;
 *   • model output is timed and discarded — not stored, not even as a preview;
 *   • failures are recorded as stable codes from src/failure.js, never as error messages
 *     (a provider's error text can echo a key or a URL);
 *   • environment is assembled field-by-field from the config, never by spreading it
 *     (the config object carries every channel token);
 *   • before anything is returned, `assertContentFree` scans the serialized artifact for
 *     the caller's configured secrets and refuses to emit it if one appears.
 */
import { cpus, totalmem, platform as osPlatform, release as osRelease, arch as osArch } from "node:os";
import { classify } from "./failure.js";
import { classifyCommand } from "./risk.js";

export const BASELINE_SCHEMA_VERSION = 1;

/** Fixed synthetic input. Sent to the provider, never recorded in the artifact. */
const SYNTHETIC_PROMPT = "Reply with exactly: ready";
const SYNTHETIC_MAX_TOKENS = 16;

const round = (n) => (Number.isFinite(n) ? Number(Number(n).toFixed(2)) : null);

/** Nearest-rank percentile: the value at rank ceil(p/100 · n) in the sorted samples. */
export function percentile(sortedMs, p) {
  if (!sortedMs.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sortedMs.length));
  return round(sortedMs[Math.min(sortedMs.length - 1, rank - 1)]);
}

/** Summarise a list of millisecond samples. Non-finite/negative values are not facts. */
export function summarizeSamples(samplesMs = [], errorCodes = []) {
  const clean = samplesMs.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  return {
    n: clean.length,
    errors: errorCodes.length,
    p50_ms: percentile(clean, 50),
    p95_ms: percentile(clean, 95),
    min_ms: clean.length ? round(clean[0]) : null,
    max_ms: clean.length ? round(clean[clean.length - 1]) : null,
  };
}

/**
 * One measured phase. `cold_ms` is the first successful sample (model/process warm-up is
 * real and hiding it in a p50 would flatter every later comparison); `warm` summarises the rest.
 */
function phaseResult(samplesMs, errorCodes) {
  const [first, ...rest] = samplesMs;
  return {
    measured: true,
    ...summarizeSamples(samplesMs, errorCodes),
    error_codes: [...errorCodes],
    cold_ms: samplesMs.length ? round(first) : null,
    warm: summarizeSamples(rest, []),
    samples_ms: samplesMs.map(round),
  };
}

function notMeasured(reason_code, reason) {
  return {
    measured: false,
    reason_code,
    reason,
    n: 0,
    errors: 0,
    error_codes: [],
    p50_ms: null,
    p95_ms: null,
    min_ms: null,
    max_ms: null,
    cold_ms: null,
    warm: summarizeSamples([]),
    samples_ms: [],
  };
}

/**
 * The environment half of the artifact, picked field-by-field.
 *
 * What cannot be measured dependency-free — GPU model, driver version — is recorded as
 * an explicit null. An absent key looks like an oversight; a null is a statement that
 * this run does not know, which is the honest thing to compare against later.
 */
export function collectEnvironment({ cfg = {}, modelInfo = null, nodeVersion = process.version, osApi = null } = {}) {
  const os = osApi || { cpus, totalmem, platform: osPlatform, release: osRelease, arch: osArch };
  const cpuList = (() => { try { return os.cpus() || []; } catch { return []; } })();
  const provider = cfg?.llm?.provider || null;
  const model = provider === "openai" ? cfg?.llm?.openaiModel || null
    : provider === "mock" ? "mock"
      : cfg?.llm?.ollamaModel || null;
  return {
    os: { platform: os.platform(), release: os.release(), arch: os.arch() },
    cpu: { model: cpuList[0]?.model?.trim() || null, cores: cpuList.length || null },
    memory_gb: round(os.totalmem() / 2 ** 30),
    gpu: null,
    driver: null,
    node: nodeVersion,
    provider,
    model,
    model_digest: modelInfo?.digest || null,
    model_quantization: modelInfo?.quantization || null,
    model_parameter_size: modelInfo?.parameter_size || null,
    model_family: modelInfo?.family || null,
    settings: {
      num_ctx: Number.isFinite(cfg?.numCtx) ? cfg.numCtx : null,
      num_predict: Number.isFinite(cfg?.numPredict) ? cfg.numPredict : null,
      synthetic_max_tokens: SYNTHETIC_MAX_TOKENS,
      // Temperature is owned by the provider call in src/brain.js, not by this run;
      // recording a number here that this code did not set would be inventing a setting.
      temperature: null,
    },
  };
}

/** Configured secret values, for the content-free scan. Values only — never emitted. */
export function configuredSecrets(cfg = {}) {
  return [
    cfg?.authKey,
    cfg?.llm?.openaiKey,
    cfg?.telegram?.token,
    cfg?.discord?.token,
    cfg?.slack?.token,
  ].filter((v) => typeof v === "string" && v.length >= 4);
}

/** Keys whose presence in an artifact would mean content leaked into a timing file. */
const FORBIDDEN_KEYS = new Set([
  "prompt", "response", "content", "completion", "transcript", "clipboard",
  "secret", "password", "api_key", "apikey", "authkey", "openaikey", "token",
]);

/**
 * Fail closed before an artifact leaves this module: no configured secret may appear in
 * the serialized form, and no content-shaped key may appear at any depth.
 * The thrown error names the rule, never the value that broke it.
 */
export function assertContentFree(artifact, secrets = []) {
  const json = JSON.stringify(artifact);
  for (const secret of secrets) {
    if (secret && json.includes(secret)) {
      throw Object.assign(new Error("baseline artifact refused: a configured secret value would have been recorded"), { code: "CONTENT_FREE_VIOLATION" });
    }
  }
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
        throw Object.assign(new Error(`baseline artifact refused: forbidden content key "${key}"`), { code: "CONTENT_FREE_VIOLATION" });
      }
      walk(child);
    }
  };
  walk(artifact);
  return artifact;
}

/** The default deterministic handler: classification only. Nothing is executed. */
function defaultHandler() {
  return classifyCommand("git status", { workspaceRoots: [process.cwd()] });
}

/**
 * Run the baseline.
 *
 * @param chat         async (messages, {onDelta, maxTokens}) → {content, provider}.
 *                     Omit it (null) to record the model phases as not measured, with
 *                     `modelSkip` explaining why. Output text is discarded either way.
 * @param handler      the deterministic, model-free handler to time (injectable in tests)
 * @param audioProbe   async () → void, timed only when `consentAudio` is also true.
 *                     Ownership of any microphone stays with whoever passes this in.
 * @param consentAudio explicit consent flag for the audio phase; default false
 * @param sampleCount  measured samples per phase, clamped to 1..20
 * @param warmupCount  unrecorded warm-up model runs; when > 0, measured samples are warm
 * @param clock        {now()} milliseconds source (injectable for deterministic tests)
 * @param environment  from collectEnvironment()
 * @param evidenceKind "mock" | "local-model" | "cloud-model" — mocks are never dressed
 *                     up as hardware measurements
 * @param secrets      values that must never appear in the artifact
 */
export async function runBaseline({
  chat = null,
  handler = defaultHandler,
  audioProbe = null,
  consentAudio = false,
  sampleCount = 3,
  warmupCount = 0,
  clock = { now: () => performance.now() },
  environment = collectEnvironment(),
  evidenceKind = environment?.provider === "mock" ? "mock" : environment?.provider === "openai" ? "cloud-model" : "local-model",
  modelSkip = { reason_code: "MODEL_NOT_PROVIDED", reason: "No chat function was provided to the baseline runner." },
  now = new Date().toISOString(),
  peakRssMb = () => { try { return round(process.resourceUsage().maxrss / 1024); } catch { return null; } },
  secrets = [],
} = {}) {
  const samples = Math.max(1, Math.min(20, Math.floor(sampleCount) || 1));
  const warmups = Math.max(0, Math.min(5, Math.floor(warmupCount) || 0));

  /* ── deterministic handler: the orchestration floor ─────────────────────── */
  const handlerSamples = [];
  const handlerErrors = [];
  for (let i = 0; i < samples; i++) {
    const started = clock.now();
    try {
      await handler();
      handlerSamples.push(clock.now() - started);
    } catch (err) {
      handlerErrors.push(classify(err).code);
    }
  }

  /* ── model phases: first text vs full answer, output discarded ─────────── */
  let firstText;
  let fullAnswer;
  const providersObserved = [];
  if (typeof chat !== "function") {
    firstText = notMeasured(modelSkip.reason_code, modelSkip.reason);
    fullAnswer = notMeasured(modelSkip.reason_code, modelSkip.reason);
  } else {
    const runOnce = async (record) => {
      const started = clock.now();
      let firstAt = null;
      const result = await chat([{ role: "user", content: SYNTHETIC_PROMPT }], {
        maxTokens: SYNTHETIC_MAX_TOKENS,
        onDelta: () => { if (firstAt === null) firstAt = clock.now() - started; },
      });
      if (record) {
        if (typeof result?.provider === "string" && !providersObserved.includes(result.provider)) providersObserved.push(result.provider);
        return { firstMs: firstAt, totalMs: clock.now() - started };
      }
      return null;
    };
    for (let i = 0; i < warmups; i++) { try { await runOnce(false); } catch { /* warm-up failures surface in the measured samples */ } }

    const firstSamples = [];
    const fullSamples = [];
    const modelErrors = [];
    let streamed = false;
    for (let i = 0; i < samples; i++) {
      try {
        const { firstMs, totalMs } = await runOnce(true);
        fullSamples.push(totalMs);
        if (firstMs !== null) { streamed = true; firstSamples.push(firstMs); }
      } catch (err) {
        modelErrors.push(classify(err).code);
      }
    }
    fullAnswer = phaseResult(fullSamples, modelErrors);
    firstText = streamed
      ? phaseResult(firstSamples, modelErrors)
      : notMeasured("NO_STREAMING_DELTAS", "The provider returned without streaming deltas, so first-text latency does not exist for this run.");
  }

  /* ── audio: consent and probe, both, or it is not measured ─────────────── */
  let audio;
  if (consentAudio !== true) {
    audio = notMeasured("CONSENT_REQUIRED", "Audio latency requires explicit consent. This run did not have it and no microphone was opened.");
  } else if (typeof audioProbe !== "function") {
    audio = notMeasured("NO_AUDIO_PROBE", "Consent was given but no audio probe was provided; the diagnostics CLI never opens a microphone itself.");
  } else {
    const audioSamples = [];
    const audioErrors = [];
    for (let i = 0; i < samples; i++) {
      const started = clock.now();
      try { await audioProbe(); audioSamples.push(clock.now() - started); }
      catch (err) { audioErrors.push(classify(err).code); }
    }
    audio = phaseResult(audioSamples, audioErrors);
  }

  const artifact = {
    kind: "quasnooze-latency-baseline",
    schema_version: BASELINE_SCHEMA_VERSION,
    generated_at: now,
    evidence_kind: evidenceKind,
    content_free: true,
    synthetic: true,
    sample_count: samples,
    warmup_count: warmups,
    warm_cold: warmups > 0 ? "warm (after unrecorded warm-up runs)" : "first sample per phase is cold; see cold_ms",
    environment,
    providers_observed: providersObserved,
    peak_rss_mb: peakRssMb(),
    phases: {
      deterministic_handler: phaseResult(handlerSamples, handlerErrors),
      first_text: firstText,
      full_answer: fullAnswer,
      audio,
    },
  };

  return assertContentFree(artifact, secrets);
}

/** Render the human summary lines used by `npm run health -- --baseline`. Content-free by construction. */
export function renderBaseline(artifact) {
  const line = (name, phase) => phase.measured
    ? `  ${name.padEnd(24)} n=${phase.n} errors=${phase.errors} cold=${phase.cold_ms}ms p50=${phase.p50_ms}ms p95=${phase.p95_ms}ms`
    : `  ${name.padEnd(24)} not measured (${phase.reason_code})`;
  return [
    `  baseline (${artifact.evidence_kind}, synthetic, content-free)`,
    line("deterministic_handler", artifact.phases.deterministic_handler),
    line("first_text", artifact.phases.first_text),
    line("full_answer", artifact.phases.full_answer),
    line("audio", artifact.phases.audio),
  ].join("\n");
}
