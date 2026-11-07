# The frontier: what the best products do, what nobody does, and what we build

Companion to [VOICE-CONTROL-ROADMAP.md](VOICE-CONTROL-ROADMAP.md). That document
audits Quasnooze against itself — what it can do today and what it cannot. This
one audits it against the field, and picks the small number of things worth
building that would make it the best version of this product rather than a worse
copy of someone else's.

Star counts are from 2026-11-04 and are context, not an argument.

---

## 1. Who is actually good at what

| Project | ★ | Category | Best at | Cannot do |
|---|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 394k | Personal assistant harness | Reach: 20+ chat channels, native apps, swap-in models, one-line install | Desktop control breadth and measured voice latency are not its core; skills are instructions a model re-reads |
| [openinterpreter/open-interpreter](https://github.com/openinterpreter/open-interpreter) | 69k | Local code agent | Turning intent into code and running it locally | No voice loop, no approval model, no OS-level action vocabulary |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | 55k | On-device STT | Streaming-local transcription, runs anywhere | Not an assistant |
| [coqui-ai/TTS](https://github.com/coqui-ai/TTS) | 46k | Local TTS | Battle-tested synthesis (unmaintained since 2024) | Not an assistant; heavy dependency tree |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | 26k | On-device STT | Fast CTranslate2 Whisper | Not an assistant |
| [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | 17k | Voice agent framework | Composable real-time pipelines, transports, client SDKs | It is a framework: you bring the agent, the permissions and the machine |
| [livekit/agents](https://github.com/livekit/agents) | 15k | Realtime voice framework | **Semantic turn detection**, noise cancellation, telephony, MCP, test judges | Same: infrastructure, not a product that acts on your laptop |
| [bytedance/UI-TARS](https://github.com/bytedance/UI-TARS) | 12k | GUI grounding model | Vision-language GUI targeting, OSWorld scores | A model, not an assistant; no permission model |
| [kyutai-labs/moshi](https://github.com/kyutai-labs/moshi) | 11k | Full-duplex speech model | **160 ms theoretical / ~200 ms practical** end-to-end, both streams concurrent | Speech-only, model-only, GPU-bound; no tools, no OS |
| [rhasspy/piper](https://github.com/rhasspy/piper) | 11k | Local TTS | Fast, small, offline neural speech | Not an assistant |
| [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | 11k | VAD | Enterprise-grade local voice activity detection | A component |
| [hexgrad/kokoro](https://github.com/hexgrad/kokoro) | 10k | Local TTS | 82M-parameter quality-per-byte | Not an assistant |
| [dscripka/openWakeWord](https://github.com/dscripka/openWakeWord) | 3k | Wake word | On-device detection with a tiny always-on cost | A component |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | — | Verified computer use | **Records a task once, compiles a program, verifies against the system of record**; 22.5 s vs 36.5 s and 18/18 vs 62/63 in its own benchmark | Not conversational; you record by hand; no assistant, no voice |

Read the last column twice. Every one of these is excellent at one axis and
structurally unable to be the thing Quasnooze is trying to be: **a local
assistant that hears you, acts on your machine, and cannot act without you.**

---

## 2. Twelve dimensions, honestly scored

● = leads the field, ◐ = competitive, ○ = behind, – = does not apply.

| Dimension | Best in field | Moshi | LiveKit | UI-TARS | OpenAdapt | OpenClaw | **Quasnooze today** |
|---|---|---|---|---|---|---|---|
| First sound after speech | Moshi ~200 ms | ● | ◐ | – | – | ○ | ○ ~1.5 s+ |
| Turn-taking / barge-in | LiveKit semantic | ● | ● | – | – | ○ | ○ silence only |
| On-device STT | whisper.cpp | ● | ◐ | – | – | ◐ | ◐ optional HTTP |
| On-device TTS | Piper / Kokoro | ● | ◐ | – | – | ◐ | ○ Windows only |
| Wake word | openWakeWord | – | – | – | – | ◐ | ◐ string match |
| OS control breadth | UI-TARS / OpenAdapt | – | – | ● | ● | ◐ | ○ lock + shell |
| UI grounding | UI-TARS | – | – | ● | ● | ○ | ○ screenshot only |
| Skill replay w/o model | OpenAdapt | – | – | – | ● | ○ | ○ none |
| Verification of outcome | OpenAdapt | – | – | ○ | ● | ○ | ○ return value only |
| Permission model | **nobody** | – | – | ○ | ◐ | ◐ | ● risk tiers + previews |
| Honest failure reporting | **nobody** | ○ | ○ | ○ | ● | ○ | ● typed failures |
| Measurement discipline | OpenAdapt, LiveKit | ◐ | ● | ● | ● | ○ | ◐ p50/p95, no voice evals |

We lead on exactly two things — the permission gate and honest failure — and
those are the two that matter most once an assistant can type into your apps and
click your buttons. We are last on four: latency, turn-taking, OS breadth, and
measured skill replay.

That is the shape of the opportunity. It is not "be Moshi". It is: **be the only
assistant whose speed and capability are matched by its proof that it did what it
said.**

---

## 3. The thing nobody has

Three products each own a third of one idea and none of them join it:

- **OpenAdapt** proves that a recorded, verified program beats an agent guessing
  click-by-click — 18/18 versus 62/63, 22.5 s versus 36.5 s, $0 versus $0.08. But
  you record it by hand, outside a conversation, and it does not talk.
- **OpenClaw** has skills, but they are prose instructions a model re-reads on
  every run, so every execution is as slow and as variable as the model.
- **Pipecat / LiveKit / Moshi** give you a conversation with no memory of how a
  task was performed, so the thousandth time you say "tidy my downloads" costs
  the same as the first.

Nobody compiles a *conversation* into a verified, replayable, permission-scoped
program. That is `skill-01` + `skill-02` + `skill-03`, and it is the first item
in this roadmap that would not be a fast follower — it would be the only
implementation of the idea in a local-first personal assistant.

The second, smaller moat: **the same machine both listens and acts.** A cloud
voice agent can be fast, and a local computer-use agent can be capable, but only
a local assistant can keep the audio, the screen and the action in one trust
boundary — which is what makes a 150 ms barge-in and a per-action approval gate
possible at the same time.

---

## 4. The frontier set

Twelve items, each naming the control-floor work it builds on in the
[voice-control roadmap](VOICE-CONTROL-ROADMAP.md) as a dependency. No dates: an
item opens when its prerequisite closes, and the queue runs hourly. Each carries a
**Performance contract** — baseline, target, and the thing it is forbidden to
make worse.

### Speed and duplex

| Item | Borrowed from | Contract |
|---|---|---|
| `duplex-01-semantic-turn-detection` | LiveKit's semantic turn detection | false end-of-turn < 8%, endpoint p50 ≤ 250 ms, cut-off rate must not rise |
| `duplex-02-streaming-tts-first-audio` | Every low-latency hosted agent | first audio ≤ 250 ms after first token, no mid-word break, barge-in still ≤ 150 ms |
| `duplex-03-speculative-prefill` | VoiceMem's speculative prefetch | time-to-first-token p50 −30%, adoption ≥ 60%, wrong-answer rate +1 pp maximum |

### Ears

| Item | Borrowed from | Contract |
|---|---|---|
| `ear-01-local-streaming-stt` | whisper.cpp, faster-whisper | final transcript ≤ 300 ms, zero network bytes, WER within 2% of the whole-clip baseline |
| `ear-02-noise-robustness` | LiveKit noise cancellation | WER −20% relative on noisy audio, < 10% of one core, clean-audio WER must not regress |
| `ear-03-on-device-wake-model` | openWakeWord | < 1% of one core idle, ≤ 1 false accept/hour, first-word latency ≤ 500 ms |

### Hands

| Item | Borrowed from | Contract |
|---|---|---|
| `skill-01-conversation-skill-compiler` | OpenAdapt's program compilation, applied to a conversation | replay p50 < 300 ms with zero model calls, arguments byte-identical |
| `skill-02-verified-execution` ✅ **shipped** | OpenAdapt's read-back from the system of record | zero silent wrong-success in a 20-case fault-injection suite, +50 ms p95 per step — **measured: 20/20 verdicts, p95 0.69 ms** |
| `skill-03-drift-repair` | OpenAdapt's "stop, do not guess" | ≥ 90% of drifted runs recover or stop cleanly, zero misapplied runs |

### Mind

| Item | Borrowed from | Contract |
|---|---|---|
| `mind-01-intent-fast-path` ✅ **shipped** | Deterministic grammars in voice assistants | p50 < 400 ms for matched intents, ≥ 95% routing accuracy, 100% fall-through when unsure — **measured: 4.3 ms p50 end to end, 31/31 matched, 0/28 neighbours routed** |
| `mind-02-context-budget` | Streaming-memory compression | prefill p50 −40% at turn 20, 100% pinned-fact retention, no eval regression |
| `mind-03-model-router` | PilotDeck-style routing (~70% cost cut) | overall p50 −35%, task success at or above baseline, escalation < 15% |
| `mind-07-first-token-deadline` | *The Tail at Scale*'s hedged requests, applied to a model chain instead of a datacenter | silent-primary worst case 180,000 ms → 1.2 s + one hop; `firstTokenMs` p95 < 3 s on a dead primary; **0** cutovers after the first delta |

### The first one shipped

`mind-01` landed in this branch rather than being filed, because it is the
cheapest place to prove the contract is real: five deterministic intents
(`time_now`, `calculator`, `remember`, `add_task`, `remind`) now answer without
touching a model, and the turn still runs the same honesty guard, the same
telemetry and the same permission classification as every other turn.

| | before | after |
|---|---|---|
| "what time is it" | prefill + decode, ≥ 700 ms floor | **4.3 ms p50, 7.9 ms p95** (n = 50) |
| matched deterministic utterances | 0 of 31 phrasings | **31 of 31** |
| neighbouring phrasings wrongly acted on | n/a — the model judged them | **0 of 28** |
| off-switch | n/a | `QUASNOOZE_FAST_PATH=off` restores it exactly |

The evaluation, including the bugs it found and the honest gaps, is in
[FAST-PATH-EVAL.md](FAST-PATH-EVAL.md). The most useful thing it turned up was
not in the new code: `parseClock("99pm")` used to roll into a reminder four days
later, which is precisely the class of silent wrong answer the deterministic path
exists to remove.

---

## 5. What each leader is best at — and the lead we take from it

Parity is not the goal, so none of the items below is "match X". Each is defined
by the thing the leader structurally cannot do: a component has no product around
it, a framework has no machine to act on, a recorder has no conversation, and a
channel hub has no per-action discipline.

| Leader | Its best function | Why it does not transfer as-is | The lead we take |
|---|---|---|---|
| moshi | true full duplex at ~200 ms | GPU-bound, speech only, no tools | **`lead-01`** — duplex on the laptop CPU: ≤25% of one core, 150 ms barge-in, zero network bytes |
| livekit/agents | semantic turn detection, noise cancellation, test judges | a framework: you bring the agent and the permissions | `duplex-01` + `ear-02`, then `lead-01` |
| pipecat | transport abstraction and interruption handling | infrastructure, not a product | `voice-03` + `duplex-02` + `lead-01` |
| whisper.cpp / faster-whisper | local streaming transcription | a component | `ear-01` |
| openWakeWord | a tiny always-on wake model, trainable in under an hour | a component | `ear-03` |
| silero-vad | robust voice activity detection | a component | `voice-02` uses it |
| Piper / Kokoro | small, fast local synthesis | a component | `duplex-02` |
| UI-TARS | pixel grounding for any GUI | a model call per click, coordinates that cannot be replayed tomorrow | **`lead-02`** — accessibility tree first, stable selectors, pixels as a labelled fallback |
| OpenAdapt | record → compile → verify against the system of record, stop on mismatch | recorded by hand, not conversational, and nothing can be undone | `skill-01/02/03` + **`lead-04`** journal-first undo + **`lead-05`** teach-and-correct |
| OpenClaw | reach: twenty-plus channels, native apps, swap-in harness | breadth without per-approval discipline; skills are prose re-read every turn | **`lead-08`** approval integrity + **`lead-09`** portable skill files |
| open-interpreter | code as the action | no gate, no voice, no verification | not followed — typed tools beat generated code for a laptop |
| vibe-kanban / task agents | board-driven execution | process, not capability | not followed — one person, one laptop |

### The lead set

Nine items, each waiting on the frontier item it builds on — a CPU duplex loop
needs local STT, an accessibility resolver needs a grounding bench, a portable
skill file needs a compiler that verifies. Every one carries a Performance
contract like the rest of the roadmap.

| Item | The lead, in one line | Worst-case contract |
|---|---|---|
| `lead-01-cpu-duplex` | duplex without a GPU | barge-in ≤150 ms, endpoint ≤250 ms, ≤25% of one core, zero network bytes |
| `lead-02-accessibility-tree-grounding` | ground on the tree before the pixels | 0 model calls for a named control, p50 ≤120 ms, ≥95% element accuracy |
| `lead-03-proof-carrying-replies` | the read-back reaches the user, the API and the export | 100% of act actions carry a state; 0 contradicted actions described as done |
| `lead-04-journal-first-undo` | the undo record exists before the action | 100% coverage, undo verified in 95% of 20 scenarios, ≤20 ms p95 |
| `lead-05-teach-and-correct-skills` | teach by talking, correct mid-run, diff approved | ≥90% of 15 corrections applied as approved diffs; 0 silent mutations |
| `lead-06-laptop-control-bench` | publish a bench anyone can run | 40 tasks, ≤5 min, deterministic, four measurements per task |
| `lead-07-work-memory` | remember the work, not just the words | 90% recall@5, p50 ≤250 ms, 0 answers citing a non-existent action |
| `lead-08-approval-integrity` | an approval is single-use, session-bound, expiring | 0 of 20 adversarial cases satisfied out of band |
| `lead-09-portable-skill-format` | skills that travel and can be checked | byte-identical round-trip, 100% of unsafe imports refused |

Two of these are not features at all: `lead-06` is how the category is measured,
and `lead-09` is how it spreads. A project that only ships features is
out-featured by the next model release; a project that defines the bench and the
file format is not.

---

## 6. The non-degradation law

A feature that makes the product faster and less trustworthy is not a feature.
Every frontier item therefore carries the same three lines, and the build fails
without them:

1. **Baseline** — what happens today, stated as a measurement or as "not
   implemented". A baseline of "slow" is not a baseline.
2. **Target** — a number, not an adjective. "Faster" fails the test that reads
   these items; "p50 −30%" passes it.
3. **Must not regress** — the specific existing behaviour the change is forbidden
   to damage, usually accuracy, approval coverage, or a latency that another item
   already established.

`test/frontier-roadmap.test.js` enforces the shape and the number. It cannot
enforce honesty about the number — that is what the measurement plan in §7 is for.

Three rules follow from this and apply to review, not just to the roadmap:

- **A speed win that costs accuracy does not ship.** `mind-03` is explicitly
  gated on task success, not latency.
- **An accuracy win that costs latency must say so**, and the latency budget in
  `voice-01` decides whether it is acceptable.
- **A capability that cannot be verified does not get to claim success.** That is
  `skill-02`, applied to itself.

---

## 7. How we prove any of this

The repository already has the pattern — `docs/RETRIEVAL-EVALUATION.md` is a
labelled corpus and a reproducible report, not a paragraph of praise. The frontier
needs the same discipline, so this document is the *plan* and not the evidence:

| Claim | Evidence required before it may appear in the README |
|---|---|
| voice latency | per-stage p50/p95 with sample counts, `voice-01`, on a named machine |
| speech accuracy | WER and command accuracy on a published corpus, `voice-05` |
| skill replay speed | a scoreboard with per-run timings and model-call counts, `skill-01` |
| verification | a fault-injection suite whose failures are published, `skill-02` |
| routing quality | the eval suite and the escalation rate, `mind-03` |

Until a row has its evidence, the README says nothing about it. That rule is the
reason this product can make claims the rest of the field cannot.

---

## 8. What we will still refuse

| Temptation | Why not |
|---|---|
| Ship a cloud speech-to-speech model for the demo-quality latency | It sends the microphone to a vendor. The entire proposition is the opposite. |
| Let the agent click freely because grounding models got good | Good is not verified. One approved click with a read-back beats ten confident ones. |
| Autonomous background execution | An assistant that acts while you are not watching is a different product with a different consent model. |
| Multi-agent orchestration | One person, one laptop. Every extra agent is another failure mode the user has to debug. |
| A vector database for memory | BM25 + FTS covers a personal corpus without a second service. Revisit only with a measured recall gap. |
| Benchmark numbers from a warm cache on a borrowed GPU | The budget is the path the user actually has. |
| Ask every installed model the same question and let a judge pick the winner | On one laptop GPU the candidates evict each other: every model after the first costs a 5–30 s swap-in, and the judge is another generation on top. It is the most expensive verifier in the field, deployed against the one number it makes worse. |
| Keep three or four specialist models resident so switching is free | That is a multi-GPU cloud property. The sweep below already refuses a second resident model for everything, for the same reason: memory is the scarce resource on the machine this runs on. |
| Let the small model emit a `[PASS]` token where it admits it cannot answer | Self-reported confidence is the routing literature's canonical trap — a wrong `PASS` taxes every easy turn with an escalation, and a model that never emits one leaves the mechanism dead weight. Escalate on checks code can run (`mind-07`), not on the model grading itself. |

---

## 9. Order of work

1. **Control floor** — `voice-*`, `laptop-*` (shipping now). Without hands, none of
   this matters.
2. **Judgement** — `reason-*`, `voice-04/05`. Without verification, capability is a
   liability.
3. **Frontier** — `duplex-*`, `ear-*`, `skill-*`, `mind-*`, each behind the
   dependency that makes it buildable.
4. **Leadership** — `lead-*`, only buildable on top of the frontier above.

There are no dates in this list. Items file when their prerequisites close and a
slot is free; the ordering lives in `depends_on`, where the queue can enforce it.

The queue files these automatically; `skill-01` will not appear until `reason-01`
and `laptop-05` are closed, because a skill compiler that cannot verify a trace or
undo a mistake is exactly the wrong first version.

---

## 10. The sweep of 2026-11-05: what the rest of the field already proved

The first nine sections compare Quasnooze against the projects that own one axis
each. This sweep asks a different question: **which improvements have already been
measured by somebody else, on hardware like ours, and are simply missing here?**

Twenty-eight projects were re-read from their own documentation, plus this
checkout, end to end. The full comparison, including the projects that were
deliberately not adopted, is in
[`research/2026-11-05-ASSISTANT-FRONTIER-SWEEP.md`](research/2026-11-05-ASSISTANT-FRONTIER-SWEEP.md).
Five items came out of it, and every one of them is a defect in this repository
that a competitor has already published a number for.

### The four defects, with the evidence that found them

| Defect, in this checkout | What the field already measured | Item |
|---|---|---|
| `src/prompt.js` puts the clock and up to forty memory facts into the *system* prompt, and `src/brain.js` sends no `keep_alive`, so Ollama's five-minute unload discards the KV cache. Every turn can pay a full re-prefill. | A warm prefix measured 962 ms → 54 ms prompt-eval on a 723-token prompt (17.7x); host-RAM prefix caching claims up to 93% TTFT reduction. Static-first ordering plus residency is described as the single highest-leverage setting for a local agent. | `mind-04-prefix-cache-residency` |
| `src/agent.js` runs tool calls in a serial `for` loop, so three independent reads cost three round trips. | Every agent that fans out work (coding agents' subagents, parallel tool execution in hosted assistants) does the same thing: parallelise what has no ordering, serialise what has. | `mind-06-parallel-read-tools` |
| Tool arguments are free text parsed after the fact; a bad comma costs a whole repair round trip. | Ollama has accepted a full JSON Schema in `format` since 0.5 and constrains decoding with xgrammar — effectively total schema compliance for 10–50 ms per token of sampling overhead. | `reason-03-constrained-tool-arguments` |
| The Whisper path pads every clip into a fixed 30-second window, so a two-second command costs a paragraph's encode. | Time-to-first-token at one second of audio: 401.7 ms (Whisper Small) versus 65.1 ms (a variable-length streaming encoder of the same class), at a better WER — 8.6% versus 7.8%. | `ear-04-variable-window-stt` |

### The two things missing rather than broken

| Gap | Who already does it | Item |
|---|---|---|
| Nothing measures whether an answer was **right**. Retrieval, the fast path, readiness and the laptop bench are all scored; answering is not. | Every serious assistant stack ships a versioned eval corpus with a deterministic runner, and the ones that compound quality keep it vendor-free. | `lead-10-conversation-quality-bench` |
| A turn's total duration is recorded; the five stages a voice turn actually spends its time in are not. | Local-voice pipelines publish an expected latency per stage and are debugged stage by stage; a pipeline you cannot break down is a pipeline you cannot tune. | `voice-08-latency-waterfall` |

### Two performance items that are *not* in the frontier set

`pinch-026-hybrid-retrieval-gate` and `pinch-027-grounded-answer-check` are product
hygiene rather than a lead, so they sit in the `pinch-*` family: the first is the
measurement §8 already demanded before anyone may add a second retriever, and the
second extends the honesty guard from *actions* to *sources*. Neither is allowed to
make an answer slower and less true at the same time.

### The same three lines, applied to a borrowed number

Every item above carries a Baseline, a Target and a Must-not-regress line, and the
borrowed number is never adopted as our target:

- A **reference measurement** on someone else's machine is context, not a promise.
  `mind-05-draft-model-speculation` exists because a 1.4x–3.2x win is real on the
  right hardware — and because the same reports show a Vulkan/UMA regression where
  the draft model made generation dramatically *slower*. The probe decides.
- A **reranker** measured at +0.8% nDCG for 20x the latency in one public
  implementation, and at +27% nDCG@10 in another, is not a decision. The corpus
  decides, per stage, and a rejected stage is removed rather than left behind a
  flag.
- A **smarter memory** that injects forty facts "just in case" is the failure this
  roadmap exists to prevent: `pinch-028-memory-recall-budget` may only cut tokens
  while keeping recall above 90%, and it may never delete a fact to get there.

### What this sweep refused

| Temptation | Why not |
|---|---|
| An answer cache keyed on embedding similarity | Stale answers are indistinguishable from fresh ones, and a personal assistant's state changes constantly. The deterministic fast path (`mind-01`) already covers the queries where a cache would be correct. |
| Prompt-compression models (LLMLingua-class, up to 20x) | Compressing the *history* is `mind-02`'s job with pinned facts and no model in the loop. A second model that rewrites the user's own words before the real model reads them is a new failure mode for a local-first product. |
| A second resident model for everything | Memory on a personal laptop is the scarce resource. `mind-05` is opt-in precisely because the draft model costs as much RAM as it saves time. |
| Multi-turn context handled by one long session (the hosted-default) | The compaction research is unanimous that long sessions rot; `mind-02` plus `agentic-11-resume` already take the structured-handoff route instead. |
| A vector database, a tracing SaaS, or a hosted eval platform | Each is a service the user did not ask for. The lesson was the technique, not the dependency. |
