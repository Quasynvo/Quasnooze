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

Twelve items, all `not_before: 2026-12-01` so they queue behind the control floor
in [VOICE-CONTROL-ROADMAP.md](VOICE-CONTROL-ROADMAP.md). Each carries a
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
| `skill-02-verified-execution` | OpenAdapt's read-back from the system of record | zero silent wrong-success in a 20-case fault-injection suite, +50 ms p95 per step |
| `skill-03-drift-repair` | OpenAdapt's "stop, do not guess" | ≥ 90% of drifted runs recover or stop cleanly, zero misapplied runs |

### Mind

| Item | Borrowed from | Contract |
|---|---|---|
| `mind-01-intent-fast-path` | Deterministic grammars in voice assistants | p50 < 400 ms for matched intents, ≥ 95% routing accuracy, 100% fall-through when unsure |
| `mind-02-context-budget` | Streaming-memory compression | prefill p50 −40% at turn 20, 100% pinned-fact retention, no eval regression |
| `mind-03-model-router` | PilotDeck-style routing (~70% cost cut) | overall p50 −35%, task success at or above baseline, escalation < 15% |

---

## 5. The non-degradation law

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
enforce honesty about the number — that is what the measurement plan in §6 is for.

Three rules follow from this and apply to review, not just to the roadmap:

- **A speed win that costs accuracy does not ship.** `mind-03` is explicitly
  gated on task success, not latency.
- **An accuracy win that costs latency must say so**, and the latency budget in
  `voice-01` decides whether it is acceptable.
- **A capability that cannot be verified does not get to claim success.** That is
  `skill-02`, applied to itself.

---

## 6. How we prove any of this

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

## 7. What we will still refuse

| Temptation | Why not |
|---|---|
| Ship a cloud speech-to-speech model for the demo-quality latency | It sends the microphone to a vendor. The entire proposition is the opposite. |
| Let the agent click freely because grounding models got good | Good is not verified. One approved click with a read-back beats ten confident ones. |
| Autonomous background execution | An assistant that acts while you are not watching is a different product with a different consent model. |
| Multi-agent orchestration | One person, one laptop. Every extra agent is another failure mode the user has to debug. |
| A vector database for memory | BM25 + FTS covers a personal corpus without a second service. Revisit only with a measured recall gap. |
| Benchmark numbers from a warm cache on a borrowed GPU | The budget is the path the user actually has. |

---

## 8. Order of work

1. **Control floor** — `voice-*`, `laptop-*` (shipping now). Without hands, none of
   this matters.
2. **Judgement** — `reason-*`, `voice-04/05`. Without verification, capability is a
   liability.
3. **Frontier** — `duplex-*`, `ear-*`, `skill-*`, `mind-*` (2026-12-01 onward),
   each behind the dependency that makes it buildable.

The queue files these automatically; `skill-01` will not appear until `reason-01`
and `laptop-05` are closed, because a skill compiler that cannot verify a trace or
undo a mistake is exactly the wrong first version.
