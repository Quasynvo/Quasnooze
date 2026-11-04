#!/usr/bin/env node
/** Synthetic offline evaluation. Mutations are confined to disposable copies. */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { searchDocuments, DOCUMENT_LIMITS } from '../src/documents.js';
import { createSources, addSource, listSources } from '../src/sources.js';
import { validateCitations } from '../src/citations.js';

const FIXTURE = new URL('../test-fixtures/retrieval/v1/', import.meta.url);

export function rankMetrics(returned, relevant, k) {
  if (!Number.isInteger(k) || k < 1) throw new Error('Invalid metric cutoff');
  const expected = new Set(relevant), top = [...new Set(returned.slice(0, k))];
  if (!expected.size) return { recall: null, reciprocalRank: null };
  const matched = top.filter(id => expected.has(id));
  const first = returned.slice(0, k).findIndex(id => expected.has(id));
  return { recall: matched.length / expected.size, reciprocalRank: first < 0 ? 0 : 1 / (first + 1) };
}
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const stats = ({ files, chunks, skipped, truncated, reused, indexed }) => ({ files, chunks, skipped, truncated, reused, indexed });

export async function evaluateRetrieval() {
  const manifestBytes = await readFile(new URL('manifest.json', FIXTURE));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.version !== 1 || manifest.synthetic !== true) throw new Error('Unsupported synthetic fixture version');
  const names = [...new Set(manifest.passages.map(p => p.file))].sort();
  const queryIds = manifest.queries.map(q => q.id);
  if (new Set(queryIds).size !== queryIds.length || queryIds.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id) || ['mutations', 'oversized', 'hit-cap'].includes(id))) throw new Error('Invalid fixture query id');
  if (![manifest.mutations.changedFile, manifest.mutations.deletedFile].every(name => names.includes(name)) || !/^updates\/[a-z-]+\.md$/.test(manifest.mutations.replacement)) throw new Error('Invalid fixture mutation path');
  // Fixture paths are fixed repository-owned assets, never a user corpus option.
  for (const name of names) if (!/^[a-z-]+\.md$/.test(name)) throw new Error('Invalid fixture filename');
  const corpus = new Map();
  const hash = createHash('sha256').update(`manifest:${manifestBytes.length}:`).update(manifestBytes);
  for (const name of names) {
    const bytes = await readFile(new URL(`corpus/${name}`, FIXTURE));
    corpus.set(name, bytes); hash.update(`${name}:${bytes.length}:`).update(bytes);
  }
  const replacement = await readFile(new URL(manifest.mutations.replacement, FIXTURE));
  hash.update(`replacement:${replacement.length}:`).update(replacement);
  const base = await mkdtemp(join(tmpdir(), 'quas-retrieval-eval-'));
  const report = {
    schemaVersion: 1, fixtureVersion: manifest.version, fixture: manifest.name, fixtureSha256: hash.digest('hex'),
    engine: 'existing bounded lexical BM25; defaults unchanged', cutoffs: manifest.cutoffs,
    definitions: {
      recall: 'Recall@k = distinct labelled relevant passages in the first k hits / all labelled relevant passages; macro-mean over answerable queries only.',
      rank: 'MRR@k = macro-mean of 1 / first relevant hit rank (1-based), or 0 when absent within k, over answerable queries only.',
      noAnswer: 'No-answer false positive = a labelled no-answer query returning any positive-score hit. This measures retrieval, not whether a model would abstain.',
      matching: 'Exact fixture filename and inclusive passage start/end lines; an unlabelled hit is not relevant. No-answer queries are excluded from recall/MRR denominators.',
      cache: 'Cold = first search of a fresh unique corpus path for each query. Warm = immediate repeat of that same query/path. Reuse still reads/hashes bounded bytes; it is not a no-I/O or latency metric.',
    },
    corpus: { documents: names.length, labelledPassages: manifest.passages.length }, limits: { ...DOCUMENT_LIMITS },
    queries: [], metrics: {}, mutations: {}, bounded: [], citations: [], failures: [],
    answerFaithfulness: { status: 'not-run', evaluatedModelAnswers: 0, score: null, reason: 'No model was called. Hand-authored claim labels demonstrate the limits of provenance validation; they are not a model faithfulness score.' },
  };
  function guard(root) {
    return path => {
      const absolute = resolve(path), rel = relative(root, absolute);
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Outside synthetic fixture');
      return absolute;
    };
  }
  async function seed(name) {
    const root = join(base, name); await mkdir(root);
    for (const [name, bytes] of corpus) await writeFile(join(root, name), bytes);
    return root;
  }
  const search = (root, query, options = {}) => searchDocuments({ path: root, query, resolvePath: guard(root), ...options });
  const identify = (root, hit) => manifest.passages.find(p => p.file === relative(root, hit.path) && p.start === hit.start && p.end === hit.end)?.id || `unlabelled:${relative(root, hit.path)}:${hit.start}-${hit.end}`;
  let citationHit;
  try {
    for (const query of manifest.queries) {
      const root = await seed(query.id);
      const cold = await search(root, query.query), warm = await search(root, query.query);
      const returned = cold.hits.map(hit => identify(root, hit));
      const warmReturned = warm.hits.map(hit => identify(root, hit));
      const row = { id: query.id, query: query.query, relevant: query.relevant, returned, warmReturned, cold: stats(cold), warm: stats(warm), metrics: {} };
      for (const k of manifest.cutoffs) row.metrics[k] = rankMetrics(returned, query.relevant, k);
      if (!query.relevant.length && returned.length) report.failures.push({ kind: 'no-answer-false-positive', query: query.id, returned });
      if (query.relevant.length && row.metrics[5].recall < 1) report.failures.push({ kind: 'relevance-miss-at-5', query: query.id });
      if (JSON.stringify(returned) !== JSON.stringify(warmReturned)) report.failures.push({ kind: 'cold-warm-disagreement', query: query.id });
      if (cold.reused !== 0 || cold.indexed !== names.length || warm.indexed !== 0 || warm.reused !== names.length || cold.truncated || warm.truncated) report.failures.push({ kind: 'unexpected-cache-or-coverage', query: query.id });
      if (query.id === 'travel-ceiling' && cold.hits[0]) citationHit = { ...cold.hits[0], file: relative(root, cold.hits[0].path) };
      report.queries.push(row);
    }
    const answerable = report.queries.filter(q => q.relevant.length), noAnswer = report.queries.filter(q => !q.relevant.length);
    report.counts = { queries: report.queries.length, answerable: answerable.length, noAnswer: noAnswer.length, coldSearches: report.queries.length, warmSearches: report.queries.length };
    for (const k of manifest.cutoffs) report.metrics[k] = { recall: mean(answerable.map(q => q.metrics[k].recall)), mrr: mean(answerable.map(q => q.metrics[k].reciprocalRank)) };
    report.noAnswer = { queries: noAnswer.length, emptyResults: noAnswer.filter(q => !q.returned.length).length, falsePositives: noAnswer.filter(q => q.returned.length).length };

    const changed = await seed('mutations'), mutation = manifest.mutations;
    const old = await search(changed, mutation.oldQuery), deleted = await search(changed, mutation.deletedQuery);
    await writeFile(join(changed, mutation.changedFile), replacement);
    const afterEdit = await search(changed, mutation.newQuery), oldAfterEdit = await search(changed, mutation.oldQuery);
    await rm(join(changed, mutation.deletedFile));
    const afterDelete = await search(changed, mutation.deletedQuery);
    report.mutations = {
      edit: { oldHitsBefore: old.hits.length, oldHitsAfter: oldAfterEdit.hits.length, newHitsAfter: afterEdit.hits.length, after: stats(afterEdit) },
      deletion: { hitsBefore: deleted.hits.length, hitsAfter: afterDelete.hits.length, after: stats(afterDelete) },
    };
    if (old.hits.length !== 1 || oldAfterEdit.hits.length || afterEdit.hits.length !== 1 || !afterEdit.hits[0].text.includes('silver')) report.failures.push({ kind: 'stale-edit' });
    if (deleted.hits.length !== 1 || afterDelete.hits.length || afterDelete.files !== names.length - 1) report.failures.push({ kind: 'stale-deletion' });

    const oversized = join(base, 'oversized'); await mkdir(oversized);
    await writeFile(join(oversized, 'large.txt'), 'x'.repeat(DOCUMENT_LIMITS.fileBytes + 1));
    const sizeResult = await search(oversized, 'boundaryneedle');
    report.bounded.push({ id: 'file-byte-cap', ...stats(sizeResult), hits: sizeResult.hits.length, expected: 'skipped=1, truncated=true, hits=0' });
    if (!sizeResult.truncated || sizeResult.skipped !== 1 || sizeResult.hits.length) report.failures.push({ kind: 'file-byte-bound' });
    const capRoot = join(base, 'hit-cap'); await mkdir(capRoot);
    for (let i = 0; i < 12; i++) await writeFile(join(capRoot, `${i}.txt`), 'boundaryneedle');
    const defaultHits = await search(capRoot, 'boundaryneedle'), capped = await search(capRoot, 'boundaryneedle', { limit: 100 });
    report.bounded.push({ id: 'hit-cap', defaultHits: defaultHits.hits.length, requested100Hits: capped.hits.length, expected: 'default=5, clamped=8' });
    if (defaultHits.hits.length !== 5 || capped.hits.length !== 8) report.failures.push({ kind: 'hit-bound' });

    const sources = createSources();
    if (!citationHit || !citationHit.text.includes('4200')) throw new Error('Citation evidence unavailable');
    const ref = `${citationHit.file}#L${citationHit.start}-L${citationHit.end}`;
    addSource(sources, { kind: 'file', title: ref, ref, snippet: citationHit.text, version: createHash('sha256').update(citationHit.text).digest('hex') });
    for (const check of manifest.citations) {
      const result = validateCitations({ text: check.text, sources: listSources(sources) });
      const matches = JSON.stringify(result.unknown) === JSON.stringify(check.expectedUnknown);
      report.citations.push({ ...check, cited: result.cited, unknown: result.unknown, sourceRefs: listSources(sources).map(s => s.ref), referenceCheckMatchesExpectation: matches });
      if (!matches) report.failures.push({ kind: 'citation-provenance', case: check.id });
    }
    const stale = validateCitations({ text: 'Old source [1].', sources: listSources(createSources()) });
    report.citations.push({ id: 'previous-turn-reference', unknown: stale.unknown, expectedUnknown: [1], referenceCheckMatchesExpectation: JSON.stringify(stale.unknown) === '[1]' });
    if (JSON.stringify(stale.unknown) !== '[1]') report.failures.push({ kind: 'stale-citation-provenance' });
    return report;
  } finally { await rm(base, { recursive: true, force: true }); }
}

export function renderRetrievalEvaluation(report) {
  return ['# Synthetic retrieval evaluation — corpus v1', '',
    `Fixture SHA-256: \`${report.fixtureSha256}\``, '',
    `Engine: ${report.engine}. ${report.corpus.documents} documents, ${report.corpus.labelledPassages} labelled passages; ${report.counts.answerable} answerable and ${report.counts.noAnswer} no-answer queries.`, '',
    ...Object.values(report.definitions).map(text => `- ${text}`), '',
    '| k | Macro recall@k | MRR@k |', '|---|---:|---:|',
    ...Object.entries(report.metrics).map(([k, m]) => `| ${k} | ${m.recall.toFixed(6)} | ${m.mrr.toFixed(6)} |`), '',
    `No-answer: ${report.noAnswer.emptyResults}/${report.noAnswer.queries} empty; ${report.noAnswer.falsePositives} false positive(s).`, '',
    '| Query | Relevant | Returned (rank order) | Cold indexed/reused | Warm indexed/reused |', '|---|---|---|---|---|',
    ...report.queries.map(q => `| ${q.id} | ${q.relevant.join(', ') || '(none)'} | ${q.returned.join(', ') || '(none)'} | ${q.cold.indexed}/${q.cold.reused} | ${q.warm.indexed}/${q.warm.reused} |`), '',
    '## Stale updates and bounds', '', '```json', JSON.stringify({ mutations: report.mutations, bounded: report.bounded, limits: report.limits }, null, 2), '```', '',
    '## Citation provenance (not answer faithfulness)', '',
    'Hand-authored claims use a source registered from the actual travel retrieval. A valid reference can accompany an unsupported claim; a successful reference check is not semantic support.', '',
    '```json', JSON.stringify(report.citations, null, 2), '```', '',
    `Model answer faithfulness: **${report.answerFaithfulness.status}**; ${report.answerFaithfulness.evaluatedModelAnswers} model answers; score null. ${report.answerFaithfulness.reason}`, '',
    '## Observed failures', '', '```json', JSON.stringify(report.failures, null, 2), '```', '',
    'This tiny synthetic baseline does not establish real-user quality, model abstention, latency, rival superiority, native Windows/macOS behavior or hardware performance. No models, private corpora or network calls were used. Independent review remains required. See docs/RETRIEVAL-EVALUATION.md for reproduction and scope.', '',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) { console.error('Usage: node scripts/evaluate-retrieval.js [--json]'); process.exitCode = 1; }
  else {
    const report = await evaluateRetrieval();
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderRetrievalEvaluation(report));
  }
}
