# Voice control of a laptop — capability audit and roadmap

This is the working document behind the `voice-*`, `laptop-*` and `reason-*`
entries in [`.github/roadmap.json`](../.github/roadmap.json). It exists so the
queue cannot file a task nobody can trace to a decision, and so the next person
asking "why is typing text into another app so hard?" finds the answer instead of
re-litigating it.

**Scope:** talk to the machine, have it act on the machine, and keep the typed
path as fast and safe as the spoken one. **Not in scope:** multi-agent
orchestration, cloud-first realtime APIs, autonomous background execution. Those
are decisions, not oversights — see [§5](#5-what-was-rejected-from-the-prompt-corpus-and-why).

---

## 1. What this audit is based on

| Source | What was taken from it |
|---|---|
| This repository, end to end: 46 modules in `src/`, `public/`, `desktop/`, 54 test files, `docs/CAPABILITIES.json`, `docs/VOICE.md`, `docs/DESKTOP.md` | The "today" column. Every claim below names a file. |
| [`ai-boost/awesome-prompts`](https://github.com/ai-boost/awesome-prompts) — **Agent Ecosystem**, *Harness Engineering*, *Agent Memory*, *Agent Skills*, *Sandboxed Execution*, *Eval & Testing*, **Voice & Realtime Agents** | The technique column: what the current state of the art does that we do not. |
| `docs/market-snapshot.json`, `docs/research/` | Which gaps are also gaps in the comparison set, and which are our differentiators. |

The prompt corpus is a catalogue, not a specification. Most of it is frameworks
(agent SDKs, orchestration libraries) that assume a cloud model and a hosted
runtime — the opposite of this product's constraints. What survives the filter is
a short list of *techniques*, and those are what the roadmap borrows.

---

## 2. What Quasnooze can do today

| Area | Reality | Evidence |
|---|---|---|
| Conversation | Streaming text over SSE, typed failures (`RATE_LIMITED`, `TIMEOUT`, `STREAM_CUT`…), honest "not sure" behaviour | `src/server.js`, `src/agent.js`, `src/failure.js` |
| Reasoning | Local Ollama by default; openai-compatible provider when configured; runtime model switching | `src/brain.js`, `src/model-choice.js` |
| Tools | **24**: shell, read/write file, list dir, grep, project scan, calculator, time, memory (remember/recall/forget/search), document search, web search, tasks, reminders, schedules, open URL, screenshot, system lock/sleep | `src/tools.js` |
| Permissions | Deterministic risk tiers — `read` runs, `act` asks, `blocked` stays blocked — with structured action previews | `src/risk.js`, `src/guard.js`, `src/action-preview.js` |
| Voice in | Browser `SpeechRecognition`; Windows `System.Speech` with an opt-in wake phrase; optional Whisper HTTP for voice notes | `src/voice.js`, `desktop/Companion.cs` |
| Voice out | Windows native synthesis only; scripted silent preview in the browser | `desktop/Companion.cs`, `public/cosmic.js` |
| Audio visuals | Five-state canvas engine, local FFT when the mic is enabled, reduced-motion fallback | `public/visualizer.js`, `public/audio-input.js` |
| Memory / retrieval | Session store, remembered facts, zero-dependency BM25 document index with citations | `src/store.js`, `src/documents.js`, `src/citations.js` |
| Channels | Web, Telegram, Discord, Slack, WhatsApp | `src/channels/` |
| Diagnostics | Local readiness, latency baseline, **per-turn p50/p95 already recorded** | `src/telemetry.js`, `src/readiness.js` |
| Laptop control | Lock and sleep. That is the entire OS surface. | `src/tools.js:system_control` |

Read that last row twice. The product is called a personal assistant that runs on
your computer, and the only thing it can do to the computer is lock it. Every
"control my laptop with AI" promise currently resolves to a shell command, which
is where both accuracy and safety are worst.

---

## 3. The requirement set

Thirty capabilities, grouped. "Today" is honest: **have**, **partial**, or
**missing**.

### 3.1 Speaking and being heard

| # | Requirement | Today | Item |
|---|---|---|---|
| 1 | Speech is captured in the browser and on Windows | have | — |
| 2 | The assistant knows when you stopped talking | **missing** | `voice-02` |
| 3 | Partial words appear while you speak | partial (browser only, may leave device) | `voice-02` |
| 4 | You can talk over it and it stops | **missing** | `voice-03` |
| 5 | Wake phrase gating that is opt-in and not a lock | partial (Windows only) | `voice-04` |
| 6 | It asks instead of guessing on ambiguous speech | **missing** | `voice-06` |
| 7 | Speech accuracy is measured, not asserted | **missing** | `voice-05` |
| 8 | "Do it again", "the second one" work | **missing** | `voice-07` |
| 9 | Response latency is measured stage by stage | partial (total only) | `voice-01-latency-budget`, `voice-08-latency-waterfall` |
| 10 | It speaks back on every surface, not just Windows | **missing** | *deferred — see §6* |

### 3.2 Acting on the machine

| # | Requirement | Today | Item |
|---|---|---|---|
| 11 | Volume, mute, play/pause, next/previous | **missing** | `laptop-01` |
| 12 | Launch an app, switch to a window, minimise it | partial (fixed allowlist, no focus) | `laptop-02` |
| 13 | Read and write the clipboard safely | **missing** | `laptop-03` |
| 14 | Type dictated text into the focused app | **missing** | `laptop-04` |
| 15 | Move, rename, trash files with undo | **missing** | `laptop-05` |
| 16 | Find an element on screen and click it | partial (`screenshot` only) | `laptop-06` |
| 17 | Lock and sleep | have | — |
| 18 | Shut down / restart | **missing, on purpose** | *not planned* |
| 19 | Repeat a known routine in one phrase | **missing** | `laptop-07` |
| 20 | Reminders, schedules, tasks | have | — |
| 21 | Media/file actions that can be undone | **missing** | `laptop-05` |

### 3.3 Judgement and trust

| # | Requirement | Today | Item |
|---|---|---|---|
| 22 | Multi-step work is planned before it runs | **missing** | `reason-01` |
| 23 | It never claims more than the tools returned | partial (honesty guard on prose) | `reason-01` |
| 24 | Malformed tool arguments are repaired, not crashed on | **missing** | `reason-02` |
| 25 | Destructive actions show a preview and need approval | have | `src/action-preview.js` |
| 26 | A wake phrase is never authentication | have (documented) | `docs/VOICE.md` |
| 27 | Plugins are not OS-sandboxed, and that is stated | have (documented) | `README.md` |
| 28 | Local ≠ encrypted, and that is stated | have (documented) | `README.md` |
| 29 | Every action leaves a local record | have | `src/telemetry.js` |
| 30 | The typed path is as fast as the spoken one | partial (SSE, no budget) | `voice-01` |
| 31 | Tool arguments are shaped by the schema at sampling time, not repaired after the fact | **missing** | `reason-03-constrained-tool-arguments` |

**Result:** 8 have, 4 partial, 19 missing. Eighteen roadmap entries address
twenty of the missing/partial rows; the ones that are not covered are named
explicitly in §6 rather than left to look forgotten.

---

## 4. The prompt corpus, compared technique by technique

Each row is a technique that appears in the Agent Ecosystem, Harness Engineering
or Voice & Realtime sections of `awesome-prompts`, judged against this product's
constraints: one person, one laptop, local model, zero runtime dependencies,
visible permissions.

| Technique | Verdict | Reasoning |
|---|---|---|
| **Cascaded streaming pipeline** (STT → LLM → TTS, ~750 ms TTFA) | **Adopt** → `voice-02`, `voice-01` | The one technique that decides whether a voice assistant is usable. We have all three pieces and no streaming between them. |
| **Turn-taking / barge-in** (MP-Bench calls it *when to speak vs stay silent*) | **Adopt** → `voice-03`, `voice-04` | Cheapest perceived-latency win that exists; requires the VAD from `voice-02`. |
| **Plan-and-execute with verification** | **Adopt, narrowed** → `reason-01` | Full planner graphs are overkill. What matters is refusing to claim an outcome the tool results do not support. |
| **Structured outputs + schema validation** (tool-use reliability) | **Adopt** → `reason-02` | Local 7B models produce malformed arguments constantly. A validator and one repair turn is the highest ratio of reliability to code. |
| **Evaluation harnesses for agent quality** | **Adopt, scoped** → `voice-05` | We already do this for retrieval (`docs/RETRIEVAL-EVALUATION.md`). Speech deserves the same discipline. |
| **Memory: episodic + semantic with compression** (A-MEM, MemOS, Letta lineage) | **Adopt, minimal** → `voice-07` | We need per-session referents, not a knowledge graph. Anything larger is a second product. |
| **Harness engineering: receipts / lifecycle events** | **Adopt, narrow** → `reason-01` | `harness-01` already covers policy events; this adds the user-visible claim check. |
| **Sandboxed execution** (containers, microVMs, per-tool jail) | **Adapt, documented** | Zero-dependency Node on a personal laptop cannot ship a VM. We have workspace confinement + risk tiers instead, and say plainly that plugins are not OS-sandboxed. |
| **Multi-agent orchestration** (CrewAI, Magentic-One, handoffs) | **Reject** | One person on one laptop does not have a team of agents to coordinate. It multiplies failure modes and cost for zero user benefit. |
| **Hosted realtime voice APIs** (speech-to-speech in the cloud) | **Reject** | Sends the microphone to a vendor. Contradicts the product identity; the browser path that does this today is already labelled as such. |
| **Autonomous background execution** (always-on loops, self-scheduling agents) | **Reject** | An assistant that acts while nobody is watching is the opposite of "your permission, first". Schedules already exist and are bounded. |
| **Vector-store memory stacks** | **Reject for now** | BM25 + FTS covers the personal corpus. Adding an embedding service adds a process, a download and a failure mode. |
| **Browser/computer-use agents** (browser-use, Artemis, phone-harness) | **Adapt, bounded** → `laptop-06` | The accessibility tree first, OCR second, one approved click. Never an autonomous click loop. |

The pattern: we take the techniques that reduce **latency** and **false claims**,
and refuse the ones that add **autonomy** or **off-device data**.

---

## 5. Speed: a budget, not an adjective

Targets for a local 7B-class model on the same machine. These are what
`voice-01` measures and what a "fast" claim would have to beat.

| Stage | Target | Why this number |
|---|---|---|
| End of speech → endpoint decision | ≤ 300 ms | Below the ~400 ms where a pause starts to feel like an answer. |
| Endpoint → final transcript | ≤ 300 ms | Local Whisper on a short utterance; no network. |
| Transcript → first token | ≤ 700 ms | Typical local 7B prefill; the dominant cost, and the one worth optimising. |
| First token → first audio | ≤ 200 ms | Synthesis of one short clause. |
| **Total, end of speech → sound** | **≤ 1.5 s** | Above this, people repeat themselves. |
| Barge-in → silence | ≤ 150 ms | Above this, it sounds like it is ignoring you. |

The stages below are the ones `voice-08-latency-waterfall` records on every turn, so
a budget is a live number in `npm run health` rather than a table in a document.

Two constraints on how these are measured, because a latency claim is easy to
fake:

- p50 and p95 with **sample counts**, per stage. No headline number from four turns.
- No synthetic "warm" measurement. A budget is measured on the path the user
  actually has.

---

## 6. What is deliberately not in this wave

| Gap | Why not now | What would change that |
|---|---|---|
| Cross-platform TTS (browser, Linux, macOS) | Requires choosing an on-device synthesiser per platform, which is a dependency decision — the repo has zero runtime dependencies by design. | A browser-native `speechSynthesis` path that degrades honestly, filed when `voice-03` has landed and playback is interruptible. |
| Shutdown / restart | Irreversible, and the value over lock/sleep is small. The current tool says shutdown is deliberately absent. | Nothing, unless a user-facing reason appears. |
| Autonomous task execution while idle | Identity conflict. | Never, in this product. |
| Cloud speech-to-speech | Sends audio off-device. | Only as an explicitly labelled, separately consented provider. |

---

## 7. Delivery order

The queue files these automatically, and there is no calendar in it: a task opens
when the work it depends on is closed, and the open-issue cap decides how many are
on the board at once. The waves below are the order the work makes sense in, not a
schedule.

| Wave | Opens when | Items |
|---|---|---|
| **1 — the control floor** | immediately — no prerequisites | `voice-01-latency-budget`, `voice-02-endpointing-partials`, `laptop-01-media-volume`, `laptop-02-app-window-focus`, `laptop-03-clipboard-preview`, `laptop-04-typed-input`, `laptop-05-file-actions-undo` |
| **2 — judgement and gating** | immediately, as wave 1 fills the cap | `voice-04-wake-gating`, `voice-05-stt-accuracy-harness`, `reason-01-plan-verify`, `reason-02-tool-arg-validation`, `laptop-06-screen-grounding` |
| **3 — conversation quality** | `voice-03` and `voice-06` wait on `voice-02`; the rest have no prerequisites | `voice-03-barge-in`, `voice-06-repair-dialogue`, `voice-07-voice-memory`, `laptop-07-voice-macros` |
| **4 — measurement and shaping** | `voice-08-latency-waterfall` waits on `voice-01-latency-budget`; `reason-03-constrained-tool-arguments` waits on `reason-02-tool-arg-validation` | `voice-08-latency-waterfall`, `reason-03-constrained-tool-arguments` |

Nothing here is held behind a date. An item with a prerequisite waits for that
prerequisite to close; everything else files as slots free up, hourly, which is
why the board refills on its own.

---

## 8. Invariants every item inherits

These are not negotiable per item, and reviewers should reject work that trades
them away for a demo:

1. **Approval is separate from state.** Animation, a wake phrase or a spoken "yes"
   never approves anything (`docs/ACTION-PREVIEWS.md`).
2. **Irreversible ⇒ preview + fresh approval.** Typing, clicking, closing, trashing.
3. **Reversible by construction.** Trash instead of delete; an undo journal instead
   of a promise.
4. **No silent off-device data.** Screenshots, clipboard, audio and transcripts
   leave only with per-call consent.
5. **Signal honesty.** No fabricated zero, no invented latency, no partial shown as
   final, no claim beyond the tool results.
6. **Missing capability is said out loud.** A platform without a host returns a
   typed failure, never a silent success.

---

## 9. Beyond the control floor

This document answers "can it do the job at all". A second document answers the
harder question — "is it the best version of this product that exists" — by
comparing Quasnooze against the voice, computer-use and assistant projects that
are actually good at each axis, and by picking only the work that would not be a
fast follower: [COMPETITIVE-FRONTIER.md](COMPETITIVE-FRONTIER.md).

Those twelve items (`duplex-*`, `ear-*`, `skill-*`, `mind-*`) each declare the
wave above as a dependency, and a further nine (`lead-*`) go past the leaders
rather than level with them. None of them waits for a date — they wait for the
work underneath, because speed in an assistant that cannot act is decoration, and
a compiled skill that cannot be verified or undone is a way to fail faster. Every one of them carries a performance contract —
baseline, target, and the behaviour it may not regress — enforced by
`test/frontier-roadmap.test.js`.
