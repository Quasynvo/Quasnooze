# Reproducible synthetic retrieval evaluation

This is an evaluation of the existing local lexical/BM25 implementation, **not a
new retrieval engine or a measured real-user failure**. Production ranking,
workspace rules, index budgets, defaults and citation validators are unchanged.
It is separate from task 012 readiness/latency baselines.

## Run from a source checkout

```sh
node scripts/evaluate-retrieval.js
node scripts/evaluate-retrieval.js --json
node --test test/retrieval-evaluation.test.js
```

The first command renders Markdown to stdout; the second emits machine-readable
results. To intentionally refresh the checked-in measured artifact after reviewing
fixture changes:

```sh
node scripts/evaluate-retrieval.js > docs/RETRIEVAL-BASELINE-V1.md
```

The evaluator writes/edits/removes only disposable synthetic copies under the OS
temp directory and cleans them up in `finally`. It never reads a user corpus,
loads a model, downloads anything, or calls a network service. The script is
source-checkout developer tooling, not a runtime npm-package command. It has no
user-supplied corpus/path or model-provider option. A completed report exits 0
even if quality failures are observed: **report generation is not a quality
pass**. Unexpected execution errors exit nonzero. Tests pin the known failure
list so new misses cannot silently disappear into a successful process status.

## Versioned labels

[`test-fixtures/retrieval/v1/manifest.json`](../test-fixtures/retrieval/v1/manifest.json)
contains the synthetic-only declaration, explicit filename/inclusive-line passage
IDs, ten queries, binary relevance labels with rationales, mutation instructions
and hand-authored citation examples. Corpus v1 has seven tiny Markdown documents
and eight labelled evidence passages, including two different 24-line sections of
one handbook, semantically adjacent travel/meal distractors, and three no-answer
queries. One no-answer deliberately shares vocabulary with the policies. Short
files' labelled ranges include their final blank line, matching the existing
chunker's split-line convention; the handbook's trailing blank chunk has no
matching terms and is not labelled relevant.

Relevance labels describe requested information, not mere token overlap. For the
complete evacuation query, both exit and assembly-point passages are relevant.
For teleportation travel allowance, neither ordinary travel nor meal allowance
answers the question even though both can rank. That mismatch is kept visible.
This small, hand-labelled fixture is not a statistical sample or independent
assessment of general retrieval quality. Review labels independently before
relying on the baseline; changes to intended semantics warrant a new fixture
version instead of relabelling a regression away.

A SHA-256 over the manifest, ordered corpus bytes and replacement bytes binds the
report to its fixtures. Reports exclude absolute temp paths, timestamps and
runtime timing samples, so repeated runs can be compared exactly. The fixture
files are never changed by evaluation. The test suite compares repeat runs and
the checked-in [measured baseline](RETRIEVAL-BASELINE-V1.md).

## Metrics and denominators

- **Recall@k**: number of distinct labelled relevant passages among the first k
  hits divided by all labelled relevant passages for that query. Macro-averaged
  over the seven answerable queries only. A query needing two passages can score
  0.5 at k=1 even if its first hit is correct.
- **MRR@k**: mean reciprocal rank of the first labelled relevant hit (1-based), or
  zero if none occurs within k, over those same seven answerable queries.
- **No-answer behavior**: empty-result and false-positive counts among three
  labelled no-answer queries. An empty result is not proof that an answer is
  absent; a hit is not proof that it answers. These queries contribute **null**,
  not perfect/zero scores, to recall/MRR. No model abstention rate is measured.
- Matching is exact fixture filename and inclusive start/end lines. Unlabelled
  or mismatched passages get no relevance credit. Failures and ranked IDs are
  printed alongside aggregate metrics.

Cutoffs are 1 and 5. Query evaluation uses the existing default of five hits, not
a changed runtime setting. No model score, rival comparison, confidence interval,
latency, throughput or hardware measurement is implied by these metrics.

## Cold/warm, edits, deletion and bounds

Every labelled query gets its own freshly materialized corpus path. Its first
search must report seven newly indexed files and zero reused entries. The
immediate warm repeat must reuse all seven without new indexing, and return the
same ranked passage IDs. **Warm still rewalks, rechecks and hashes file bytes**;
this evaluates cache correctness/counters, not zero-I/O behavior or speed.

A separate warmed copy replaces the release beacon from cobalt to silver and
then deletes an aqueduct document. The report records old/new hit counts plus
indexed/reused/file counts, verifying stale evidence does not survive. Additional
synthetic cases exceed the per-file byte budget and request 100 hits to observe
the existing default-five/clamped-eight behavior. The full production limits are
printed. These cases do not exhaustively benchmark every byte, depth, entry or
LRU limit; existing `test/documents.test.js` provides further safety/budget tests.

## Provenance is not faithfulness

A fresh production source registry is populated from the **actually retrieved**
travel passage. Production `validateCitations()` checks a supported hand-authored
claim, a false claim pointing to the same valid source, and an invented source
ID. A second fresh turn rejects a previous turn's citation ID. Both supported
and false claims with `[1]` pass reference validation: this is expected and
exposes the validator's scope, not a certification of the false claim. Human
fixture support labels are not generated/model-judged scores.

**Model-answer faithfulness is `not-run`, zero evaluated model answers, score
null.** No unrun faithfulness/abstention metric is reported as passing. The source
registry demonstration is not a new tool/agent end-to-end run; existing document,
agent and citation tests cover integration separately.

## Recorded boundary

The checked-in artifact records an actual offline run in the Linux coding
sandbox with Node 22. Recall@5 and MRR@5 are 1.0 on this fixture; two of three
no-answer queries yield no hits, while the vocabulary-overlap case returns two
irrelevant policy passages. **That observed false positive is retained in the
failure list**, not a recommendation to change the engine or defaults.

Independent maintainer review remains required. No private data, model
faithfulness, physical Windows/macOS, user acceptance or hardware/latency tests
were performed or claimed. This synthetic result does not establish superiority
over other retrievers or justify changing production defaults.
