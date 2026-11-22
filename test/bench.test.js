/**
 * bench.test.js — the freshness guard behind `skill-03` for the numbers
 * themselves (roadmap F10, issue #210).
 *
 * The repo's rule is that a published number must be the runner's own output,
 * not prose someone typed. This suite enforces it from both directions:
 *
 *   1. the published tables (README.md, docs/RESULTS.md) must match the
 *      committed bench baseline — edit a number without re-measuring and the
 *      build fails;
 *   2. the committed baseline must still be what the shipped evaluators
 *      produce — change behaviour without re-measuring and the build fails;
 *   3. README.md and docs/RESULTS.md must never disagree with each other on
 *      the claims both publish (timing included).
 *
 * The full test-suite counts are re-measured by `npm run bench:check` (which
 * runs `node --test` outside the suite — re-running it in here would be
 * recursion). Everything else is re-measured live below, in about a second.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BASELINE_PATH,
  measureBench,
  readDocs,
  checkDocs,
  checkCrossDoc,
  diffBaseline,
  countTestFiles,
} from "../scripts/bench.js";

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

test("every number published in README.md and docs/RESULTS.md matches the committed bench baseline", () => {
  const drift = checkDocs(readDocs(), baseline);
  assert.deepEqual(drift, [], `the prose and the measured baseline disagree:\n  ${drift.join("\n  ")}`);
});

test("the committed baseline is fresh — the shipped evaluators still measure it", async () => {
  // suite: false — the suite cannot benchmark itself; `npm run bench:check`
  // covers the suite counts by running the tests outside this process.
  const live = await measureBench({ suite: false });
  const drift = diffBaseline(baseline, live);
  assert.deepEqual(drift, [], `the baseline is stale — re-run \`npm run bench\` and update the published numbers:\n  ${drift.join("\n  ")}`);
});

test("README.md and docs/RESULTS.md cannot disagree on a shared claim", () => {
  const drift = checkCrossDoc(readDocs());
  assert.deepEqual(drift, [], `the two documents disagree:\n  ${drift.join("\n  ")}`);
});

test("the bench baseline describes a suite that exists", () => {
  assert.equal(baseline.kind, "quasnooze-bench");
  assert.equal(baseline.schema_version, 1);
  assert.ok(baseline.suite, "the committed baseline is missing its suite section — run `npm run bench`");
  assert.equal(typeof baseline.suite.fail, "number");
  assert.equal(baseline.suite.files, countTestFiles(), "the baseline's file count no longer matches the tree — re-run `npm run bench`");
});
