#!/usr/bin/env node
/**
 * scripts/doctor.js — the machine-readable half of diagnostics.
 *
 *   npm run health              the provider matrix, the turn's routing plan, and the verdict
 *   npm run health -- --json    the same as one JSON object, for scripts and agents
 *   npm run health -- --no-network   skip every request (what is configured, nothing more)
 *   npm run health -- --baseline [--samples N] [--warmup N] [--out FILE]
 *                               also run the synthetic, content-free latency baseline
 *                               (docs/DIAGNOSTICS.md). Model phases run only when readiness
 *                               verified the configured provider; nothing is downloaded,
 *                               no microphone is opened, and no prompt/response text is
 *                               recorded — timings, counts and failure codes only.
 *
 * `pinch doctor` (scripts/setup.js --check) stays as it was: prose for a person setting things up.
 * This one exits non-zero when a check fails, so it can gate a deploy or a CI job.
 */
import { config } from "../src/config.js";
import { planFor } from "../src/failure.js";
import { renderDoctor, renderJson, runDoctor } from "../src/doctor.js";
import { collectEnvironment, configuredSecrets, renderBaseline, runBaseline } from "../src/baseline.js";
import { latencyReport } from "../src/telemetry.js";
import { speechBaseline } from "./evaluate-speech.js";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const network = !args.includes("--no-network");
const baseline = args.includes("--baseline");

const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const samples = Number(valueAfter("--samples")) || 3;
const warmup = Number(valueAfter("--warmup")) || 0;
const out = valueAfter("--out");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  npm run health [-- --json] [-- --no-network] [-- --baseline [-- --samples N] [-- --warmup N] [-- --out FILE]]

  Checks the runtime, the access settings, the data directory, every model provider (with real
  requests and latencies), whether a turn would survive its provider failing, and the derived
  readiness state (ready / missing-model / unreachable-backend / companion-unavailable /
  mic-muted / not-verified) with a next action for each.

  --baseline adds the synthetic content-free latency baseline: deterministic handler,
  first text and full answer timings (p50/p95, cold vs warm, error codes) against the
  already-configured provider. It downloads nothing, opens no microphone, sends no
  conversation anywhere the provider is not already configured to receive turns from,
  and records no prompt or response text. --out writes the artifact as its own JSON
  file (mode 0600). See docs/DIAGNOSTICS.md.

  Exits 1 when any check fails, so it can gate CI.
`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const report = await runDoctor({
  cfg: config,
  pkg,
  plan: planFor(config.llm.provider === "mock" ? { provider: "mock", model: "mock" } : { provider: config.llm.provider, model: config.llm.provider === "openai" ? config.llm.openaiModel : config.llm.ollamaModel }),
  network,
});

// Where the last turns spent their time, from the local telemetry ring. Always
// present, because "no turns recorded yet" is itself the answer to "why is my
// latency table empty" — and it is a null, not a zero.
report.latency = latencyReport();

// Voice accuracy is measured, not asserted (docs/SPEECH-BASELINE-V1.md). This is
// the corpus size and whether the committed baseline still matches this build —
// it scores authored text through the shipped router, so it downloads no model,
// opens no microphone and can run on a locked-down machine.
report.speech = await speechBaseline();

if (baseline) {
  // Model phases only run against a provider the probes actually verified. A missing or
  // unreachable model is recorded as not-measured with the readiness state as the reason —
  // the baseline never triggers a download and never silently tries another backend.
  const textState = report.readiness.surfaces.text.state;
  const measurable = textState === "ready" || textState === "ready-mock";
  let chat = null;
  if (measurable) {
    const { brain } = await import("../src/brain.js");
    chat = (messages, options) => brain.chat(messages, options);
  }

  report.baseline = await runBaseline({
    chat,
    sampleCount: samples,
    warmupCount: warmup,
    environment: collectEnvironment({ cfg: config, modelInfo: report.model_info }),
    modelSkip: {
      reason_code: textState.toUpperCase().replaceAll("-", "_"),
      reason: `Model phases were not run because text readiness is "${textState}". ${report.readiness.surfaces.text.next_action}`,
    },
    secrets: configuredSecrets(config),
  });

  if (out) writeFileSync(out, `${JSON.stringify(report.baseline, null, 2)}\n`, { mode: 0o600 });
}

process.stdout.write(json ? renderJson(report) : `${renderDoctor(report)}${baseline ? `\n${renderBaseline(report.baseline)}` : ""}\n`);
if (out && baseline) console.error(`baseline artifact written to ${out} (content-free timings only)`);
if (!report.ok) process.exitCode = 1;
if (baseline && (report.baseline.phases.full_answer.errors > 0 || report.baseline.phases.deterministic_handler.errors > 0)) process.exitCode = 1;
