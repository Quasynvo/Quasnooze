#!/usr/bin/env node
/**
 * scripts/bench.js — the Quasnooze Bench (roadmap F10, issue #210).
 *
 * The README is full of numbers, and numbers rot. This command re-measures
 * every published one with the repo's own evaluators and fails when reality,
 * the committed baseline, and the prose disagree — so a stale number fails
 * the build instead of sitting in a README looking measured.
 *
 *   node scripts/bench.js                  re-measure everything and rewrite
 *                                          test-fixtures/bench/v1/baseline.json
 *   node scripts/bench.js --check          re-measure and compare against the
 *                                          committed baseline and the published
 *                                          tables; exit 1 on any drift
 *   node scripts/bench.js --check --no-suite
 *                                          same, but trust the committed suite
 *                                          counts instead of re-running the
 *                                          whole test suite
 *   node scripts/bench.js --json           machine-readable measurement
 *
 * What is measured, and how (no model, no network, no microphone):
 *   suite         `node --test` summary lines and the *.test.js file count
 *   fast_path     scripts/fast-path-eval.js --json      (counts only, no µs)
 *   conversation  scripts/evaluate-conversation.js --json
 *   retrieval     scripts/evaluate-retrieval.js --json
 *   speech        scripts/evaluate-speech.js --json
 *
 * Timing numbers (fast-turn p50/p95, read-back p50/p95) are machine-dependent
 * and are deliberately NOT re-measured here: a wall-clock claim cannot be
 * byte-compared across machines without lying on one of them. They are instead
 * cross-checked between README.md and docs/RESULTS.md so the two cannot
 * disagree, and labelled as doc agreements rather than benchmark results.
 *
 * The claim table below parses the *published tables* — the bold result cell
 * and the n cell of each headline row. Numbers are compared numerically with
 * a tolerance of half a unit of the published precision ("0.93" may round
 * 0.928571…; "79.2" may round 79.1666…), never by string equality, so a
 * re-format does not fail while a changed value does.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = join(ROOT, "test-fixtures", "bench", "v1", "baseline.json");
const README_PATH = join(ROOT, "README.md");
const RESULTS_PATH = join(ROOT, "docs", "RESULTS.md");

/* ───────────────────────────── measurement ─────────────────────────────── */

function runNode(args) {
  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return run;
}

function runEvalJson(args) {
  const run = runNode(args);
  if (run.status !== 0) {
    throw new Error(`bench: \`${args.join(" ")}\` exited ${run.status}: ${(run.stderr || "").trim() || (run.stdout || "").trim()}`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    throw new Error(`bench: \`${args.join(" ")}\` did not print JSON: ${err.message}`);
  }
}

export function countTestFiles() {
  return readdirSync(ROOT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .filter((path) => !path.includes("node_modules") && !path.includes(`${".git"}/`)).length;
}

export function measureSuite() {
  const run = runNode(["--test", "--test-concurrency=4"]);
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;
  const num = (name) => {
    const m = out.match(new RegExp(`^# ${name} (\\d+)$`, "m"));
    if (!m) throw new Error(`bench: no "# ${name}" line in the test summary`);
    return Number(m[1]);
  };
  // A red suite is recorded, not thrown: `--check` turns it into drift, and
  // write mode still needs to bootstrap a baseline for a brand-new claim row.
  return { tests: num("tests"), pass: num("pass"), fail: num("fail"), files: countTestFiles() };
}

/**
 * Re-measure everything that is deterministic. `suite: false` skips the full
 * test run (used inside the suite itself, where re-running the suite would be
 * recursion) — the caller then falls back to the committed suite counts.
 */
export async function measureBench({ suite = true } = {}) {
  const fastPath = runEvalJson(["scripts/fast-path-eval.js", "--json"]);
  const conversation = runEvalJson(["scripts/evaluate-conversation.js", "--json"]);
  const retrieval = runEvalJson(["scripts/evaluate-retrieval.js", "--json"]);
  const speech = runEvalJson(["scripts/evaluate-speech.js", "--json"]);

  const matched = Object.values(fastPath.byIntent).reduce((sum, row) => sum + row.matched, 0);
  return {
    kind: "quasnooze-bench",
    schema_version: 1,
    ...(suite ? { suite: measureSuite() } : {}),
    fast_path: {
      corpus: fastPath.corpus,
      matched,
      positives: fastPath.positives,
      negatives: fastPath.negatives,
      wrong_routes: fastPath.wrongRoutes.length,
    },
    conversation: {
      passed: conversation.passed,
      gated: conversation.counts.deterministicGated,
      turns: conversation.counts.turns,
      live: conversation.counts.live,
      recorded: conversation.counts.recorded,
    },
    retrieval: {
      answerable: retrieval.counts.answerable,
      no_answer: retrieval.noAnswer.queries,
      no_answer_empty: retrieval.noAnswer.emptyResults,
      false_positives: retrieval.noAnswer.falsePositives,
      recall_at_1: retrieval.metrics["1"].recall,
      recall_at_5: retrieval.metrics["5"].recall,
      mrr_at_5: retrieval.metrics["5"].mrr,
    },
    speech: {
      utterances: speech.totals.samples,
      overall_accuracy: speech.headline.commandAccuracy,
      wer: speech.headline.wer,
      clean: speech.conditions.clean.commandAccuracy.value,
      accented: speech.conditions.accented.commandAccuracy.value,
      noisy: speech.conditions.noisy.commandAccuracy.value,
      numbers_names: speech.conditions["numbers-names"].commandAccuracy.value,
    },
  };
}

/* ──────────────────────────────── the claims ───────────────────────────── */

/**
 * Every headline row the README and docs/RESULTS.md publish. Each row names
 * the label that locates it in its table, the shape of its bold result cell
 * and of its n cell, and how to re-derive each number from a measurement.
 * Group order in the regexes is the order of `names` / `measure`: bold groups
 * first, then n-cell groups. When `measure` is null the row is a timing or
 * non-reproducible claim: it is cross-checked between the two documents only.
 */
const MEASURED_ROWS = [
  {
    id: "fast-path-coverage",
    readme: { label: /Fast-path routing — deterministic intents matched/, bold: /^(\d+)\/(\d+) \(([\d.]+)%\)$/, n: /^(\d+) labelled utterances$/ },
    results: { label: /Deterministic fast path matches labelled intents/, bold: /^(\d+)\/(\d+) \(([\d.]+)%\)$/, n: /^(\d+) utterances$/ },
    names: ["matched", "positives", "coverage %", "corpus utterances"],
    measure: (m) => [m.fast_path.matched, m.fast_path.positives, (m.fast_path.matched / m.fast_path.positives) * 100, m.fast_path.corpus],
  },
  {
    id: "fast-path-negatives",
    readme: { label: /Look-alike phrasings wrongly acted on/, bold: /^(\d+)\/(\d+)$/, n: /^(\d+) negatives$/ },
    results: { label: /Neighbouring phrasings wrongly acted on/, bold: /^(\d+)\/(\d+)$/, n: /^(\d+) negatives$/ },
    names: ["wrong routes", "negatives", "negatives (n)"],
    measure: (m) => [m.fast_path.wrong_routes, m.fast_path.negatives, m.fast_path.negatives],
  },
  {
    id: "conversation-bench",
    readme: { label: /Conversation bench — deterministically gated turns/, bold: /^(\d+)\/(\d+) \(([\d.]+)%\)$/, n: /^(\d+) turns \((\d+) live-loop, (\d+) recorded\)$/ },
    results: { label: /Conversation bench, deterministically gated/, bold: /^(\d+)\/(\d+) \(([\d.]+)%\)$/, n: /^(\d+) turns \((\d+) live-loop, (\d+) recorded\)$/ },
    names: ["passed", "gated", "score %", "turns", "live turns", "recorded turns"],
    measure: (m) => [m.conversation.passed, m.conversation.gated, (m.conversation.passed / m.conversation.gated) * 100, m.conversation.turns, m.conversation.live, m.conversation.recorded],
  },
  {
    id: "retrieval",
    readme: {
      label: /Retrieval — Recall@1/,
      bold: /^([\d.]+) \/ ([\d.]+) · ([\d.]+)$/,
      n: /^(\d+) answerable \+ (\d+) no-answer queries$/,
    },
    results: {
      label: /Retrieval Recall@1 \/ Recall@5, MRR@5; no-answer/,
      bold: /^([\d.]+) \/ ([\d.]+), ([\d.]+); (\d+)\/(\d+) empty, (\d+) false positives?(?: \(.*\))?$/,
      n: /^(\d+) answerable \+ (\d+) no-answer queries$/,
    },
    namesPerDoc: {
      readme: ["Recall@1", "Recall@5", "MRR@5", "answerable queries", "no-answer queries"],
      results: ["Recall@1", "Recall@5", "MRR@5", "no-answer empty", "no-answer queries", "false positives", "answerable queries", "no-answer queries"],
    },
    measurePerDoc: {
      readme: (m) => [m.retrieval.recall_at_1, m.retrieval.recall_at_5, m.retrieval.mrr_at_5, m.retrieval.answerable, m.retrieval.no_answer],
      results: (m) => [m.retrieval.recall_at_1, m.retrieval.recall_at_5, m.retrieval.mrr_at_5, m.retrieval.no_answer_empty, m.retrieval.no_answer, m.retrieval.false_positives, m.retrieval.answerable, m.retrieval.no_answer],
    },
  },
  {
    id: "speech",
    readme: {
      label: /Speech command accuracy — clean/,
      bold: /^([\d.]+)% \/ ([\d.]+)% \/ ([\d.]+)% \/ ([\d.]+)%$/,
      n: /^(\d+) synthetic text utterances$/,
    },
    results: {
      label: /Speech command accuracy \(synthetic text hypotheses\)/,
      bold: /^([\d.]+)% overall, ([\d.]+)% WER(?: \(.*\))?$/,
      n: /^(\d+) utterances$/,
    },
    namesPerDoc: {
      readme: ["clean %", "accented %", "noisy %", "numbers-and-names %", "utterances"],
      results: ["overall accuracy %", "WER %", "utterances"],
    },
    measurePerDoc: {
      readme: (m) => [m.speech.clean * 100, m.speech.accented * 100, m.speech.noisy * 100, m.speech.numbers_names * 100, m.speech.utterances],
      results: (m) => [m.speech.overall_accuracy * 100, m.speech.wer * 100, m.speech.utterances],
    },
  },
  {
    id: "suite",
    readme: { label: /Full regression suite/, bold: /^(\d+)\/(\d+) passed$/, n: /^(\d+) test files, ~\d+(?:\.\d+)? s$/ },
    results: { label: /Full regression suite/, bold: /^(\d+)\/(\d+) passed$/, n: /^(\d+) test files$/ },
    // The "N/N passed" claim is compared as [tests, tests, files]: publishing
    // "N passed" asserts the suite is green, and greenness is enforced by
    // `--check` (fail > 0 is drift) rather than by this number — comparing
    // against a pass count measured *while* this very test is failing would
    // make the baseline chase its own tail.
    names: ["tests", "passed (= tests when green; --check enforces green)", "test files"],
    measure: (m) => (m.suite ? [m.suite.tests, m.suite.tests, m.suite.files] : [null, null, null]),
  },
];

/**
 * Rows that are honest claims but not reproducible numbers: wall-clock
 * timings depend on the machine, and the fault-injection count is proven by
 * test/verify.test.js passing rather than by a re-runnable evaluator. These
 * are enforced as *agreements* — README.md and docs/RESULTS.md must publish
 * the same numbers — and by their own tests where one exists.
 */
const CROSS_ROWS = [
  {
    id: "fast-turn-latency",
    readme: { label: /Fast turn end-to-end \(replaces/ },
    results: { label: /Fast turn end-to-end latency/ },
  },
  {
    id: "verified-execution",
    readme: { label: /Verified execution — fault-injection verdicts/ },
    results: { label: /Verified execution, fault injection/ },
  },
  {
    id: "read-back",
    readme: null, // published in docs/RESULTS.md only; presence is guarded so the honesty row cannot vanish
    results: { label: /Read-back cost/ },
  },
];

/* ────────────────────────────── doc parsing ────────────────────────────── */

export function readDocs() {
  return {
    readme: readFileSync(README_PATH, "utf8"),
    results: readFileSync(RESULTS_PATH, "utf8"),
  };
}

function findRow(text, label) {
  for (const line of text.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (label.test(line)) return line;
  }
  return null;
}

function rowCells(line) {
  return line.split("|").map((c) => c.trim());
}

/** The bold result cell and the n cell right after it. */
function resultAndN(line) {
  const cells = rowCells(line);
  const i = cells.findIndex((c) => c.includes("**"));
  return {
    bold: i < 0 ? "" : cells[i].replace(/\*\*/g, "").trim(),
    n: i < 0 ? "" : (cells[i + 1] ?? "").trim(),
    found: i >= 0,
  };
}

function numbers(text) {
  return text.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** Half a unit of the published precision — "0.93" may round 0.928571… */
function closeEnough(claimed, measured) {
  if (measured === null || measured === undefined || Number.isNaN(measured)) return true;
  const decimals = claimed.includes(".") ? claimed.split(".")[1].length : 0;
  return Math.abs(Number(claimed) - measured) <= 0.5 * 10 ** -decimals + 1e-9;
}

function rowMeasure(row, doc) {
  return row.measurePerDoc?.[doc] ?? row.measure;
}

function rowNames(row, doc) {
  return row.namesPerDoc?.[doc] ?? row.names;
}

/**
 * Compare every published measured claim against a measurement.
 * Returns a drift list; empty means the prose is exactly as measured.
 */
export function checkDocs(docs, measurement) {
  const drift = [];
  for (const row of MEASURED_ROWS) {
    for (const doc of ["readme", "results"]) {
      const spec = row[doc];
      if (!spec) continue;
      const line = findRow(docs[doc], spec.label);
      if (!line) {
        drift.push(`${doc}: row "${row.id}" is gone — restore it or update the claim table in scripts/bench.js`);
        continue;
      }
      const { bold, n, found } = resultAndN(line);
      if (!found) {
        drift.push(`${doc}: row "${row.id}" has no bold result cell — the table shape changed; update scripts/bench.js`);
        continue;
      }
      const boldMatch = spec.bold.exec(bold);
      const nMatch = spec.n.exec(n);
      if (!boldMatch) {
        drift.push(`${doc}: row "${row.id}" result cell "${bold}" no longer parses (${spec.bold}) — update scripts/bench.js`);
        continue;
      }
      if (!nMatch) {
        drift.push(`${doc}: row "${row.id}" n cell "${n}" no longer parses (${spec.n}) — update scripts/bench.js`);
        continue;
      }
      const claimed = [...boldMatch.slice(1), ...nMatch.slice(1)];
      const expected = rowMeasure(row, doc)(measurement);
      const names = rowNames(row, doc);
      if (claimed.length !== expected.length) {
        drift.push(`${doc}: row "${row.id}" published ${claimed.length} numbers, the bench derives ${expected.length} — update scripts/bench.js`);
        continue;
      }
      claimed.forEach((value, i) => {
        if (!closeEnough(value, expected[i])) {
          drift.push(`${doc}: row "${row.id}" ${names[i]}: published ${value}, measured ${expected[i]}`);
        }
      });
    }
  }
  return drift;
}

/**
 * Timing / non-reproducible rows: README.md and docs/RESULTS.md must publish
 * the same numbers, and the docs-only rows must at least still parse.
 */
export function checkCrossDoc(docs) {
  const drift = [];
  for (const row of CROSS_ROWS) {
    const found = {};
    for (const doc of ["readme", "results"]) {
      const spec = row[doc];
      if (!spec) continue;
      const line = findRow(docs[doc], spec.label);
      if (!line) {
        drift.push(`${doc}: row "${row.id}" is gone — a timing or honesty claim was deleted; restore it or update scripts/bench.js`);
        continue;
      }
      const { bold, n, found: hasBold } = resultAndN(line);
      if (!hasBold) {
        drift.push(`${doc}: row "${row.id}" has no bold result cell — update scripts/bench.js`);
        continue;
      }
      found[doc] = [...numbers(bold), ...numbers(n)];
      if (found[doc].length === 0) {
        drift.push(`${doc}: row "${row.id}" publishes no numbers any more — update scripts/bench.js`);
      }
    }
    if (found.readme && found.results) {
      const a = found.readme.join(",");
      const b = found.results.join(",");
      if (a !== b) drift.push(`README.md and docs/RESULTS.md disagree on "${row.id}": ${a} vs ${b}`);
    }
  }
  return drift;
}

/* ─────────────────────────────── baseline diff ─────────────────────────── */

/** Field-level drift between the committed baseline and a fresh measurement. */
export function diffBaseline(committed, live, prefix = "") {
  const drift = [];
  for (const key of Object.keys(committed)) {
    if (!(key in live)) continue; // measured without this section (e.g. --no-suite): not drift
    const a = committed[key];
    const b = live[key];
    if (a !== null && typeof a === "object") {
      drift.push(...diffBaseline(a, b, `${prefix}${key}.`));
    } else if (a !== b) {
      drift.push(`${prefix}${key}: baseline ${a}, measured ${b}`);
    }
  }
  return drift;
}

/* ──────────────────────────────── rendering ────────────────────────────── */

export function renderBench(measurement) {
  const lines = ["# Quasnooze Bench", ""];
  const section = (title, rows) => {
    lines.push(`## ${title}`, "", "| metric | measured |", "|---|---:|");
    for (const [name, value] of rows) lines.push(`| ${name} | ${value} |`);
    lines.push("");
  };
  if (measurement.suite) {
    const s = measurement.suite;
    section("Suite", [["tests", s.tests], ["passed", s.pass], ["failed", s.fail], ["test files", s.files]]);
  }
  const f = measurement.fast_path;
  section("Fast path", [["matched", `${f.matched}/${f.positives}`], ["wrong routes", `${f.wrong_routes}/${f.negatives}`], ["corpus", f.corpus]]);
  const c = measurement.conversation;
  section("Conversation bench", [["gated turns passed", `${c.passed}/${c.gated}`], ["live/recorded", `${c.live}/${c.recorded}`]]);
  const r = measurement.retrieval;
  section("Retrieval", [["Recall@1", r.recall_at_1], ["Recall@5", r.recall_at_5], ["MRR@5", r.mrr_at_5], ["no-answer empty", `${r.no_answer_empty}/${r.no_answer}`], ["false positives", r.false_positives]]);
  const s = measurement.speech;
  section("Speech (synthetic text hypotheses — no microphone)", [
    ["overall accuracy", `${(s.overall_accuracy * 100).toFixed(1)}%`],
    ["WER", `${(s.wer * 100).toFixed(1)}%`],
    ["clean / accented / noisy / numbers-names", `${(s.clean * 100).toFixed(1)}% / ${(s.accented * 100).toFixed(1)}% / ${(s.noisy * 100).toFixed(1)}% / ${(s.numbers_names * 100).toFixed(1)}%`],
    ["utterances", s.utterances],
  ]);
  return lines.join("\n");
}

/* ─────────────────────────────────── CLI ───────────────────────────────── */

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = new Set(process.argv.slice(2));
  const check = args.has("--check");
  const json = args.has("--json");
  const withSuite = !args.has("--no-suite");
  try {
    let committed = null;
    try {
      committed = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
    } catch {
      if (check) throw new Error("bench: no committed baseline — run `npm run bench` first");
    }
    const live = await measureBench({ suite: withSuite });
    const effective = { ...(committed ?? {}), ...live };
    const docs = readDocs();
    const drift = [
      ...(check ? diffBaseline(committed ?? {}, live) : []),
      ...(check && live.suite && live.suite.fail > 0
        ? [`suite: the test suite itself is red (${live.suite.pass}/${live.suite.tests}, ${live.suite.fail} failed)`]
        : []),
      ...checkDocs(docs, effective),
      ...checkCrossDoc(docs),
    ];

    if (json && !check) {
      console.log(JSON.stringify(live, null, 2));
    } else if (check) {
      if (drift.length) {
        console.error("bench: drift detected — the published numbers and reality disagree:\n");
        for (const line of drift) console.error(`  ✖ ${line}`);
        console.error("\n  Fix by re-measuring (`npm run bench`) and updating the numbers in");
        console.error("  README.md and docs/RESULTS.md in the same change.");
        process.exit(1);
      }
      console.log(`bench: fresh — ${withSuite ? "suite + " : ""}fast path, conversation, retrieval and speech all match the committed baseline and the published tables.`);
    } else {
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      writeFileSync(BASELINE_PATH, `${JSON.stringify(live, null, 2)}\n`);
      console.log(renderBench(live));
      console.log(`baseline written to ${BASELINE_PATH.replace(`${ROOT}/`, "")}`);
      const docDrift = [...checkDocs(docs, live), ...checkCrossDoc(docs)];
      if (docDrift.length) {
        console.log("\nnote: the published tables disagree with this fresh measurement:");
        for (const line of docDrift) console.log(`  · ${line}`);
        console.log("  update README.md and docs/RESULTS.md — test/bench.test.js will fail until you do.");
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
