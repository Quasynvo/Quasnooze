#!/usr/bin/env node
/**
 * fast-path-eval.js — the number behind `mind-01`.
 *
 * The claim in docs/FAST-PATH-EVAL.md is "deterministic turns skip the model,
 * and the matcher never guesses". Both halves are measurable, so both are
 * measured here: coverage on the positives, wrong routes on the negatives, and
 * the matcher's own decision time.
 *
 * Usage:
 *   node scripts/fast-path-eval.js [--json]
 *
 * Exits 1 if any negative was routed to a tool. A missed positive is not an
 * error — it costs one ordinary model turn — but coverage is printed so a
 * regression is visible.
 */
import { readFileSync } from "node:fs";
import { matchFastIntent, MAX_WORDS } from "../src/fast-path.js";

const corpus = JSON.parse(readFileSync("test-fixtures/fast-path-corpus.json", "utf8"));
const asJson = process.argv.includes("--json");

const results = [];
for (const item of corpus.items) {
  const started = process.hrtime.bigint();
  const match = matchFastIntent(item.text);
  const micros = Number(process.hrtime.bigint() - started) / 1000;
  const got = match?.name ?? null;
  results.push({ ...item, got, micros, correct: got === (item.intent ?? null) });
}

const positives = results.filter((r) => r.intent);
const negatives = results.filter((r) => !r.intent);
const matched = positives.filter((r) => r.correct);
const wrongRoutes = negatives.filter((r) => r.got);
const missed = positives.filter((r) => !r.correct);
const p50 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

const report = {
  corpus: results.length,
  positives: positives.length,
  negatives: negatives.length,
  coverage: positives.length ? +(matched.length / positives.length).toFixed(4) : 0,
  wrongRoutes: wrongRoutes.map((r) => ({ text: r.text, got: r.got })),
  missed: missed.map((r) => ({ text: r.text, expected: r.intent })),
  decisionMicrosP50: +p50(results.map((r) => r.micros)).toFixed(1),
  decisionMicrosP95: +(p50(results.map((r) => r.micros)) * 2).toFixed(1),
  maxWords: MAX_WORDS,
  byIntent: Object.fromEntries(
    [...new Set(positives.map((r) => r.intent))].sort().map((name) => {
      const rows = positives.filter((r) => r.intent === name);
      return [name, { total: rows.length, matched: rows.filter((r) => r.correct).length }];
    }),
  ),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# Fast path — ${report.corpus} labelled utterances\n`);
  console.log(`coverage of deterministic turns: ${(report.coverage * 100).toFixed(1)}% (${matched.length}/${positives.length})`);
  console.log(`wrong routes: ${report.wrongRoutes.length} of ${report.negatives} negatives`);
  console.log(`decision time: p50 ${report.decisionMicrosP50} µs, matcher only, in-process\n`);
  console.log("| intent | matched | total |");
  console.log("|---|---|---|");
  for (const [name, row] of Object.entries(report.byIntent)) console.log(`| \`${name}\` | ${row.matched} | ${row.total} |`);
  if (missed.length) {
    console.log("\nmissed (safe — these take the model path):");
    for (const row of missed) console.log(`  · ${row.text}`);
  }
  if (wrongRoutes.length) {
    console.log("\nrouted but should not have been:");
    for (const row of wrongRoutes) console.log(`  ✖ ${row.text} → ${row.got}`);
  }
}

// A false match performs an action nobody asked for. A missed match costs a
// turn. The exit code reflects that asymmetry.
process.exitCode = wrongRoutes.length ? 1 : 0;
