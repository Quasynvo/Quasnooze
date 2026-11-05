/**
 * Quasnooze Doctor: real answers from injected probes, a verdict a machine can trust, and the
 * regression flag that turns "still broken" into "broke since last time".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STATUS, renderDoctor, renderJson, runDoctor } from "../src/doctor.js";
import { planFor } from "../src/failure.js";

const dir = () => mkdtempSync(join(tmpdir(), "pinch-doctor-"));

function cfgWith(overrides = {}) {
  const { llm, ...rest } = overrides;
  return {
    dataDir: dir(),
    authKey: "abc123",
    autoApprove: false,
    whisperUrl: "",
    llm: {
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaModel: "local:7b",
      openaiBaseUrl: "https://api.example/v1",
      openaiKey: "",
      openaiModel: "cloud-1",
      fallback: "",
      ...(llm || {}),
    },
    telegram: { token: "" },
    discord: { token: "" },
    slack: { token: "" },
    whatsapp: { enabled: false },
    ...rest,
  };
}

/** Probes that answer instantly; every test overrides the ones it cares about. */
function probesWith(overrides = {}) {
  return {
    ollama: async () => ({ ok: true, status: 200, ms: 41, models: ["local:7b"] }),
    openai: async () => ({ configured: false }),
    voice: async () => ({ configured: false }),
    ...overrides,
  };
}

const byId = (report, id) => report.checks.find((row) => row.id === id);
/** Colour is for terminals; assertions read the words. */
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
const plan = (cfg) => planFor({ provider: cfg.llm.provider, model: cfg.llm.ollamaModel }, cfg);

async function doctor(overrides = {}, probeOverrides = {}, extra = {}) {
  const cfg = cfgWith(overrides);
  return runDoctor({
    cfg,
    probes: probesWith(probeOverrides),
    plan: plan(cfg),
    pkg: { version: "1.0.0" },
    nodeVersion: "v22.11.0",
    ...extra,
  });
}

/* ───────────────────────── the verdict ───────────────────────── */

test("a working install is ok, and says what it checked", async () => {
  const report = await doctor({}, {}, { now: 1_700_000_000_000 });

  assert.equal(report.schema_version, 1);
  assert.equal(report.ok, true);
  assert.equal(report.summary.fail, 0);
  assert.equal(report.generated_at, 1_700_000_000_000);
  assert.equal(report.version, "1.0.0");
  for (const id of ["runtime", "security", "data", "brain", "provider.ollama", "provider.openai", "routing", "voice", "channels"]) {
    assert.ok(byId(report, id), `missing check ${id}`);
  }
});

test("an unreachable Ollama is a failure with the fix in the hint", async () => {
  const report = await doctor({}, { ollama: async () => ({ ok: false, status: 0, ms: 2500, failure: "connect ECONNREFUSED" }) });

  const row = byId(report, "provider.ollama");
  assert.equal(row.status, STATUS.FAIL);
  assert.match(row.detail, /no answer from http:\/\/127\.0\.0\.1:11434/);
  assert.match(row.hint, /ollama serve/);
  assert.equal(report.ok, false);
});

test("a reachable Ollama without the selected model is a warning, not a pass", async () => {
  const report = await doctor({}, { ollama: async () => ({ ok: true, status: 200, ms: 12, models: ["other:1b"] }) });

  const row = byId(report, "provider.ollama");
  assert.equal(row.status, STATUS.WARN);
  assert.equal(row.code, "MODEL_MISSING");
  assert.match(row.detail, /local:7b is not one of them/);
  assert.match(row.hint, /ollama pull local:7b/);
});

test("the provider line reports the status code and the latency it measured", async () => {
  const report = await doctor();
  assert.match(byId(report, "provider.ollama").detail, /HTTP 200 in 41ms · 1 model\(s\) · local:7b present/);
});

test("a cloud endpoint that rejects the key is named as an auth failure", async () => {
  const report = await doctor({}, {
    openai: async () => ({
      ok: false,
      status: 401,
      ms: 88,
      configured: true,
      error: Object.assign(new Error("HTTP 401"), { code: "NEED_AUTH", hint: "The provider rejected the credential." }),
    }),
  });

  const row = byId(report, "provider.openai");
  assert.equal(row.status, STATUS.FAIL);
  assert.equal(row.code, "NEED_AUTH");
  assert.match(row.detail, /HTTP 401 in 88ms/);
});

test("a cloud endpoint with no key configured is skipped, not failed", async () => {
  const report = await doctor();
  assert.equal(byId(report, "provider.openai").status, STATUS.SKIP);
});

/* ─────────────────────── routing resilience ─────────────────────── */

test("a single-provider install is told plainly that one outage is one outage", async () => {
  const report = await doctor();

  const row = byId(report, "routing");
  assert.equal(row.status, STATUS.WARN);
  assert.equal(row.code, "SINGLE_PROVIDER");
  assert.match(row.detail, /single provider \(ollama\)/);
  assert.match(row.hint, /LLM_FALLBACK=openai/);
  assert.equal(report.routing.resilient, false);
  assert.deepEqual(report.routing.plan.map((hop) => hop.provider), ["ollama"]);
});

test("an opted-in fallback turns the routing check green and shows the chain", async () => {
  const report = await doctor({ llm: { fallback: "openai", openaiKey: "sk-test" } }, {
    openai: async () => ({ ok: true, status: 200, ms: 120, configured: true, models: ["cloud-1"] }),
  });

  const row = byId(report, "routing");
  assert.equal(row.status, STATUS.OK);
  assert.match(row.detail, /ollama → openai/);
  assert.equal(report.routing.resilient, true);
});

/* ───────────────────────── regressions ───────────────────────── */

test("a check that used to pass and now fails is called a regression", async () => {
  const cfg = cfgWith();
  const healthy = await runDoctor({ cfg, probes: probesWith(), plan: plan(cfg), nodeVersion: "v22.11.0" });
  assert.equal(byId(healthy, "provider.ollama").status, STATUS.OK);

  const broken = await runDoctor({
    cfg,
    probes: probesWith({ ollama: async () => ({ ok: false, status: 0, ms: 2500, failure: "connect ECONNREFUSED" }) }),
    plan: plan(cfg),
    nodeVersion: "v22.11.0",
  });

  assert.equal(byId(broken, "provider.ollama").regressed, true);
  const summary = byId(broken, "regressions");
  assert.equal(summary.status, STATUS.WARN);
  assert.match(summary.detail, /provider\.ollama/);

  assert.ok(existsSync(join(cfg.dataDir, "doctor-state.json")), "the run is remembered");
  const state = JSON.parse(readFileSync(join(cfg.dataDir, "doctor-state.json"), "utf8"));
  assert.equal(state.checks["provider.ollama"].status, STATUS.FAIL);
});

test("a failure that was already failing is not dressed up as a regression", async () => {
  const cfg = cfgWith();
  const down = async () => ({ ok: false, status: 0, ms: 10, failure: "connect ECONNREFUSED" });
  await runDoctor({ cfg, probes: probesWith({ ollama: down }), plan: plan(cfg), nodeVersion: "v22.11.0" });
  const again = await runDoctor({ cfg, probes: probesWith({ ollama: down }), plan: plan(cfg), nodeVersion: "v22.11.0" });

  assert.equal(byId(again, "provider.ollama").regressed, false);
  assert.equal(byId(again, "regressions"), undefined);
});

/* ──────────────────────── output for machines ──────────────────────── */

test("--json is one object with stable keys, safe to branch on", async () => {
  const report = await doctor();
  const parsed = JSON.parse(renderJson(report));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.schema_version, 1);
  assert.equal(typeof parsed.generated_at, "number");
  assert.ok(parsed.summary && typeof parsed.summary.ok === "number");
  for (const row of parsed.checks) {
    assert.equal(typeof row.id, "string");
    assert.ok(Object.values(STATUS).includes(row.status));
    assert.equal(typeof row.detail, "string");
  }
});

test("the network can be left alone entirely", async () => {
  let called = 0;
  const report = await runDoctor({
    cfg: cfgWith(),
    probes: { ollama: async () => { called++; }, openai: async () => { called++; }, voice: async () => { called++; } },
    plan: plan(cfgWith()),
    network: false,
    nodeVersion: "v22.11.0",
  });

  assert.equal(called, 0, "an offline doctor must not reach out");
  assert.equal(byId(report, "provider.ollama").status, STATUS.SKIP);
  assert.equal(byId(report, "provider.openai").status, STATUS.SKIP);
});

test("the human report names every check and ends with a verdict", async () => {
  const report = await doctor();
  const text = plain(renderDoctor(report));

  assert.match(text, /Quasnooze Doctor/);
  assert.match(text, /ollama\/local:7b/);
  for (const row of report.checks) assert.ok(text.includes(row.id), `missing ${row.id} in the human output`);
  assert.match(text, /verdict: healthy/);
  assert.match(text, /5 ok · ▲ 1 warn · ✖ 0 fail · 3 skipped/);
});

test("speech accuracy is printed as a corpus size with its caveat, never as a bare accuracy", async () => {
  const report = await doctor();
  // A text fixture scored through the router is not evidence about a microphone.
  assert.doesNotMatch(plain(renderDoctor(report)), /speech accuracy/, "speech is only printed when the caller measured it");
  report.speech = {
    version: 1,
    utterances: 48,
    conditions: { clean: 14, accented: 12 },
    headline: { reported: true, wer: 0.0974, commandAccuracy: 0.7708, samples: 48 },
    misses: 11,
    baseline: "current",
  };
  const text = plain(renderDoctor(report));
  assert.match(text, /speech accuracy {2}corpus v1 n=48 \(clean 14 · accented 12\)/);
  assert.match(text, /wer 9\.7% · commands 77\.1% \(n=48\)/);
  assert.match(text, /synthetic hypotheses, no microphone/);
  assert.match(text, /11 named command misses; baseline current/);

  // A withheld headline prints the reason, not a number that does not exist.
  report.speech.headline = { reported: false, reason: "withheld: accented below the 8-sample minimum" };
  assert.match(plain(renderDoctor(report)), /withheld: accented below the 8-sample minimum/);
});

test("an unhealthy report is rendered as needing attention, not as healthy", async () => {
  const report = await doctor({}, { ollama: async () => ({ ok: false, status: 0, ms: 5, failure: "connect ECONNREFUSED" }) });
  assert.match(plain(renderDoctor(report)), /verdict: needs attention/);
});

/* ───────────────────── security posture checks ───────────────────── */

test("an empty access key and auto-approval are both reported", async () => {
  const report = await doctor({ authKey: "", autoApprove: true });
  const row = byId(report, "security");
  assert.equal(row.status, STATUS.WARN);
  assert.match(row.detail, /no access key/);
  assert.match(row.detail, /auto-approved/);
  assert.match(row.hint, /PINCH_AUTO_APPROVE/);
});

test("a world-readable data directory is a warning with the chmod in it", async () => {
  const { chmodSync } = await import("node:fs");
  const cfg = cfgWith();
  chmodSync(cfg.dataDir, 0o755);
  const report = await runDoctor({ cfg, probes: probesWith(), plan: plan(cfg), nodeVersion: "v22.11.0" });

  const row = byId(report, "data");
  assert.equal(row.status, STATUS.WARN);
  assert.match(row.hint, /chmod 700/);
});

test("an old Node is a failure, not a warning", async () => {
  const report = await doctor({}, {}, { nodeVersion: "v18.20.0", pkg: { version: "1.0.0", engines: { node: ">=22" } } });
  const row = byId(report, "runtime");
  assert.equal(row.status, STATUS.FAIL);
  assert.match(row.detail, /older than the supported >=22/);
});
