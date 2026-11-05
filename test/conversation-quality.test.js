/**
 * conversation-quality.test.js — the bench has to be able to fail.
 *
 * A quality number nobody can reproduce is a press release. So this test does
 * three things the report cannot do for itself:
 *
 *   1. one measured run per process, shared by every assertion (the retrieval
 *      evaluation sets the same precedent);
 *   2. it proves the corpus is what it claims — 60 labelled turns, six classes,
 *      every turn carrying an expectation a machine can check;
 *   3. it proves the checker *discriminates*. A answer-shaped string that cites a
 *      source it was never given, or claims a write that never happened, must be
 *      rejected — otherwise the 100% score above is a tautology.
 *
 * The live tier runs the real agent loop against the in-process mock brain, so
 * these tests assert pipeline behaviour, never model intelligence. That
 * distinction is written into the report too, in `report.recording.model`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  scoreTurn,
  selfCheck,
  evaluateConversation,
  renderConversationEvaluation,
  CORPUS_VERSION,
  BUDGET_MS,
} from "../scripts/evaluate-conversation.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// One measured run per test process.
const report = await evaluateConversation();
const corpus = JSON.parse(await readFile(new URL("../test-fixtures/conversation/v1/corpus.json", import.meta.url), "utf8"));

test("the corpus is versioned, synthetic, and carries sixty labelled turns", () => {
  assert.equal(corpus.version, CORPUS_VERSION);
  assert.equal(corpus.synthetic, true);
  assert.equal(report.corpusVersion, CORPUS_VERSION);
  assert.equal(report.synthetic, true);
  assert.equal(corpus.turns.length, 60);
  assert.equal(new Set(corpus.turns.map((t) => t.id)).size, 60, "turn ids must be unique");
  assert.deepEqual(report.counts, { turns: 60, live: 16, recorded: 44, deterministicGated: 60, judgedRecorded: 0 });
});

test("every class the report claims exists, with enough turns to mean something", () => {
  const classes = ["factual-citation", "document-unanswerable", "multi-turn-followup", "tool-needed", "refusal", "social"];
  assert.deepEqual(Object.keys(report.byClass).sort(), [...classes].sort());
  for (const name of classes) {
    assert.ok(report.byClass[name].turns >= 6, `${name} has only ${report.byClass[name].turns} turn(s)`);
    assert.ok(corpus.classes[name], `${name} is in the corpus but not described`);
  }
});

test("no turn is scored on vibes: each one declares a checkable expectation", () => {
  const allowed = new Set([
    "citationRequired", "forbidCitations", "mustAbstain", "mustMatch", "mustNotMatch",
    "requireTool", "requireDenied", "forbidTool", "note",
  ]);
  for (const turn of corpus.turns) {
    const keys = Object.keys(turn.expect);
    assert.ok(keys.length > 1 || keys[0] !== "note", `${turn.id} declares nothing but a note`);
    for (const key of keys) assert.ok(allowed.has(key), `${turn.id} uses unknown expectation ${key}`);
    if (turn.tier === "recorded") assert.equal(typeof turn.recorded.answer, "string");
    else assert.equal(turn.recorded, undefined, `${turn.id} is live and must not ship a canned answer`);
  }
});

test("the live tier runs the real loop: tools fire, the screen blocks, the fast path answers", () => {
  const byId = new Map(report.turns.map((t) => [t.id, t]));
  // A tool result must reach the answer, or the bench is measuring nothing.
  for (const id of ["tool-calc-mock", "tool-calc-fastpath", "tool-clock", "tool-remind", "tool-remember", "tool-list-dir"]) {
    assert.ok(byId.get(id).pass, `${id} did not run its tool through the real loop`);
  }
  // A catastrophic command is refused at the screen, before any approval could exist.
  assert.ok(byId.get("refuse-rm-root").pass);
  assert.ok(byId.get("refuse-shutdown").pass);
});

test("a clean corpus scores itself, with no partial credit and no failures", () => {
  assert.equal(report.passed, 60);
  assert.equal(report.score, 1);
  assert.deepEqual(report.failures, []);
  for (const [name, row] of Object.entries(report.byClass)) {
    assert.equal(row.score, 1, `${name} regressed`);
    assert.deepEqual(row.failing, []);
  }
});

test("the same corpus scores the same twice — this is a regression baseline, not a lottery", async () => {
  const again = await evaluateConversation();
  assert.equal(again.score, report.score);
  assert.deepEqual(again.turns, report.turns);
  assert.deepEqual(again.byClass, report.byClass);
});

test("the provenance is stated, so no number here can be mistaken for a model result", () => {
  assert.equal(report.recording.model, "hand-authored-synthetic");
  assert.match(report.recording.note, /not a measurement/i);
  assert.equal(report.model, "mock", "the live tier must not reach a real provider");
  assert.equal(report.counts.judgedRecorded, 0, "v1 records no judge scores");
});

test("the checker catches every plausible-looking answer it is supposed to reject", async () => {
  const check = await selfCheck();
  assert.equal(check.results.length, 8);
  assert.ok(check.ok, `missed: ${check.results.filter((r) => !r.caught).map((r) => r.id).join(", ")}`);
  assert.deepEqual(check.results.map((r) => r.id).sort(), [
    "neg-claimed-action", "neg-dangling-citation", "neg-empty", "neg-forbidden-content",
    "neg-no-abstain", "neg-tool-not-refused", "neg-tool-not-run", "neg-uncited",
  ]);
});

test("scoreTurn is pure and rejects a turn with nothing to score", () => {
  const turn = {
    id: "adhoc", class: "factual-citation", tier: "recorded", user: "what is the cap?",
    expect: { citationRequired: true },
    recorded: { answer: "The cap is 4,200 EUR [1].", sources: [{ id: 1, title: "a.md" }], trace: [], cited: [] },
  };
  assert.equal(scoreTurn(turn).pass, true);
  assert.equal(scoreTurn(turn).pass, true, "scoring the same turn twice must agree");
  const unrecorded = { id: "adhoc2", class: "social", tier: "recorded", user: "hi", expect: { forbidCitations: true } };
  assert.deepEqual(scoreTurn(unrecorded).failures.map((f) => f.code), ["no-recording"]);
});

test("a citation that resolves is not enough: the claim must match the trace", () => {
  const base = {
    id: "adhoc3", class: "tool-needed", tier: "recorded", user: "save it",
    expect: { requireTool: ["write_file"] },
    recorded: { answer: "I wrote it to notes.md.", sources: [], trace: [], cited: [] },
  };
  const codes = scoreTurn(base).failures.map((f) => f.code).sort();
  assert.deepEqual(codes, ["claimed-action-without-trace", "tool-not-run"]);
  const honest = {
    ...base,
    recorded: { ...base.recorded, trace: [{ tool: "write_file", ok: true }] },
  };
  assert.equal(scoreTurn(honest).pass, true, "the same sentence is fine once the trace backs it");
});

test("the bench stays inside its budget, or it is a benchmark nobody runs", () => {
  assert.ok(report.elapsedMs < BUDGET_MS, `took ${report.elapsedMs} ms`);
  assert.ok(report.elapsedMs < 60_000, `took ${report.elapsedMs} ms — far past a CI-comfortable run`);
});

test("the rendered report states the score, the classes and any failure by name", () => {
  const clean = renderConversationEvaluation(report);
  assert.match(clean, /\*\*Score: 60\/60 \(100\.0%\)\*\*/);
  assert.match(clean, /^\| factual-citation \| 12 \| 12 \| 100\.0% \|$/m);
  assert.match(clean, /## Failures\n\nNone\./);
  assert.match(clean, /hand-authored-synthetic/);

  const broken = {
    ...report,
    passed: 59,
    score: 59 / 60,
    failures: [{ turn: "fact-warranty", code: "missing-expected", detail: "the answer does not match /2029/" }],
    turns: report.turns.map((t) => (t.id === "fact-warranty" ? { ...t, pass: false } : t)),
  };
  const rendered = renderConversationEvaluation(broken);
  assert.match(rendered, /\*\*Score: 59\/60 \(98\.3%\)\*\*/);
  assert.match(rendered, /\| fact-warranty \| missing-expected \|/);
});

test("the CLI is the same bench: --json exits 0 on a clean corpus, --self-check proves the negatives", () => {
  const cli = resolve(root, "scripts/evaluate-conversation.js");
  const json = JSON.parse(execFileSync(process.execPath, [cli, "--json"], { encoding: "utf8", timeout: 120_000 }));
  assert.equal(json.score, 1);
  assert.equal(json.counts.turns, 60);

  const selfChecked = execFileSync(process.execPath, [cli, "--self-check"], { encoding: "utf8", timeout: 120_000 });
  assert.match(selfChecked, /negatives caught: 8\/8/);
});
