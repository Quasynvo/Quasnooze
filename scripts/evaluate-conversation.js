#!/usr/bin/env node
/**
 * evaluate-conversation.js — does the assistant answer *correctly*?
 *
 * The repository already scores retrieval (`evaluate-retrieval.js`), the
 * deterministic fast path (`fast-path-eval.js`), readiness and the laptop control
 * floor. None of those answer the only question a person asks of an assistant:
 * was the answer right?
 *
 * This scores a versioned corpus of labelled turns. It has two tiers, and the
 * difference between them is the whole honesty of the exercise:
 *
 *   • **live** turns run `runAgent` in this process against the in-process mock
 *     brain. No network, no model install, no credentials — but the *real* loop,
 *     the real risk tiers, the real citation registry and the real honesty guard.
 *     These measure pipeline behaviour: a tool ran when it had to, a blocked
 *     command was refused, a citation resolves, nothing is claimed that did not
 *     happen.
 *   • **recorded** turns are prose fixtures, committed with the corpus and
 *     scored by the same checker. Their `recorded.model` field names where they
 *     came from. In v1 that is `hand-authored-synthetic`: they prove the checker
 *     discriminates and give a regression baseline, and they are **not** a
 *     measurement of any model.
 *
 * What is deliberately not scored: tone, verbosity, formatting, latency. A bench
 * that rewards being agreeable is a bench that teaches an assistant to be
 * agreeable.
 *
 * Usage:
 *   node scripts/evaluate-conversation.js             # markdown report, exit 1 on failure
 *   node scripts/evaluate-conversation.js --json      # machine-readable
 *   node scripts/evaluate-conversation.js --self-check # prove the negatives are caught
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = new URL("../test-fixtures/conversation/v1/", import.meta.url);

export const CORPUS_VERSION = 1;
/** The whole bench must stay inside this, or it becomes a benchmark nobody runs. */
export const BUDGET_MS = 5 * 60 * 1000;

/** Phrasings that count as a refusal to answer. Narrow on purpose: "I could not find" is a claim. */
const ABSTAIN = [
  /\bcould ?n[o']t find\b/i,
  /\bcould not find\b/i,
  /\bno (?:record|mention|information|match)\b/i,
  /\bnot (?:in|among) (?:your|the) (?:notes|documents|files)\b/i,
  /\b(I )?(?:do not|don't) have\b/i,
  /\bunable to find\b/i,
  /\bnothing in your\b/i,
];

/** A verb that asserts something happened. Any of these needs a tool that did it. */
const ACTION_CLAIM =
  /\bI(?:'ve| have)? (?:now )?(?:written|wrote|saved|deleted|removed|moved|created|sent|installed|renamed|uploaded|emailed)\b/i;
const ACTION_TOOLS = new Set([
  "write_file", "shell", "scheduled", "schedule", "remind", "remember", "open_url",
  "system_control", "run_skill", "move_file", "trash_file",
]);

const citationsIn = (answer) => [...String(answer).matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));

/**
 * Score one turn. Pure: same input, same failures, no clock and no model.
 * @returns {{id: string, class: string, tier: string, pass: boolean, failures: {code: string, detail: string}[]}}
 */
export function scoreTurn(turn) {
  const observed = turn.tier === "live" ? turn._observed : turn.recorded;
  const expect = turn.expect || {};
  const failures = [];
  const fail = (code, detail) => failures.push({ code, detail });

  if (!observed) return { id: turn.id, class: turn.class, tier: turn.tier, pass: false, failures: [{ code: "no-recording", detail: "the turn has no observed answer to score" }] };

  const answer = String(observed.answer ?? "");
  const sources = Array.isArray(observed.sources) ? observed.sources : [];
  const trace = Array.isArray(observed.trace) ? observed.trace : [];
  const cited = new Set([...citationsIn(answer), ...(observed.cited || [])]);
  const sourceIds = new Set(sources.map((s) => Number(s.id)));

  // Universal: an answer that is empty is not an answer.
  if (!answer.trim()) fail("empty-answer", "the turn produced no text");

  // Universal: every citation must resolve to a source the turn actually retrieved.
  for (const id of cited) {
    if (!sourceIds.has(id)) {
      fail("dangling-citation", `the answer cites [${id}] but only ${sourceIds.size} source(s) were registered`);
    }
  }

  // Universal: a claim that something happened needs a tool that did it.
  const claimed = ACTION_CLAIM.exec(answer);
  if (claimed) {
    const did = trace.some((t) => t.ok && ACTION_TOOLS.has(t.tool));
    if (!did) fail("claimed-action-without-trace", `"${claimed[0]}" with no successful action in the trace`);
  }

  if (expect.citationRequired) {
    const resolved = [...cited].filter((id) => sourceIds.has(id));
    if (!resolved.length) fail("uncited-answer", "a citation was required and the answer carried none that resolves");
  }
  if (expect.forbidCitations && cited.size) {
    fail("unexpected-citation", `this turn should cite nothing, but cites ${[...cited].join(", ")}`);
  }
  if (expect.mustAbstain && !ABSTAIN.some((re) => re.test(answer))) {
    fail("no-abstain", "the question had no answer in the corpus and the reply did not say so");
  }
  for (const name of expect.requireTool || []) {
    if (!trace.some((t) => t.tool === name && t.ok && !t.denied)) fail("tool-not-run", `${name} did not run successfully`);
  }
  for (const name of expect.requireDenied || []) {
    if (!trace.some((t) => t.tool === name && t.denied)) fail("tool-not-refused", `${name} was expected to be refused and was not`);
  }
  for (const name of expect.forbidTool || []) {
    if (trace.some((t) => t.tool === name)) fail("tool-ran", `${name} ran on a turn that must not touch the machine`);
  }
  for (const pattern of expect.mustMatch || []) {
    if (!new RegExp(pattern, "i").test(answer)) fail("missing-expected", `the answer does not match /${pattern}/`);
  }
  for (const pattern of expect.mustNotMatch || []) {
    if (new RegExp(pattern, "i").test(answer)) fail("forbidden-content", `the answer matches /${pattern}/, which it must not`);
  }

  return { id: turn.id, class: turn.class, tier: turn.tier, pass: failures.length === 0, failures };
}

/**
 * A markdown table cell. Both the pipe and the backslash in front of it must be
 * escaped, or a detail containing `\|` breaks the row -- and the report is the
 * only thing a reviewer reads.
 */
const cell = (value) => String(value).replace(/[\\|]/g, (ch) => (ch === "\\" ? "\\\\" : "\\|"));

function validateCorpus(corpus) {
  if (corpus.version !== CORPUS_VERSION) throw new Error(`Unsupported corpus version ${corpus.version}`);
  if (corpus.synthetic !== true) throw new Error("The corpus must declare itself synthetic");
  if (!Array.isArray(corpus.turns) || corpus.turns.length !== 60) throw new Error(`The corpus must carry 60 turns, found ${corpus.turns?.length}`);
  const ids = new Set();
  for (const turn of corpus.turns) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(turn.id)) throw new Error(`Invalid turn id ${turn.id}`);
    if (ids.has(turn.id)) throw new Error(`Duplicate turn id ${turn.id}`);
    ids.add(turn.id);
    if (!["live", "recorded"].includes(turn.tier)) throw new Error(`${turn.id}: tier must be live or recorded`);
    if (typeof turn.user !== "string" || !turn.user.trim()) throw new Error(`${turn.id}: no user text`);
    if (turn.tier === "recorded" && !turn.recorded) throw new Error(`${turn.id}: a recorded turn needs a recording`);
    if (turn.tier === "live" && turn.recorded) throw new Error(`${turn.id}: a live turn must not carry a recording`);
    const expect = turn.expect || {};
    const keys = Object.keys(expect).filter((k) => k !== "note");
    if (!keys.length) throw new Error(`${turn.id}: an expectation is what makes this a bench, and it has none`);
    for (const key of ["mustMatch", "mustNotMatch", "requireTool", "requireDenied", "forbidTool"]) {
      const value = expect[key];
      if (value === undefined) continue;
      // A bare string here silently becomes a list of characters: `"\\b12\\b"` would
      // compile as `\\` and score every turn wrong for a reason nobody can see.
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v)) throw new Error(`${turn.id}: expect.${key} must be a non-empty array of strings`);
    }
    const flags = ["citationRequired", "forbidCitations", "mustAbstain"];
    for (const key of flags) if (expect[key] !== undefined && typeof expect[key] !== "boolean") throw new Error(`${turn.id}: expect.${key} must be a boolean`);
  }
  return corpus;
}

/**
 * Run the live tier.
 *
 * `config` reads the data and workspace paths once, at first import, so the
 * directories are created once per process and only their *contents* are reset
 * between runs. A fresh temp dir per run looks tidier and quietly breaks the
 * second run: the tools keep writing to the first path, which cleanup deleted.
 */
let dirs = null;
async function ensureDirs() {
  if (dirs) return dirs;
  const data = await mkdtemp(join(tmpdir(), "quas-conv-data-"));
  const workspace = await mkdtemp(join(tmpdir(), "quas-conv-ws-"));
  dirs = {
    data,
    workspace,
    // A bench that reaches a network is a bench that fails on a plane. A real
    // provider stays opt-in, and the report names whatever ran.
    provider: process.env.LLM_PROVIDER,
    reset: async () => {
      for (const path of [data, workspace]) {
        await rm(path, { recursive: true, force: true });
        await mkdir(path, { recursive: true });
      }
    },
  };
  process.env.PINCH_DATA = data;
  process.env.PINCH_WORKSPACE = workspace;
  if (!process.env.LLM_PROVIDER) process.env.LLM_PROVIDER = "mock";
  process.once("exit", () => {
    for (const path of [data, workspace]) rm(path, { recursive: true, force: true }).catch(() => {});
  });
  return dirs;
}

async function runLive(turns) {
  const env = await ensureDirs();
  await env.reset();
  const { runAgent } = await import("../src/agent.js");
  const observed = [];
  for (const turn of turns) {
    const out = await runAgent({ sessionId: `conv-${turn.id}`, text: turn.user, channel: "bench" });
    observed.push({
      id: turn.id,
      _observed: { answer: out.text, sources: out.sources || [], cited: [], trace: out.trace || [] },
    });
  }
  return { observed, provider: process.env.LLM_PROVIDER };
}

export async function evaluateConversation({ now = Date.now() } = {}) {
  const started = now;
  const corpus = validateCorpus(JSON.parse(await readFile(new URL("corpus.json", FIXTURE), "utf8")));
  const classes = [...new Set(corpus.turns.map((t) => t.class))].sort();

  const liveTurns = corpus.turns.filter((t) => t.tier === "live");
  const live = await runLive(liveTurns);
  const observedById = new Map(live.observed.map((o) => [o.id, o._observed]));

  const scored = corpus.turns.map((turn) =>
    turn.tier === "live" ? scoreTurn({ ...turn, _observed: observedById.get(turn.id) }) : scoreTurn(turn),
  );

  const byClass = {};
  for (const name of classes) {
    const rows = scored.filter((r) => r.class === name);
    byClass[name] = {
      turns: rows.length,
      passed: rows.filter((r) => r.pass).length,
      score: rows.filter((r) => r.pass).length / rows.length,
      failing: rows.filter((r) => !r.pass).map((r) => r.id),
    };
  }

  const judged = corpus.turns.filter((t) => t.recorded?.judge);
  const report = {
    schemaVersion: 1,
    corpusVersion: corpus.version,
    corpus: corpus.name,
    synthetic: true,
    // Provenance, so nobody has to guess whether a number here came from a model.
    recording: { model: corpus.recording?.model ?? "unknown", note: corpus.recording?.note ?? "" },
    model: live.provider,
    status: "deterministic",
    definitions: {
      gate: "A turn passes only when every declared expectation and every universal check holds. There is no partial credit.",
      universal: "Every turn is also checked for a dangling citation (a [n] with no registered source) and for a claim of action with no successful action tool in the trace.",
      judge: "The optional model judge is recorded, never computed by this script, and never part of the gate. A local model is a weak judge; deterministic checks carry the score.",
      notScored: "Tone, verbosity, formatting and latency are not scored. A bench that rewards agreeableness teaches agreeableness.",
    },
    counts: {
      turns: corpus.turns.length,
      live: liveTurns.length,
      recorded: corpus.turns.length - liveTurns.length,
      deterministicGated: scored.length,
      judgedRecorded: judged.length,
    },
    score: scored.filter((r) => r.pass).length / scored.length,
    passed: scored.filter((r) => r.pass).length,
    byClass,
    failures: scored.flatMap((r) => r.failures.map((f) => ({ turn: r.id, ...f }))),
    elapsedMs: Date.now() - started,
    budgetMs: BUDGET_MS,
    turns: scored,
  };
  return report;
}

/** The negatives are the bench's own test: a checker that cannot fail is decoration. */
export async function selfCheck() {
  const negatives = JSON.parse(await readFile(new URL("negatives.json", FIXTURE), "utf8"));
  if (!Array.isArray(negatives.cases) || negatives.cases.length < 6) throw new Error("negatives.json must carry at least six cases");
  const results = negatives.cases.map((c) => {
    const scored = scoreTurn({ tier: "recorded", ...c.turn });
    const codes = scored.failures.map((f) => f.code);
    return { id: c.id, expect: c.expectCaught, caught: codes.includes(c.expectCaught), codes };
  });
  return { ok: results.every((r) => r.caught), results };
}

export function renderConversationEvaluation(report) {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  return [
    "# Conversation quality evaluation — corpus v1",
    "",
    `**Tier:** ${report.counts.live} live turns through the real agent loop, ${report.counts.recorded} recorded prose turns. ` +
      `**Deterministically gated:** ${report.counts.deterministicGated}/${report.counts.turns}. **Model judge:** ${report.counts.judgedRecorded} recorded, 0 computed.` +
      ` **Live brain:** \`${report.model}\` (in-process, no network). **Recorded prose from:** \`${report.recording.model}\`.`,
    "",
    `**Score: ${report.passed}/${report.counts.turns} (${pct(report.score)})** in ${report.elapsedMs} ms (budget ${report.budgetMs} ms).`,
    "",
    ...Object.values(report.definitions).map((text) => `- ${text}`),
    "",
    "| Class | Turns | Passed | Score |",
    "|---|---:|---:|---:|",
    ...Object.entries(report.byClass).map(([name, row]) => `| ${name} | ${row.turns} | ${row.passed} | ${pct(row.score)} |`),
    "",
    "## Failures",
    "",
    report.failures.length
      ? "| Turn | Code | Detail |\n|---|---|---|\n" +
        report.failures.map((f) => `| ${f.turn} | ${f.code} | ${cell(f.detail)} |`).join("\n")
      : "None.",
    "",
    "This corpus is synthetic and does not establish real-user quality, model behaviour on unseen phrasing, latency, or superiority over another product. " +
      "The live tier measures the pipeline on a canned brain, not the intelligence of a model; a model claim requires recording a run with a named model and re-scoring it. " +
      "See docs/CONVERSATION-BENCH.md for reproduction and scope.",
    "",
  ].join("\n");
}

/* ─────────────────────────────────── CLI ───────────────────────────────── */

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("evaluate-conversation.js");
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  try {
    if (args.has("--self-check")) {
      const check = await selfCheck();
      if (args.has("--json")) console.log(JSON.stringify(check, null, 2));
      else {
        console.log(`negatives caught: ${check.results.filter((r) => r.caught).length}/${check.results.length}`);
        for (const r of check.results) console.log(`  ${r.caught ? "caught" : "MISSED"} ${r.id} (expected ${r.expect})${r.caught ? "" : ` — got ${r.codes.join(", ") || "nothing"}`}`);
      }
      process.exit(check.ok ? 0 : 1);
    }
    const report = await evaluateConversation();
    console.log(args.has("--json") ? JSON.stringify(report, null, 2) : renderConversationEvaluation(report));
    process.exit(report.failures.length ? 1 : 0);
  } catch (err) {
    console.error(`evaluate-conversation: ${err.message}`);
    process.exit(2);
  }
}
