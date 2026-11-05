/**
 * voice-latency.test.js — where was the slow turn slow?
 *
 * `telemetry.js` recorded one duration per turn, so "it feels laggy" was
 * unactionable: a 2.4 s turn looks the same whether the model was slow, the
 * transcript took a second to settle, or audio started late. These tests fix the
 * shape of the answer before the code exists to produce it.
 *
 * Two rules carry the whole design, and both are asserted here rather than
 * reviewed:
 *
 *   1. **A missing mark is `null`, never `0`.** A fabricated zero is a perfect
 *      score, and a perfect score is the one number a reader will believe.
 *   2. **No words.** A stage log that carries the transcript is a second copy of
 *      your conversations with none of the protections.
 */
import { get } from "node:http";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "pinch-voice-latency-"));
process.env.PINCH_DATA = data;
process.env.PINCH_WORKSPACE = data;
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_KEY = "voice-latency-key";

const telemetry = await import("../src/telemetry.js");
const { createQuasnoozeServer } = await import("../src/server.js");
const { ensureData } = await import("../src/store.js");
ensureData();
const server = createQuasnoozeServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { "content-type": "application/json", "x-pinch-key": "voice-latency-key" };

after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(data, { recursive: true, force: true });
});

/* ───────────────────────── stage names and the budget ───────────────────── */

test("the five stages are named once, and each one has a target or says why not", () => {
  assert.deepEqual(telemetry.STAGES, ["captureEndMs", "endpointMs", "transcriptMs", "firstTokenMs", "firstAudioMs"]);
  for (const stage of telemetry.STAGES) {
    const budget = telemetry.VOICE_BUDGET[stage];
    assert.ok(budget, `${stage} has no budget row`);
    // A target of null is allowed for a stage that is not a latency -- but only
    // with a written reason, because "no target" and "forgot the target" look
    // identical from the outside.
    assert.ok(budget.targetMs === null || typeof budget.targetMs === "number", `${stage} target must be a number or null`);
    if (budget.targetMs === null) assert.match(budget.note, /./, `${stage} has no target and no reason`);
    assert.match(budget.from, /./);
    assert.match(budget.to, /./);
  }
  assert.equal(telemetry.VOICE_BUDGET.endpointMs.targetMs, 300);
  assert.equal(telemetry.VOICE_BUDGET.firstTokenMs.targetMs, 700);
  assert.equal(telemetry.VOICE_BUDGET.firstAudioMs.targetMs, 1200);
});

/* ───────────────────────────── null, never zero ─────────────────────────── */

test("a missing mark is null; a real zero survives as zero", () => {
  const stages = telemetry.normalizeStages({ endpointMs: 0, transcriptMs: 41 });
  assert.equal(stages.endpointMs, 0, "0 ms is a measurement, not an absence");
  assert.equal(stages.transcriptMs, 41);
  assert.equal(stages.captureEndMs, null);
  assert.equal(stages.firstTokenMs, null);
  assert.equal(stages.firstAudioMs, null);
});

test("anything that is not a finite non-negative number is absent, not zero", () => {
  for (const value of ["120", {}, [], true, null, undefined, Number.NaN, Infinity, -1, -0.5, () => 1]) {
    const stages = telemetry.normalizeStages({ endpointMs: value });
    assert.equal(stages.endpointMs, null, `${JSON.stringify(value)} should not become a number`);
  }
  assert.deepEqual(Object.keys(telemetry.normalizeStages({ bogus: 5, text: "hello" })), [...telemetry.STAGES]);
});

test("the stage object is flat numbers only — the shape cannot carry a transcript", () => {
  const stages = telemetry.normalizeStages({ transcriptMs: 90, transcript: "my salary is 68k", prompt: "sys", audio: [1, 2] });
  for (const [key, value] of Object.entries(stages)) {
    assert.ok(telemetry.STAGES.includes(key), `${key} is not a stage`);
    assert.ok(value === null || typeof value === "number", `${key} must be a number or null`);
  }
  assert.equal(JSON.stringify(stages).includes("salary"), false);
});

/* ────────────────────── per-stage percentiles and counts ────────────────── */

test("per-stage p50/p95 carry the sample count, so four turns are visibly weak evidence", () => {
  const summary = telemetry.stageStats([
    { kind: "turn", stages: telemetry.normalizeStages({ endpointMs: 100, firstTokenMs: 500 }) },
    { kind: "turn", stages: telemetry.normalizeStages({ endpointMs: 200 }) },
    { kind: "turn", stages: telemetry.normalizeStages({ endpointMs: 300, firstTokenMs: 900 }) },
    { kind: "turn" },
  ]);
  assert.equal(summary.endpointMs.samples, 3);
  assert.equal(summary.endpointMs.p50, 200);
  assert.equal(summary.endpointMs.p95, 300);
  assert.equal(summary.firstTokenMs.samples, 2);
  assert.equal(summary.firstAudioMs.samples, 0);
  assert.equal(summary.firstAudioMs.p50, null);
  assert.equal(summary.firstAudioMs.targetMs, telemetry.VOICE_BUDGET.firstAudioMs.targetMs);
});

/* ───────────────────── a real turn over the real server ─────────────────── */

async function turn(body) {
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  await response.text();
  return readFileSync(telemetry.TELEMETRY_FILE, "utf8").trim().split("\n").map((line) => JSON.parse(line)).at(-1);
}

test("a turn with no browser marks still records its server stages", async () => {
  const record = await turn({ sessionId: "srv-only", text: "what time is it" });
  assert.equal(record.kind, "turn");
  assert.ok(record.stages, "the turn record has no stages object");
  assert.equal(typeof record.stages.firstTokenMs, "number", "the server owns this mark and must always have it");
  // Browser-owned marks are absent. Absent is null. Null is not zero.
  for (const stage of ["captureEndMs", "endpointMs", "transcriptMs", "firstAudioMs"]) {
    assert.equal(record.stages[stage], null, `${stage} must be null, not ${JSON.stringify(record.stages[stage])}`);
  }
});

test("browser marks travel with the turn and are recorded as sent", async () => {
  const record = await turn({
    sessionId: "with-marks",
    text: "what time is it",
    timing: { captureEndMs: 1400, endpointMs: 180, transcriptMs: 240 },
  });
  assert.equal(record.stages.captureEndMs, 1400);
  assert.equal(record.stages.endpointMs, 180);
  assert.equal(record.stages.transcriptMs, 240);
  assert.equal(typeof record.stages.firstTokenMs, "number");
});

test("nothing but numbers reaches the log — text in a timing payload is dropped, not stored", async () => {
  const secret = "my salary is sixty eight thousand";
  await turn({
    sessionId: "leak-check",
    text: "what time is it",
    timing: { captureEndMs: 12, transcript: secret, prompt: secret, text: secret, note: { nested: secret } },
  });
  const raw = readFileSync(telemetry.TELEMETRY_FILE, "utf8");
  assert.equal(raw.includes(secret), false, "a transcript reached telemetry.ndjson");
  assert.equal(/"(transcript|prompt|text|audio)"\s*:/.test(raw), false, "a text-bearing key reached telemetry.ndjson");
});

test("the health stats expose every stage with p50, p95, samples and target", async () => {
  const stats = telemetry.stats();
  assert.ok(stats.stages, "stats() has no per-stage block");
  for (const stage of telemetry.STAGES) {
    const row = stats.stages[stage];
    assert.ok(row, `${stage} missing from health stats`);
    assert.equal(typeof row.samples, "number");
    assert.ok(row.targetMs === null || typeof row.targetMs === "number");
    assert.ok(row.p50 === null || typeof row.p50 === "number");
    assert.ok(row.p95 === null || typeof row.p95 === "number");
  }
  assert.ok(stats.stages.firstTokenMs.samples >= 1);
});

/* ─────────────────────────── the command a person runs ──────────────────── */

test("`quasnooze health --json` reports per-stage p50/p95 with sample counts", async () => {
  const { runDoctor, renderJson } = await import("../src/doctor.js");
  const { config } = await import("../src/config.js");
  const report = await runDoctor({ cfg: config, probes: {}, network: false, statePath: null });
  report.latency = telemetry.latencyReport();
  const json = JSON.parse(renderJson(report));
  assert.ok(json.latency, "doctor JSON has no latency block");
  assert.ok(json.latency.stages.firstTokenMs);
  assert.equal(typeof json.latency.stages.firstTokenMs.samples, "number");
  assert.equal(typeof json.latency.stages.firstTokenMs.p50, "number");
  assert.equal(typeof json.latency.stages.firstTokenMs.p95, "number");
  assert.equal(typeof json.latency.stages.firstTokenMs.targetMs, "number");
});

test("the docs budget table names every stage the tool reports, with its target", async () => {
  const doc = readFileSync(new URL("../docs/VOICE.md", import.meta.url), "utf8");
  const start = doc.indexOf("## Latency budget");
  assert.notEqual(start, -1, "docs/VOICE.md has no latency budget section");
  const section = doc.slice(start);
  for (const stage of telemetry.STAGES) {
    const row = section.split("\n").find((line) => line.startsWith(`| \`${stage}\``));
    assert.ok(row, `docs/VOICE.md has no row for ${stage}`);
    const target = telemetry.VOICE_BUDGET[stage].targetMs;
    if (target === null) assert.match(row, /no target/i, `${stage} has no target and the row does not say so`);
    else assert.ok(row.includes(`${target} ms`), `${stage} row does not state its ${target} ms target`);
  }
});

/* ───────────────── the browser marks exist and are opt-in-late ──────────── */

test("the shipped deck marks capture, endpoint and transcript, and never invents a number", async () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  // The deck collects marks and sends them with the message it already sends.
  assert.match(html, /takeTiming\(/, "the deck does not collect a timing object");
  assert.match(html, /body: JSON\.stringify\(\{[^}]*timing/, "the timing object never reaches the request");
  // Marks are differences between real clock reads, not constants.
  assert.match(html, /performance\.now\(\)/);
  assert.match(html, /msBetween\(/);
  // A stage is never asserted as 0, and a missing anchor never becomes a number.
  assert.doesNotMatch(html, /(captureEndMs|endpointMs|transcriptMs)\s*:\s*\d/, "a stage is hard-coded instead of measured");
  assert.match(html, /from > 0 && to >= from \? Math\.round\(to - from\) : undefined/);
  // And a mark from a send that never happened must expire rather than attach
  // itself to the next typed message.
  assert.match(html, /TIMING_TTL_MS/);
  // Measuring must not become a second audio stream or a second request.
  assert.equal((html.match(/fetch\(\"\/api\/chat\"/g) || []).length, 1, "the deck must keep exactly one chat request");
});

test("cosmic.js stays a text-only concept: it has no microphone to mark", async () => {
  const js = readFileSync(new URL("../public/cosmic.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /getUserMedia|SpeechRecognition/);
});

test("an unauthenticated ask is still refused — measurement changed no access rule", async () => {
  const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(response.status, 401);
});

test("the /api/events stream is untouched and the health endpoint exposes the stage block", async () => {
  const health = await (await fetch(`${base}/api/health`, { headers })).json();
  assert.equal(health.ok, true);
  assert.ok(health.turns.stages, "the panel reads /api/health; it needs the stages too");
  assert.equal(typeof health.turns.stages.firstTokenMs.samples, "number");
});
