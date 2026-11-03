/**
 * Readiness (#85): the doctor's checks become a closed set of states a first-run journey
 * can branch on. Every state carries a next action; nothing is "ready" on the strength of
 * a configured model name, and a mock is never dressed up as a verified local turn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../src/doctor.js";
import { READINESS, deriveReadiness } from "../src/readiness.js";
import { planFor } from "../src/failure.js";

/** A minimal doctor-shaped report; each test overrides the checks it is about. */
function reportWith(checks, { provider = "ollama", model = "local:7b" } = {}) {
  return {
    routing: { provider, plan: [{ provider, model, role: "primary" }] },
    checks: [
      { id: "runtime", status: "ok", detail: "v22", hint: null },
      { id: "data", status: "ok", detail: "writable", hint: null },
      ...checks,
    ],
  };
}

const ollamaOk = { id: "provider.ollama", status: "ok", detail: "HTTP 200 · local:7b present", hint: null };

test("a probed provider with the model installed is ready, with a next action", () => {
  const readiness = deriveReadiness(reportWith([ollamaOk]));
  assert.equal(readiness.state, READINESS.READY);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.surfaces.text.state, READINESS.READY);
  assert.ok(readiness.surfaces.text.next_action.length > 0);
  assert.equal(readiness.surfaces.text.evidence, "provider-probe");
});

test("a reachable backend without the selected model is missing-model, never ready", () => {
  const missing = {
    id: "provider.ollama", status: "warn", code: "MODEL_MISSING",
    detail: "1 model(s), but local:7b is not one of them", hint: "ollama pull local:7b",
  };
  const readiness = deriveReadiness(reportWith([missing]));
  assert.equal(readiness.state, READINESS.MISSING_MODEL);
  assert.equal(readiness.ready, false);
  assert.match(readiness.next_action, /ollama pull local:7b/);
});

test("a backend that does not answer is unreachable-backend with the doctor's hint", () => {
  const down = {
    id: "provider.ollama", status: "fail",
    detail: "no answer from http://127.0.0.1:11434", hint: "Start it with `ollama serve`",
  };
  const readiness = deriveReadiness(reportWith([down]));
  assert.equal(readiness.state, READINESS.UNREACHABLE_BACKEND);
  assert.match(readiness.next_action, /ollama serve/);
});

test("skipped probes (--no-network) are not-verified: a model name is not evidence", () => {
  const skipped = { id: "provider.ollama", status: "skip", detail: "network checks disabled (--no-network)", hint: null };
  const readiness = deriveReadiness(reportWith([skipped]));
  assert.equal(readiness.state, READINESS.NOT_VERIFIED);
  assert.equal(readiness.ready, false);
  assert.match(readiness.next_action, /without --no-network/);
});

test("the mock brain is ready-mock, which is explicitly not ready", () => {
  const readiness = deriveReadiness(reportWith([], { provider: "mock", model: "mock" }));
  assert.equal(readiness.state, READINESS.READY_MOCK);
  assert.equal(readiness.ready, false);
  assert.equal(readiness.surfaces.text.evidence, "mock");
});

test("a failed runtime blocks readiness even when the provider probe passes", () => {
  const report = reportWith([ollamaOk]);
  report.checks[0] = { id: "runtime", status: "fail", detail: "v18", hint: "Upgrade Node" };
  const readiness = deriveReadiness(report);
  assert.equal(readiness.state, READINESS.BLOCKED);
  assert.equal(readiness.surfaces.text.blocked_by, "runtime");
  assert.match(readiness.next_action, /Upgrade Node/);
});

/* ─────────────────────────── the voice surface ─────────────────────────── */

test("without an observable companion, voice is not-verified rather than guessed", () => {
  const readiness = deriveReadiness(reportWith([ollamaOk]));
  assert.equal(readiness.surfaces.voice.state, READINESS.NOT_VERIFIED);
  assert.match(readiness.surfaces.voice.next_action, /npm run desktop/);
});

test("an unavailable companion is its own state, with text unaffected", () => {
  const readiness = deriveReadiness(reportWith([ollamaOk]), {
    companion: { available: false, phase: "not-running", mic: false },
  });
  assert.equal(readiness.state, READINESS.READY, "text turns do not need the companion");
  assert.equal(readiness.surfaces.voice.state, READINESS.COMPANION_UNAVAILABLE);
  assert.match(readiness.surfaces.voice.next_action, /npm run desktop on Windows/);
});

test("an available companion with a muted mic is mic-muted, and diagnostics do not unmute it", () => {
  const readiness = deriveReadiness(reportWith([ollamaOk]), {
    companion: { available: true, phase: "muted", mic: false },
  });
  assert.equal(readiness.surfaces.voice.state, READINESS.MIC_MUTED);
  assert.match(readiness.surfaces.voice.next_action, /starts muted by design/);
  assert.match(readiness.surfaces.voice.next_action, /never unmutes/);
});

test("a live mic cannot make voice ready when the model cannot answer", () => {
  const down = { id: "provider.ollama", status: "fail", detail: "no answer", hint: "ollama serve" };
  const readiness = deriveReadiness(reportWith([down]), {
    companion: { available: true, phase: "listening", mic: true },
  });
  assert.equal(readiness.surfaces.voice.state, READINESS.UNREACHABLE_BACKEND);
});

test("live mic plus a verified model is voice-ready", () => {
  const readiness = deriveReadiness(reportWith([ollamaOk]), {
    companion: { available: true, phase: "listening", mic: true },
  });
  assert.equal(readiness.surfaces.voice.state, READINESS.READY);
  assert.equal(readiness.surfaces.voice.companion_phase, "listening");
});

test("companion speech text and recent commands never enter the readiness output", () => {
  const canary = "canary-speech-text-9f27";
  const readiness = deriveReadiness(reportWith([ollamaOk]), {
    companion: {
      available: true, phase: "muted", mic: false,
      speech: { status: "heard", text: canary, detail: canary },
      recent: [{ command: canary, ok: true, ms: 1 }],
      text: canary,
    },
  });
  assert.ok(!JSON.stringify(readiness).includes(canary), "companion content leaked into readiness");
});

test("every state in the closed set carries a non-empty next action", () => {
  const cases = [
    reportWith([ollamaOk]),
    reportWith([{ id: "provider.ollama", status: "fail", detail: "down", hint: null }]),
    reportWith([{ id: "provider.ollama", status: "warn", code: "MODEL_MISSING", detail: "not one of them", hint: null }]),
    reportWith([{ id: "provider.ollama", status: "skip", detail: "network checks disabled (--no-network)", hint: null }]),
    reportWith([], { provider: "mock", model: "mock" }),
  ];
  const companions = [null, { available: false, mic: false, phase: "not-running" }, { available: true, mic: false, phase: "muted" }];
  for (const report of cases) {
    for (const companion of companions) {
      const readiness = deriveReadiness(report, { companion });
      for (const surface of [readiness.surfaces.text, readiness.surfaces.voice]) {
        assert.ok(Object.values(READINESS).includes(surface.state), `unknown state ${surface.state}`);
        assert.ok(typeof surface.next_action === "string" && surface.next_action.length > 0, `${surface.state} has no next action`);
      }
    }
  }
});

/* ─────────────────── integration with the real doctor ─────────────────── */

function cfgWith(llm = {}) {
  return {
    dataDir: mkdtempSync(join(tmpdir(), "quasnooze-readiness-")),
    authKey: "abc123",
    autoApprove: false,
    whisperUrl: "",
    llm: {
      provider: "ollama", ollamaUrl: "http://127.0.0.1:11434", ollamaModel: "local:7b",
      openaiBaseUrl: "https://api.example/v1", openaiKey: "", openaiModel: "cloud-1", fallback: "",
      ...llm,
    },
    telegram: { token: "" }, discord: { token: "" }, slack: { token: "" }, whatsapp: { enabled: false },
  };
}

function probesWith(overrides = {}) {
  return {
    ollama: async () => ({
      ok: true, status: 200, ms: 5, models: ["local:7b"],
      modelDetails: [{ name: "local:7b", digest: "sha256:abc", quantization: "Q4_K_M", parameter_size: "7B", family: "llama" }],
    }),
    openai: async () => ({ configured: false }),
    voice: async () => ({ configured: false }),
    ...overrides,
  };
}

async function doctor({ cfg = cfgWith(), probes = probesWith(), companion = null, network = true } = {}) {
  return runDoctor({
    cfg, probes, companion, network,
    plan: planFor({ provider: cfg.llm.provider, model: cfg.llm.ollamaModel }, cfg),
    nodeVersion: "v22.11.0",
  });
}

test("runDoctor embeds readiness and the selected model's digest", async () => {
  const report = await doctor();
  assert.equal(report.readiness.state, READINESS.READY);
  assert.equal(report.readiness.surfaces.voice.state, READINESS.NOT_VERIFIED);
  assert.equal(report.model_info.digest, "sha256:abc");
  assert.equal(report.model_info.quantization, "Q4_K_M");
});

test("runDoctor readiness distinguishes missing model from unreachable backend", async () => {
  const missing = await doctor({ probes: probesWith({ ollama: async () => ({ ok: true, status: 200, ms: 5, models: ["other:1b"] }) }) });
  assert.equal(missing.readiness.state, READINESS.MISSING_MODEL);
  assert.match(missing.readiness.next_action, /ollama pull local:7b/);

  const down = await doctor({ probes: probesWith({ ollama: async () => ({ ok: false, status: 0, ms: 5, failure: "connect ECONNREFUSED" }) }) });
  assert.equal(down.readiness.state, READINESS.UNREACHABLE_BACKEND);
});

test("runDoctor with the network off reports not-verified, and a passed companion reports mic-muted", async () => {
  const offline = await doctor({ network: false });
  assert.equal(offline.readiness.state, READINESS.NOT_VERIFIED);

  const muted = await doctor({ companion: { available: true, phase: "muted", mic: false } });
  assert.equal(muted.readiness.surfaces.voice.state, READINESS.MIC_MUTED);

  const absent = await doctor({ companion: { available: false, phase: "not-running", mic: false } });
  assert.equal(absent.readiness.surfaces.voice.state, READINESS.COMPANION_UNAVAILABLE);
});
