import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { evaluateRetrieval, rankMetrics, renderRetrievalEvaluation } from '../scripts/evaluate-retrieval.js';

// One measured run per test process: immutable report shared by assertions.
const report = await evaluateRetrieval();

test('metric definitions use relevant-set recall, one-based first rank and no-answer exclusion', () => {
  assert.deepEqual(rankMetrics(['distractor', 'a', 'b'], ['a', 'b'], 1), { recall: 0, reciprocalRank: 0 });
  assert.deepEqual(rankMetrics(['distractor', 'a', 'b'], ['a', 'b'], 2), { recall: 0.5, reciprocalRank: 0.5 });
  assert.deepEqual(rankMetrics(['a', 'a', 'b'], ['a', 'b'], 3), { recall: 1, reciprocalRank: 1 });
  assert.deepEqual(rankMetrics(['distractor'], [], 5), { recall: null, reciprocalRank: null });
  assert.throws(() => rankMetrics([], [], 0), /cutoff/);
  assert.equal(report.metrics[1].recall, 6.5 / 7);
  assert.equal(report.metrics[5].recall, 1);
  assert.equal(report.metrics[5].mrr, 1);
});

test('versioned labels and measured ranks include distractors and multiple relevant passages', async () => {
  const manifest = JSON.parse(await readFile(new URL('../test-fixtures/retrieval/v1/manifest.json', import.meta.url)));
  assert.equal(manifest.synthetic, true);
  assert.equal(report.fixtureVersion, 1);
  assert.deepEqual(report.corpus, { documents: 7, labelledPassages: 8 });
  assert.equal(new Set(manifest.passages.map(p => p.id)).size, manifest.passages.length);
  for (const passage of manifest.passages) {
    const text = await readFile(new URL(`../test-fixtures/retrieval/v1/corpus/${passage.file}`, import.meta.url), 'utf8');
    assert.ok(passage.start >= 1 && passage.end >= passage.start && passage.end <= text.split('\n').length);
  }
  const ids = new Set(manifest.passages.map(p => p.id));
  for (const query of manifest.queries) {
    assert.ok(query.rationale);
    for (const id of query.relevant) assert.ok(ids.has(id));
  }
  assert.deepEqual(report.counts, { queries: 10, answerable: 7, noAnswer: 3, coldSearches: 10, warmSearches: 10 });
  const multiple = report.queries.find(q => q.id === 'evacuation-complete');
  assert.equal(multiple.relevant.length, 2);
  assert.equal(multiple.metrics[1].recall, 0.5);
  assert.equal(multiple.metrics[5].recall, 1);
});

test('no-answer false positives remain visible, not silently counted as recall successes', () => {
  assert.deepEqual(report.noAnswer, { queries: 3, emptyResults: 2, falsePositives: 1 });
  assert.deepEqual(report.failures, [{ kind: 'no-answer-false-positive', query: 'overlap-no-answer', returned: ['travel', 'meals'] }]);
  for (const query of report.queries.filter(q => !q.relevant.length)) {
    assert.equal(query.metrics[5].recall, null);
    assert.equal(query.metrics[5].reciprocalRank, null);
  }
  assert.match(renderRetrievalEvaluation(report), /overlap-no-answer/);
});

test('cold/warm index counters and explicit bounds do not alter production defaults', () => {
  for (const query of report.queries) {
    assert.deepEqual(query.warmReturned, query.returned);
    assert.equal(query.cold.reused, 0);
    assert.equal(query.cold.indexed, 7);
    assert.equal(query.warm.reused, 7);
    assert.equal(query.warm.indexed, 0);
    assert.equal(query.cold.truncated, false);
    assert.equal(query.warm.truncated, false);
  }
  assert.equal(report.bounded[0].truncated, true);
  assert.equal(report.bounded[0].skipped, 1);
  assert.equal(report.bounded[0].hits, 0);
  assert.equal(report.bounded[1].defaultHits, 5);
  assert.equal(report.bounded[1].requested100Hits, 8);
});

test('changed/deleted files no longer return cached stale evidence', () => {
  assert.equal(report.mutations.edit.oldHitsBefore, 1);
  assert.equal(report.mutations.edit.oldHitsAfter, 0);
  assert.equal(report.mutations.edit.newHitsAfter, 1);
  assert.equal(report.mutations.edit.after.indexed, 1);
  assert.equal(report.mutations.edit.after.reused, 6);
  assert.equal(report.mutations.deletion.hitsBefore, 1);
  assert.equal(report.mutations.deletion.hitsAfter, 0);
  assert.equal(report.mutations.deletion.after.files, 6);
  assert.equal(report.mutations.deletion.after.indexed, 0);
});

test('citation provenance cannot certify answer faithfulness', () => {
  assert.ok(report.citations.every(c => c.referenceCheckMatchesExpectation));
  const valid = report.citations.find(c => c.id === 'supported-reference');
  const falseClaim = report.citations.find(c => c.id === 'unsupported-claim-valid-reference');
  assert.deepEqual(valid.cited, [1]);
  assert.deepEqual(falseClaim.cited, [1]);
  assert.deepEqual(valid.unknown, []);
  assert.deepEqual(falseClaim.unknown, []);
  assert.equal(falseClaim.fixtureSupport, 'unsupported');
  assert.deepEqual(report.citations.find(c => c.id === 'fabricated-reference').unknown, [99]);
  assert.deepEqual(report.citations.find(c => c.id === 'previous-turn-reference').unknown, [1]);
  assert.equal(report.answerFaithfulness.status, 'not-run');
  assert.equal(report.answerFaithfulness.evaluatedModelAnswers, 0);
  assert.equal(report.answerFaithfulness.score, null);
});

test('report is reproducible across runs and matches the checked-in measured baseline', async () => {
  const rerun = await evaluateRetrieval();
  assert.deepEqual(rerun, report);
  const baseline = await readFile(new URL('../docs/RETRIEVAL-BASELINE-V1.md', import.meta.url), 'utf8');
  assert.equal(renderRetrievalEvaluation(report) + '\n', baseline);
  assert.ok(!JSON.stringify(report).includes('quas-retrieval-eval-'));
});
