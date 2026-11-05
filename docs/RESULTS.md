# Results — every number in the README, reproduced

> **Rule of this page (borrowed from the best READMEs in the field):** no number
> appears without its sample size, its method, its reproduce command, and a
> statement of what it does *not* prove. If a number here ever goes stale, a
> test fails — the speech and retrieval baselines are compared byte-for-byte
> against their runners.

Measured 5 November 2026. Test-suite count verified in a clean checkout of
`main` (commit `2071723`): **817 tests, 817 passed, 0 failed**
(`node --test --test-concurrency=4`, ~26 s, Node 20 in the measuring sandbox;
the project requires Node ≥ 22 — see `package.json`).

## 1. Headline results

| # | Claim | Result | n | Reproduce | Full report |
|---|---|---|---|---|---|
| 1 | Deterministic fast path matches labelled intents | **31/31 (100%)** | 59 utterances | `node scripts/fast-path-eval.js` | [FAST-PATH-EVAL.md](FAST-PATH-EVAL.md) |
| 2 | Neighbouring phrasings wrongly acted on | **0/28** | 28 negatives | `node scripts/fast-path-eval.js` | [FAST-PATH-EVAL.md](FAST-PATH-EVAL.md) |
| 3 | Fast turn end-to-end latency | **p50 4.3 ms, p95 7.9 ms** | 50 turns | `node --test test/fast-path.test.js` | [FAST-PATH-EVAL.md](FAST-PATH-EVAL.md) |
| 4 | Conversation bench, deterministically gated | **60/60 (100%)** | 60 turns (16 live-loop, 44 recorded) | `node scripts/evaluate-conversation.js` | [CONVERSATION-BENCH.md](CONVERSATION-BENCH.md) |
| 5 | Verified execution, fault injection | **20/20 correct verdicts, 0 silent wrong-successes** | 20 injected faults | `node --test test/verify.test.js` | [VERIFIED-EXECUTION.md](VERIFIED-EXECUTION.md) |
| 6 | Read-back cost (2 KB file write) | **p50 0.28 ms, p95 0.69 ms** (contract allowed 50 ms p95) | 100 | `node --test test/verify.test.js` | [VERIFIED-EXECUTION.md](VERIFIED-EXECUTION.md) |
| 7 | Retrieval Recall@1 / Recall@5, MRR@5; no-answer | **0.93 / 1.00, 1.00; 3/3 empty, 0 false positives** (coverage gate) | 7 answerable + 3 no-answer queries | `node scripts/evaluate-retrieval.js` | [RETRIEVAL-BASELINE-V1.md](RETRIEVAL-BASELINE-V1.md) |
| 8 | Speech command accuracy (synthetic text hypotheses) | **79.2% overall, 9.7% WER** (digit-group joining: numbers-names 60% → 70%) | 48 utterances | `node scripts/evaluate-speech.js` (`npm run speech`) | [SPEECH-BASELINE-V1.md](SPEECH-BASELINE-V1.md) |
| 9 | Full regression suite | **817/817 passed** | 66 test files | `node --test --test-concurrency=4` | §4 below |

## 2. Speech, by condition — including where it is worst

| Condition | Utterances | WER | Command accuracy |
|---|---:|---:|---:|
| clean | 14 | 0.0% | 100.0% |
| accented | 12 | 13.9% | 75.0% |
| noisy | 12 | 15.2% | 66.7% |
| numbers-and-names | 10 | 10.1% | **70.0% ← weakest** (was 60.0% before digit-group joining) |

A substituted digit is one word of WER and a completely different reminder —
which is why WER and command accuracy are reported separately and never
averaged. **Not measured:** any physical microphone, acoustic model, or real
recording. These are hand-authored text hypotheses scored by the shipped
router. Anyone quoting "77.1%" without that sentence is misquoting this repo.

## 3. Where Quasnooze loses today (kept on purpose)

- **Numbers-and-names speech routing: 70%** (above). The remaining misses are
  acoustically wrong digits in the transcript (*15*→*50*, *30*→*13*, *4417*→*4471*):
  unrecoverable by any router, tracked for confirmation read-back instead.
- ~~**Retrieval no-answer:** 1 of 3 false positives~~ — **fixed**: the ≥50%
  query-term coverage gate returns 3/3 empty with Recall@5 unchanged.
- **Voice latency & turn-taking:** ~1.5 s+ to first sound and silence-only
  endpointing, vs ~200 ms full-duplex research systems — scored honestly in
  [COMPETITIVE-FRONTIER.md](COMPETITIVE-FRONTIER.md).
- **Physical Windows microphone / wake-word / accessibility acceptance:**
  not yet tested on hardware. The README must never imply otherwise.
- **Model intelligence:** the conversation bench's live tier uses an
  in-process mock brain. It measures the pipeline, not any model's IQ.

## 4. Reproduce everything (offline, no keys, no model download)

```bash
git clone https://github.com/Quasynvo/Quasnooze.git && cd Quasnooze
node --test --test-concurrency=4        # 817 tests
node scripts/fast-path-eval.js          # rows 1–2
node scripts/evaluate-conversation.js   # row 4 (runs in well under a minute)
node scripts/evaluate-retrieval.js      # row 7
npm run speech                          # row 8 + §2
node scripts/audit.js                   # local audit
npm run health                          # environment + baseline freshness
```

## 5. Method notes

- Every corpus is versioned, synthetic, and shipped in `test-fixtures/`
  (speech corpus CC0-1.0). No private data, no user conversations, no network.
- Conditions under a minimum sample size report **"withheld"** rather than a
  percentage (`MIN_CONDITION_SAMPLES = 8` in the speech runner).
- The committed speech/retrieval baselines are the runners' own output; a
  test compares them byte-for-byte, so a stale number fails the build
  instead of sitting there looking measured.
- Latency figures are single-machine, no-model-installed harness numbers.
  They bound the deterministic path; they say nothing about model latency
  on your hardware.
