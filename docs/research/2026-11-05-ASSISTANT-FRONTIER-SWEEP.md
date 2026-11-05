# The assistant frontier sweep — 2026-11-05

What thirty assistant, voice, inference and agent projects already do better than
this repository, which of those improvements are worth taking, and the ten roadmap
items that came out of it.

This is a companion to [COMPETITIVE-FRONTIER.md](../COMPETITIVE-FRONTIER.md), which
compares Quasnooze against the leaders of one axis each. This document does
something narrower and, for a product that wants to be the fastest and most
trustworthy local assistant, more useful: it looks for **improvements somebody has
already measured on hardware like ours, that are simply missing here**.

**Snapshot:** Quasnooze at [`2ed1d90`](https://github.com/Quasynvo/Quasnooze/commit/2ed1d904a847b9fbd0815ce541c453b561bf2de9), 90 roadmap items, 716 passing tests,
`node scripts/validate-roadmap.js` clean. Competitors are read from their own
documentation and published measurements as of this date.

---

## 1. Method, and what this document does not claim

What was inspected:

- **This repository, end to end:** `src/` (54 modules, 10,830 lines), the 716-test
  suite, `docs/`, `.github/roadmap.json` and the queue/validator scripts, plus the
  two existing competitive audits so that nothing already planned is proposed a
  second time.
- **Thirty external projects**, chosen so that every axis this product competes on
  is represented at least twice: voice in, voice out, turn-taking, retrieval,
  memory, agent loop, context management, inference speed, evaluation,
  observability, computer use, permissions. The set and the reasoning for each
  membership are in §3.
- **Published measurements**, quoted with a URL in §7. Where a project's own
  benchmark contradicts another project's benchmark — which happens constantly in
  retrieval — both are cited and the disagreement becomes the design constraint.

What this document refuses to do:

- **It does not benchmark anything.** No competitor was installed, timed or
  profiled. Every number below is somebody else's, reproduced from a link, and is
  labelled as a *reference measurement* rather than a target. A reference
  measurement is context; it is never the acceptance bar.
- **It does not use star counts as an argument.** Popularity is not performance,
  and a project with fewer stars can own the technique that matters.
- **It does not propose a dependency.** The repository's zero-runtime-dependency
  identity is a constraint on the *solution*, not on which lessons are worth
  learning.
- **It does not propose anything already on the roadmap.** Where a gap is already
  covered, the row says which item covers it. That mapping is most of the value
  here: it turns "the field is big" into "here are the two things nobody in this
  repository has written down yet".

---

## 2. The six findings, read out of *this* checkout

Before comparing against anyone, the checkout was audited for the things the field
has already solved. Six defects, each with the file and line that causes it:

| # | Finding | Evidence in this repository | Cost |
|---|---|---|---|
| 1 | The prompt prefix is unstable by construction | `src/prompt.js:50` builds `Date and time: <now>` and injects up to 40 remembered facts into the **system** prompt; `src/brain.js:143` sends no `keep_alive` | Every minute boundary, new fact or model unload invalidates the KV cache; the turn re-prefills the whole prefix |
| 2 | The model is not kept resident | `src/brain.js:143` — `options: { temperature, num_ctx, num_predict }`, no residency hint | Ollama's default five-minute idle unload discards the cache and re-loads weights |
| 3 | Tool calls are strictly serial | `src/agent.js:414` — `for (const call of out.toolCalls)` | N independent reads cost N round trips; a three-file turn pays 3x |
| 4 | Tool arguments are parsed, never shaped | `src/agent.js` parse-failure branch: *"Your arguments were not valid JSON … Re-emit"* | A malformed call costs a full model round trip to fix a comma |
| 5 | Speech-to-text pads every clip to a fixed window | `src/voice.js` posts whole clips to a Whisper-compatible endpoint | A 2-second command pays a 30-second encoder pass |
| 6 | Latency is measured as a total, not as stages | `src/telemetry.js` records turn ms, rounds, tokens; the five-stage budget lives only as a table in `docs/VOICE-CONTROL-ROADMAP.md` §5 | A regression cannot be attributed to a stage, only felt |

Two things are missing rather than broken:

7. **No answer-quality evaluation.** Retrieval, the fast path, readiness and the
   laptop bench are scored. Whether an answer was correct, cited or coherent is
   not. Every "equal or better task success" clause in the existing roadmap is
   therefore unmeasurable.
8. **Memory is injected by recency, not relevance.** `slice(-40)` and `slice(-8)`
   in `src/prompt.js`. After a month of use the assistant carries forty mostly
   irrelevant facts into every turn.

Findings 1–6 are why the product *feels* slower than it is. Finding 7 is why the
product cannot prove it is getting better. Finding 8 is the one that quietly hurts
answer quality, because attention spent on an irrelevant fact is attention not
spent on the question.

---

## 3. The sweep: thirty projects, and a verdict for each

Legend: **adopt** = became a roadmap item in this sweep · **covered** = already
planned, with the item named · **refuse** = deliberately not taken, with the reason.

### 3.1 Voice pipeline and real-time speech

| Project | What it is genuinely best at | Verdict |
|---|---|---|
| **Home Assistant Assist / Wyoming** | Treating a voice turn as *separate stages with separate clocks* — wake, STT, intent, TTS — each with a published latency expectation, wired by a small open protocol | **adopt** the instrument, not the protocol → `voice-08-latency-waterfall`. The protocol is a second service; the discipline is free. |
| **Moonshine (Useful Sensors)** | A variable-length streaming encoder: process exactly the audio you were given, and do most of the work while the person is still talking | **adopt** → `ear-04-variable-window-stt`, as an eval-gated model-class decision, not a dependency |
| **whisper.cpp** | Local streaming transcription that runs anywhere | covered → `ear-01-local-streaming-stt` |
| **faster-whisper (CTranslate2)** | Fast CTranslate2 Whisper, the pragmatic local default | covered → `ear-01`, and it is the accuracy reference in `ear-04` |
| **livekit/agents** | Semantic turn detection, noise cancellation, test judges | covered → `duplex-01-semantic-turn-detection`, `ear-02-noise-robustness`, `voice-05` |
| **pipecat** | Interruption handling and transport abstraction; smart-turn-style endpointing | covered → `voice-03-barge-in`, `duplex-02-streaming-tts-first-audio` |
| **kyutai-labs/moshi** | True full duplex at ~200 ms, both streams concurrent | covered → `lead-01-cpu-duplex` |
| **TEN framework** | A real-time agent built as pipelined extensions with per-extension timing | **adopt** the per-extension clock → `voice-08`; refused as a framework |
| **silero-vad** | Robust, tiny voice activity detection | covered → `voice-02` uses it |
| **openWakeWord** | A tiny always-on wake model, trainable in about an hour | covered → `ear-03-on-device-wake-model` |
| **Piper / Kokoro** | Small, fast, offline neural synthesis | covered → `duplex-02`, `harness-13` |
| **Chatterbox-class streaming TTS** | Sub-200 ms first audio chunk with chunked streaming | covered → `duplex-02`; recorded here as the candidate to bench first |

**Lesson taken:** the leader's advantage is *pipelining*, not a faster model. Every
stage that finishes early hides the stage after it. Quasnooze currently waits for
each stage in full, and cannot show where the time went.

### 3.2 Local assistants and harnesses

| Project | What it is genuinely best at | Verdict |
|---|---|---|
| **OpenClaw** | Reach: twenty-plus channels, device companions, swap-in harnesses | covered → `lead-08-approval-integrity`, `lead-09-portable-skill-format` |
| **Open WebUI** | Hybrid retrieval with reranking, and visible task progress | **adopt** the retrieval decision discipline → `pinch-026-hybrid-retrieval-gate`; progress is already in the panel |
| **LibreChat** | Ask / Allow / Deny control, a trace viewer, checkpoint recovery | covered → `pinch-020`, `pinch-017`, `lead-08` |
| **AnythingLLM** | Intelligent tool selection to shrink the schema payload | covered → `pinch-015-relevant-tool-schemas` |
| **Khoj** | Personal-document RAG with citations, plus speech in the same product | covered → `pinch-011`, `pinch-022`, `citations.js` |
| **Jan** | Model acquisition and readiness UX for people who are not ML engineers | covered → `pinch-012`, `pinch-007` |
| **Letta (MemGPT)** | Self-editing memory: the model curates a bounded core block and recalls the rest by relevance | **adopt** the *selection* rule → `pinch-028-memory-recall-budget`; refused as an architecture |
| **mem0** | Extracting durable facts from conversation and retrieving them by relevance | **adopt** relevance → `pinch-028`; provenance → `harness-05-memory-provenance` |
| **block/goose** | MCP extensions plus recipes: a named, repeatable routine | covered → `skill-01-conversation-skill-compiler` |
| **OpenHands** | An event-sourced session that survives condensation | covered → `mind-02-context-budget`, `agentic-11-resume` |
| **Open Interpreter** | Code as the action, with native sandboxing and permission modes | **refuse** for a laptop assistant: a named tool with a typed schema and a preview beats generated code acting on the filesystem. Already the design. |
| **Dify / LangGraph / OpenAI Agents SDK** | Orchestration graphs, handoffs, guardrail hooks, tracing | **refuse** orchestration (one person, one laptop); **adopt** the tracing discipline locally → `voice-08`, `src/telemetry.js` |

**Lesson taken:** the local-first leaders are *platforms*, and the platform features
(multi-user, workflow builders, model hubs) are the ones that conflict with this
product's identity. What transfers is the discipline underneath: bounded context,
relevant memory, retrieval that is measured.

### 3.3 Coding agents — the context and eval frontier

| Project | What it is genuinely best at | Verdict |
|---|---|---|
| **Claude Code** | Subagents with their own context window: noisy work stays in the child, only the conclusion returns. Plus focusable compaction and hooks | **adopt** the principle at laptop scale → `mind-06-parallel-read-tools`; compaction → `mind-02`; hooks → `harness-01` |
| **Codex CLI** | Extract-pattern compaction with an explicit threshold | covered → `mind-02`, `agentic-11` |
| **Gemini CLI** | Summarise-then-**verify** compaction, keeping ~30% of the tail verbatim, firing early (~50% of the window) | covered conceptually by `mind-02`; the two-pass summary and verbatim tail are noted here as the shape `mind-02` should implement |
| **Aider** | A repo map: send the shape of the codebase, not the codebase | covered → `mind-02`, `pinch-015` |
| **Cline / Roo Code / OpenCode** | Explicit plan-vs-act modes and checkpoint rewind | covered → `agentic-01-phased-flow`, `pinch-017-validated-restore` |
| **promptfoo** | Evals as declarative data, run in CI, failing a build on a regression | **adopt** → `lead-10-conversation-quality-bench` |
| **Ragas** | Named answer metrics: faithfulness, answer relevance, context precision | **adopt** faithfulness → `pinch-027-grounded-answer-check` and the scoring classes in `lead-10` |
| **Langfuse / OpenTelemetry GenAI conventions** | One span per pipeline stage, correlated by trace id | **adopt** the shape, refuse the SaaS → `voice-08` writes local spans; nothing leaves the machine |

**Lesson taken:** the coding-agent world solved the *context* problem publicly and
in detail, because a coding session is the most context-hostile workload there is.
The transferable rules are: parallelise noisy sub-work, compact on a measured
threshold with a verified summary, and never trust a long session.

### 3.4 Inference layer

| Project | What it is genuinely best at | Verdict |
|---|---|---|
| **llama.cpp** | Prompt/KV cache reuse (`--cache-reuse`, host-RAM prompt cache), draft-model speculative decoding, correct defaults for both | **adopt both** → `mind-04-prefix-cache-residency`, `mind-05-draft-model-speculation` |
| **Ollama** | `keep_alive` residency, and JSON Schema in `format` for constrained decoding | **adopt** → `mind-04`, `reason-03-constrained-tool-arguments` |
| **vLLM / SGLang** | Guided decoding backends and continuous batching | evidence only — server-class tools; the *technique* is what `reason-03` takes, with no new dependency |
| **Outlines / xgrammar / Instructor** | Grammar-constrained generation as a sampling property rather than post-processing | **adopt** conceptually → `reason-03` |
| **microsoft/LLMLingua** | Up to 20x prompt compression with small measured quality loss | **refuse** — a second model rewriting the user's own words before the resident model reads them is a new failure mode for a local-first product; compressing *history* is `mind-02`'s job, without a model |
| **GPTCache and semantic answer caches** | Millisecond answers for repeated questions | **refuse** — a stale answer and a fresh one are indistinguishable in the panel. `mind-01-intent-fast-path` already serves the repeated deterministic queries, correctly |

### 3.5 Computer use

| Project | What it is genuinely best at | Verdict |
|---|---|---|
| **UI-TARS** | Pixel grounding for any GUI, strong OSWorld scores | covered → `lead-02-accessibility-tree-grounding` (tree first, pixels as a labelled fallback) |
| **OpenAdapt** | Record → compile → **verify against the system of record** → stop on mismatch | covered → `skill-01`, `skill-02` (shipped), `skill-03`, `lead-04-journal-first-undo` |
| **browser-use / Playwright MCP** | Deterministic protocol calls instead of a model guessing coordinates | **adopt the ordering rule**: a stable selector or protocol beats an accessibility node, which beats a pixel. `laptop-06` must implement that order |
| **OmniParser** | Screenshot parsing into elements | refused as a first choice — it is `laptop-06`'s last resort, not its architecture |

### 3.6 Safety and permissions

| Project | What it is genuinely best at | Verdict |
|---|---|---|
| **NeMo Guardrails / LLM Guard** | Programmable input and output rails | **refuse** as an added model in the gate: deterministic risk tiers plus a single-use approval already beat a classifier that can be argued with. `lead-08-approval-integrity` is the stronger direction |
| **CaMeL-style capability control** | Binding a capability to the *data flow* that requested it | covered in spirit by `lead-08`; noted as the right theory for why an approval must be session-bound and single-use |

---

## 4. Does this improve performance? The ten items, and the bar each must clear

Ten items were added to `.github/roadmap.json`. Seven are speed or answer-quality,
three are measurement. None of them is filable until its prerequisite closes, and
each carries the three-line contract the repository already enforces.

| Item | Borrowed from | Baseline | Target | Must not regress |
|---|---|---|---|---|
| `mind-04-prefix-cache-residency` | llama.cpp cache reuse, Ollama `keep_alive` | not instrumented; unstable prefix + no residency (reference: 962 ms → 54 ms warm prompt-eval) | prefill p50 **−60%** from turn 2; cache hit ≥85% | the model must still know the date; a cold turn may not get slower |
| `mind-05-draft-model-speculation` | llama.cpp draft models | one forward pass per token (reference: 1.4x–3.2x available) | decode **+40%** with identical greedy output | identical answers at temperature 0; off by default; refused where the probe measures a slowdown |
| `mind-06-parallel-read-tools` | subagents and parallel tool execution in hosted and coding agents | serial loop, N reads = N round trips | **−35%** wall clock on multi-read turns | no `act` call ever concurrent or out of order |
| `ear-04-variable-window-stt` | Moonshine v2 variable-length streaming encoder | fixed 30 s padding (reference: 401.7 ms vs 65.1 ms at 1 s audio) | short-utterance transcript p50 **≤ 200 ms**, WER within 1 pp | WER, locality, and the existing Whisper path |
| `reason-03-constrained-tool-arguments` | Ollama JSON Schema / xgrammar, Outlines | free-text parse + full repair round trip | malformed args **< 1%**, zero schema-repair rounds | `reason-02` validation and the risk tier stay untouched |
| `voice-08-latency-waterfall` | Home Assistant Wyoming, TEN, OTel GenAI spans | total duration only, 0 stages persisted | 5 stages on **100%** of turns, ≤5 ms overhead | never delay a turn; never record text or audio |
| `lead-10-conversation-quality-bench` | promptfoo, Ragas | 0 answer-quality assertions | 60 turns, offline, **< 5 min**, ≥30 deterministically gated | must stay inside the CI budget; a change names the failing turns |
| `pinch-026-hybrid-retrieval-gate` | Open WebUI, AnythingLLM, RRF practice | BM25 only | recall@5 **+8 pp** at p95 ≤150 ms, or the stage is rejected in writing | citations still resolve; no network on the retrieval path |
| `pinch-027-grounded-answer-check` | Ragas faithfulness, OpenAdapt's read-back | citations attached, never checked | unsupported cited sentences **−50%**, abstain precision ≥90%, ≤150 ms | a supported answer keeps its citation verbatim |
| `pinch-028-memory-recall-budget` | Letta, mem0 | `slice(-40)` by recency | injected memory tokens **−60%**, recall@5 ≥90% | nothing is deleted; pinned facts always present |

### Why these ten and not forty

The filter was deliberately harsh, because a roadmap that accepts everything is a
roadmap nobody finishes:

1. **Somebody else already measured it on comparable hardware.** A technique with
   no number behind it is a guess, and this repository does not file guesses.
2. **It fixes something this checkout can be shown to do badly** — §2 is the
   evidence list, and every item maps to a row in it.
3. **It does not add a service, a dependency or a cloud path.** Anything that
   required one was refused in §3 even where it would have been faster.
4. **It cannot be satisfied by making an answer worse.** Every speed item names the
   quality floor it may not cross, and `lead-10` is the bench that enforces it.

---

## 5. What the comparison says about sequencing

The dependency graph that comes out of these ten items is itself the finding:

```
mind-01 (shipped) ──► mind-04 ──► mind-05
        └──────────► mind-06

pinch-022 (shipped) ──► lead-10 ──► (the floor every later speed claim is measured against)
        ├──────────► pinch-026
        ├──────────► pinch-027
        └──────────► pinch-028

ear-01 ──► ear-04
voice-01 ──► voice-08
reason-02 ──► reason-03
```

`lead-10` is the item that should ship early, not last: without it, every other
item's "must not regress" line is an assertion rather than a measurement. The same
argument applies to `voice-08` — a latency budget nobody records is a wish.

Measurement first is the opposite of how feature roadmaps are usually ordered, and
it is the only ordering where the speed work can be *proved* rather than announced.

---

## 6. Honest limitations

- **Reference measurements are not this machine.** 17.7x prompt-cache, 1.4x–3.2x
  speculation, 401.7 ms versus 65.1 ms ASR latency, +7.4% hybrid NDCG — all from
  other hardware and other corpora. Each item therefore requires the number to be
  reproduced locally before it ships, and `mind-05` is allowed to conclude "slower
  here" and ship nothing.
- **The retrieval evidence genuinely conflicts.** One public implementation
  measured reranking at +0.8% nDCG for 20x the latency; another at +27% nDCG@10 for
  ~90–128 ms. That disagreement is the reason `pinch-026` is a gate with a written
  rejection path rather than a build order.
- **A local model is a weak judge.** `lead-10` says so in its own acceptance
  criteria and puts the gate on deterministic checks.
- **Nothing here was user-tested.** No competitor was installed, no journey was
  timed with a person in front of it. Judgment about "feels slower" remains
  unproven until `voice-08` produces waterfalls from real turns.
- **This is a purposive sample.** Thirty projects, chosen to cover every axis
  twice, is defensible and finite. It is not a census of every assistant on GitHub,
  and the next sweep should re-read the set rather than trust this one.

---

## 7. Sources for every number quoted

| Claim | Source |
|---|---|
| Warm prefix 962 ms → 54 ms prompt-eval (723 tokens); Ollama `keep_alive` default is a 5-minute unload that dumps the cache | [Prompt Caching — Ollama in Action](https://leanpub.com/read/ollama/prompt-caching) |
| Up to 93% TTFT reduction from cached prefixes; `--cache-reuse` and host-RAM prompt cache behaviour | [Understanding `--cache-ram` in llama.cpp](https://jessequinn.info/blog/llama-cpp-cache-ram-prompt-caching) |
| Static-first ordering and residency as the highest-leverage settings for local agents; compaction resets the cache | [Speed Up a Local Coding Agent](https://llmconfigurator.com/en/guides/coding-agents/speed-up-local-coding-agent) |
| Speculative decoding 64 → 206 t/s (3.2x); draft depth 3 optimal; depth 8 slower than none | [llama.cpp benchmarks on Apple Silicon](https://hiesch.eu/blog/llamacpp-benchmarks-speculative-decoding/), [llama.cpp discussion #10466](https://github.com/ggml-org/llama.cpp/discussions/10466) |
| Speculative decoding can be dramatically *slower* on Vulkan/UMA iGPU when both models share the device | [llama.cpp issue #23126](https://github.com/ggml-org/llama.cpp/issues/23126) |
| Ollama ≥0.5 accepts a JSON Schema in `format`; xgrammar constrained decoding; ~10–50 ms/token sampling overhead | [Structured output: JSON mode vs grammar-constrained decoding](https://dev.to/tech_nuggets/structured-output-from-llms-json-mode-function-calling-and-grammar-constrained-decoding-355d), [Local LLM JSON output debugging](https://www.aijsonmedic.com/blog/local-llm-json-output-debugging) |
| Moonshine v2 TTFT at 1 s audio: 65.1 ms (Small) vs 401.7 ms (Whisper Small); 129.8 ms vs 2173 ms (Large v3); WER 7.8% vs 8.6% | [Moonshine v2 paper](https://download.moonshine.ai/docs/moonshine_streaming_paper.pdf), [Moonshine model card](https://modelslab.com/blog/audio-generation/moonshine-vs-whisper-asr-real-time-speech-2026) |
| Wyoming pipeline stages with per-stage latency targets, ~750–1100 ms to first audio when fully pipelined | [HA local voice in 2026](https://botmonster.com/smart-home/build-private-local-ai-voice-assistant-2026/), [HA 2026.8 voice](https://www.privacysmarthome.com/guides/home-assistant-2026-8-local-ai-voice-ready-replace-cloud-2026/) |
| Streaming ASR moves STT time to ~0–0.5 s instead of ~1–2x the utterance length | [wyoming-faster-whisper streaming ASR thread](https://www.reddit.com/r/homeassistant/comments/1u3rzxd/i_forked_wyomingfasterwhisper_to_add_true/) |
| Hybrid retrieval +7.4% NDCG (WANDS); BM25 0.644 → RRF 0.695 → +rerank 0.816 recall@5 | [Hybrid search for RAG](https://denser.ai/blog/hybrid-search-for-rag/) |
| Reranking at +0.8% NDCG for ~20x latency (698 ms) — the counterexample | [hybrid-retrieval-search evaluation](https://github.com/rahin1301/hybrid-retrieval-search) |
| Reranking adds 100–300 ms and is the largest precision lever when it works | [Hybrid RAG: BM25 + RRF guide](https://aiworkflowlab.dev/article/how-to-build-hybrid-search-rag-bm25-rrf-fusion-cross-encoder-reranking) |
| LLMLingua up to 20x compression, ~2% loss; 20–30% end-to-end latency reduction | [microsoft/LLMLingua](https://github.com/microsoft/LLMLingua), [Microsoft Research](https://www.microsoft.com/en-us/research/blog/llmlingua-innovating-llm-efficiency-with-prompt-compression/) |
| Compaction strategies across Claude Code, Codex CLI, Gemini CLI, OpenCode, OpenHands; thresholds and the summarise-then-verify pattern | [Context compaction showdown](https://codex.danielvaughan.com/2026/04/10/context-compaction-showdown-coding-agents/) |
| Subagents keep the main context clean; compaction loses early constraints | [Claude Code context management](https://academy.claude.com/courses/claude-code-101/context-management) |

---

## 8. What happens next

The manifest is the only thing the queue reads, so the sweep ships as ten reviewed
entries plus the two document updates that describe them:

- `.github/roadmap.json` — 10 items, 90 → 100, validated by `scripts/validate-roadmap.js`
  and `test/frontier-roadmap.test.js`.
- `docs/COMPETITIVE-FRONTIER.md` §10 — the new frontier items, with the defect that
  justified each one.
- `docs/VOICE-CONTROL-ROADMAP.md` — `voice-08` and `reason-03` added to the
  requirement tables, the waves and the latency budget.
- This document — the comparison and the refusals, so the next sweep argues with
  evidence instead of starting from zero.

If only one of the ten ships, it should be `lead-10-conversation-quality-bench`:
the repository already wins on honesty, and honesty without a score is a claim.
