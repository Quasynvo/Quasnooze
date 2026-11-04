# Synthetic retrieval evaluation — corpus v1

Fixture SHA-256: `f9ae8d4166658b05d26c5287833c1f9dbfc6a7d33d2b044da250d4aab513d6a5`

Engine: existing bounded lexical BM25; defaults unchanged. 7 documents, 8 labelled passages; 7 answerable and 3 no-answer queries.

- Recall@k = distinct labelled relevant passages in the first k hits / all labelled relevant passages; macro-mean over answerable queries only.
- MRR@k = macro-mean of 1 / first relevant hit rank (1-based), or 0 when absent within k, over answerable queries only.
- No-answer false positive = a labelled no-answer query returning any positive-score hit. This measures retrieval, not whether a model would abstain.
- Exact fixture filename and inclusive passage start/end lines; an unlabelled hit is not relevant. No-answer queries are excluded from recall/MRR denominators.
- Cold = first search of a fresh unique corpus path for each query. Warm = immediate repeat of that same query/path. Reuse still reads/hashes bounded bytes; it is not a no-I/O or latency metric.

| k | Macro recall@k | MRR@k |
|---|---:|---:|
| 1 | 0.928571 | 1.000000 |
| 5 | 1.000000 | 1.000000 |

No-answer: 2/3 empty; 1 false positive(s).

| Query | Relevant | Returned (rank order) | Cold indexed/reused | Warm indexed/reused |
|---|---|---|---|---|
| travel-ceiling | travel | travel, meals | 7/0 | 0/7 |
| meal-ceiling | meals | meals, travel | 7/0 | 0/7 |
| workshop-hours | access | access, handbook, handbook-assembly | 7/0 | 0/7 |
| garden-care | garden | garden | 7/0 | 0/7 |
| release-beacon | release | release | 7/0 | 0/7 |
| evacuation-route | handbook | handbook | 7/0 | 0/7 |
| evacuation-complete | handbook, handbook-assembly | handbook-assembly, handbook, access | 7/0 | 0/7 |
| absent-vocabulary | (none) | (none) | 7/0 | 0/7 |
| absent-medical | (none) | (none) | 7/0 | 0/7 |
| overlap-no-answer | (none) | travel, meals | 7/0 | 0/7 |

## Stale updates and bounds

```json
{
  "mutations": {
    "edit": {
      "oldHitsBefore": 1,
      "oldHitsAfter": 0,
      "newHitsAfter": 1,
      "after": {
        "files": 7,
        "chunks": 9,
        "skipped": 0,
        "truncated": false,
        "reused": 6,
        "indexed": 1
      }
    },
    "deletion": {
      "hitsBefore": 1,
      "hitsAfter": 0,
      "after": {
        "files": 6,
        "chunks": 8,
        "skipped": 0,
        "truncated": false,
        "reused": 6,
        "indexed": 0
      }
    }
  },
  "bounded": [
    {
      "id": "file-byte-cap",
      "files": 0,
      "chunks": 0,
      "skipped": 1,
      "truncated": true,
      "reused": 0,
      "indexed": 0,
      "hits": 0,
      "expected": "skipped=1, truncated=true, hits=0"
    },
    {
      "id": "hit-cap",
      "defaultHits": 5,
      "requested100Hits": 8,
      "expected": "default=5, clamped=8"
    }
  ],
  "limits": {
    "entries": 2000,
    "bytes": 12582912,
    "fileBytes": 2097152,
    "depth": 8,
    "lines": 24,
    "passageChars": 4000,
    "fileChars": 262144,
    "totalChars": 4194304,
    "cacheWeight": 16777216
  }
}
```

## Citation provenance (not answer faithfulness)

Hand-authored claims use a source registered from the actual travel retrieval. A valid reference can accompany an unsupported claim; a successful reference check is not semantic support.

```json
[
  {
    "id": "supported-reference",
    "text": "The travel reimbursement ceiling is 4200 credits [1].",
    "expectedUnknown": [],
    "fixtureSupport": "supported",
    "cited": [
      1
    ],
    "unknown": [],
    "sourceRefs": [
      "travel.md#L1-L4"
    ],
    "referenceCheckMatchesExpectation": true
  },
  {
    "id": "unsupported-claim-valid-reference",
    "text": "The travel reimbursement ceiling is 9900 credits [1].",
    "expectedUnknown": [],
    "fixtureSupport": "unsupported",
    "cited": [
      1
    ],
    "unknown": [],
    "sourceRefs": [
      "travel.md#L1-L4"
    ],
    "referenceCheckMatchesExpectation": true
  },
  {
    "id": "fabricated-reference",
    "text": "The travel ceiling is 4200 credits [99].",
    "expectedUnknown": [
      99
    ],
    "fixtureSupport": "reference-missing",
    "cited": [],
    "unknown": [
      99
    ],
    "sourceRefs": [
      "travel.md#L1-L4"
    ],
    "referenceCheckMatchesExpectation": true
  },
  {
    "id": "previous-turn-reference",
    "unknown": [
      1
    ],
    "expectedUnknown": [
      1
    ],
    "referenceCheckMatchesExpectation": true
  }
]
```

Model answer faithfulness: **not-run**; 0 model answers; score null. No model was called. Hand-authored claim labels demonstrate the limits of provenance validation; they are not a model faithfulness score.

## Observed failures

```json
[
  {
    "kind": "no-answer-false-positive",
    "query": "overlap-no-answer",
    "returned": [
      "travel",
      "meals"
    ]
  }
]
```

This tiny synthetic baseline does not establish real-user quality, model abstention, latency, rival superiority, native Windows/macOS behavior or hardware performance. No models, private corpora or network calls were used. Independent review remains required. See docs/RETRIEVAL-EVALUATION.md for reproduction and scope.

