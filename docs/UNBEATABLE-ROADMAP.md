# Quasnooze — The Unbeatable Roadmap
### Crack the Case: from "great repo" to "uncompetable product"

> **Case:** How does a local-first personal AI assistant become *unbeatable* — best quality, best performance, and structurally uncompetable — without becoming a worse copy of OpenClaw, Moshi, or LiveKit?
> **Method:** Understand → Analyse → Solve → Present (Crack the Case, Ch. 3–6).
> **Rule:** No feature ships without a **Performance Contract** (baseline → target → what it must not make worse) and a **reproduce command**. If it can't be measured, it isn't a moat.

---

## 01 · Introduction — The World of This Case

A case competition is not about having a good idea. It is about understanding the problem, supporting your solution with data, and communicating it. This roadmap applies that discipline to Quasnooze itself.

**What Quasnooze is today (measured, 22 Nov 2026):**
- Local-first personal AI assistant: Ollama reasoning, MCP tools, web + Windows voice + Telegram/Discord/Slack/WhatsApp, zero runtime dependencies, MIT.
- **1,014/1,014 tests passing** · **21/21 audit probes passing** · fast path **4.3 ms p50** · verified execution **20/20 faults caught, 0 silent wrong-successes**.
- Leads the field on **2 of 12 dimensions** (permission model, honest failure). Last on **4** (latency, turn-taking, OS breadth, skill replay). — `docs/COMPETITIVE-FRONTIER.md`

**Why "unbeatable" is a winnable case (not a slogan):**
Every rival is excellent at *one* axis and structurally unable to be the whole product:
- OpenClaw (394k★) has reach but skills are prose a model re-reads every run.
- Moshi (~200 ms) is speech-only, GPU-bound, no tools, no OS.
- LiveKit/Pipecat are frameworks — you bring the agent, the permissions, and the machine.
- OpenAdapt proves verified replay (18/18 vs 62/63) but you record by hand, outside a conversation, and it doesn't talk.

**Nobody compiles a *conversation* into a verified, replayable, permission-scoped program on a machine that both listens and acts.** That intersection is the case. This roadmap builds it, feature by feature.

---

## 02 · Building the Right Team

A case is won by complementary strengths, not by cloning the same skill. Current contributors (7): RANJITHROSAN17 (204 commits), kaitoayohama1 (74), Vamsi-2581 (10), AndreIsraelAO (5), arena-agent (4), dependabot (3), KaitoAoyoma (2).

| Role needed | Who / gap | Roadmap implication |
|---|---|---|
| Core maintainer (agent, trust, verification) | Covered | Owns F06–F08 (skills, OS vocabulary) |
| Voice engineer (STT/TTS, duplex, wake) | **Gap — biggest risk** | F03–F05 need a dedicated owner; issues are labelled `help wanted` |
| Performance / brain engineer (router, context, latency) | Partial | F02 owner; must respect "never make safety worse" contracts |
| Docs / distribution (release, npm, demo, awesome-lists) | **Gap** | F01 owner; distribution is the root cause (§03) |
| Independent reviewer (security, evals) | Partial (audit culture exists) | F09 owner; stranger corpora + physical-mic matrix |

**Quick Tip applied:** Don't build a team good at the same thing. Build a team whose strengths complement each other. Every issue below names its owner role and is labelled `help wanted` where the gap is.

**Time plan (Understand → Research → Analysis → Solution → Deck → Rehearsal):** 4 phases over ~90 days, each phase gated by measured contracts, not dates. Buffer: 20% for review and hardware testing.

---

## 03 · How to Crack the Case

### 03.1 Research before you ideate

| Area | Finding (data, not assumption) |
|---|---|
| **Market trends** | Voice → full-duplex (~160–200 ms) + semantic turn detection. Computer-use → verified replay beats guessing. Harnesses → reach wins mindshare. |
| **Key data** | Fast path 4.3 ms p50 (n=50) vs ≥700 ms model budget. Verified read-back p95 0.69 ms vs 50 ms budget. Speech numbers-names **70%** (n=10) — weakest cell. Traction **14★** vs OpenClaw 394k★. |
| **Customers** | Privacy builders (strong fit) · proof-seekers (strong fit) · voice-first users (weak: ~1.5 s first sound, silence-only) · casual users (weak: no release/npm). |
| **Company** | 21,843 LOC `src/`, 45 docs (9,146 lines), zero deps, CI on Node 22/24/26. No release, no npm, no physical-mic test, bus factor 2 people = 93%. |
| **Competitors** | 14 projects scored on 12 dimensions (`COMPETITIVE-FRONTIER.md` §2). Quasnooze leads on permission + honest failure; last on latency, turn-taking, OS breadth, skill replay. |

### 03.2 Identify the core problem — Issue Tree

> Don't jump to a solution. Find what is actually causing the problem.

```
"Unbeatable" is not yet true
├── Discoverability — no release, no npm, no demo video, docs sprawl
├── Trust — STRONG ✓ (permission-first, verified, honest failure)
├── Usability — Node 22+ + Ollama + manual setup; Windows-only voice/TTS
├── Performance — fast path 4.3 ms ✓, but voice ~1.5 s, speech 70% on numbers
├── Capability — no skill replay, OS breadth = lock + shell, no wake model
└── Proof-of-use — synthetic/mock evals only; no public bench, no hardware matrix
```

**Root cause:** The product is optimised for *being right* while the market rewards *being found, being fast to first value, and being provably better*. The fix is not more features — it is **distribution + speed moat + skill moat + public proof**, in that order.

### 03.3 Frameworks

**SWOT**
| | Helpful | Harmful |
|---|---|---|
| Internal | Zero deps · 1,014 tests · verified execution · fast path · honest "where we lose" | Voice latency last · speech 70% numbers · no physical-mic test · docs sprawl · bus factor |
| External | Unclaimed moat (conversation→verified skill) · local-first tailwind · `help wanted` contributors | OpenClaw scale · Moshi/LiveKit latency bar · browser-vendor speech · model retirements |

**Porter's Five Forces (personal AI assistant):** New entrants **high** · Supplier power **medium** · Buyer power **high** (switching cost ≈ 0) · Substitutes **high** (cloud assistants) · Rivalry **high on features, low on trust**. → Only a *trust + proof* wedge is durable.

**4Ps:** Product (strong trust, weak OS breadth) · Price (free/MIT — correct, don't add a paid tier to match checklists) · **Place (failing — no release/npm)** · Promotion (README strong, launch absent).

### 03.4 Challenge your hypothesis

| # | Hypothesis | Test | Verdict |
|---|---|---|---|
| H1 | "More features → unbeatable" | 80 src files + 5 channels vs 14★ | **Rejected.** Distribution + moat, not feature count. |
| H2 | "Fast path can expand safely" | 28 negatives, closed 5-tool allowlist, fall-through | **Supported narrowly.** Keep the allowlist closed; expand only with stranger corpora (F09). |
| H3 | "Speech is good enough" | 48 synthetic by condition | **Rejected for numbers.** Fix is confirmation read-back (#158), not a better router. |
| H4 | "Verification = safety" | 20/20 faults + 21/21 audit | **Partial.** Verification is detection, not prevention; shell stays `unverified` by design. |

---

## 04 · Building the Solution — 10 Features, Feature by Feature

Each feature is **Practical · Data-Backed · Problem-Focused · Feasible · Impactful**, carries a Performance Contract, and is filed as a GitHub issue. Existing open issues (#138–#201) are *prerequisites or neighbours*, not duplicates — see the dependency column.

### Phase 0 — Ship it (distribution moat)

| # | Feature | Performance Contract | Issue | Depends on |
|---|---|---|---|---|
| F01 | **Ship v1.0: GitHub release + npm publish + one-command demo** — `npx @quasynvo/quasnooze demo`, 60s demo video, awesome-list submissions, launch post using the 30-second pitch | First install → running panel **< 60 s** on clean machine; demo works offline with no keys | [#202](https://github.com/Quasynvo/Quasnooze/issues/202) | — |
| F02 | **Docs map + 5-minute quickstart** — 1-page index over the 45 docs, archive stale pages, "running assistant in < 5 min" path | New visitor reaches a running assistant **< 5 min** without reading 9k lines; zero broken links in CI | *folded into #202 acceptance* | F01 |

### Phase 1 — Speed moat (brain)

| # | Feature | Performance Contract | Issue | Depends on |
|---|---|---|---|---|
| F03 | **Adaptive Brain: model router + first-token deadline + context budget** — small/fast model for talk turns, big model for tool turns; hedged first-token deadline (silent primary 180 s → 1.2 s + one hop); context compression (prefill −40% at turn 20, 100% pinned-fact retention) | Overall p50 **−35%**, task success ≥ baseline, escalation < 15%, **0 cutovers after first delta**, wrong-answer rate +1 pp max | [#203](https://github.com/Quasynvo/Quasnooze/issues/203) | #173 waterfall, #201 arg shaping |

### Phase 2 — Voice moat (full duplex, local)

| # | Feature | Performance Contract | Issue | Depends on |
|---|---|---|---|---|
| F04 | **Streaming TTS + full-duplex barge-in** — first audio ≤ 250 ms after first token, no mid-word break, barge-in ≤ 150 ms, semantic turn detection integrated | First audio **≤ 250 ms**, false end-of-turn **< 8%**, cut-off rate must not rise | [#204](https://github.com/Quasynvo/Quasnooze/issues/204) | #169 barge-in, #177 semantic turns, #179 speculative |
| F05 | **On-device TTS for every surface** — Piper/Kokoro-class local synthesis on web/Linux/macOS/Windows, no cloud path, offline | First audio **≤ 250 ms**, **zero network bytes**, quality ≥ Windows baseline, < 10% of one core | [#205](https://github.com/Quasynvo/Quasnooze/issues/205) | F04 |
| F06 | **On-device wake-word model** — openWakeWord-class always-on detection, opt-in, never authentication | **< 1% of one core** idle, **≤ 1 false accept/hour**, first-word latency **≤ 500 ms** | [#206](https://github.com/Quasynvo/Quasnooze/issues/206) | #199 activity indicator |

### Phase 3 — Hands moat (skills + OS)

| # | Feature | Performance Contract | Issue | Depends on |
|---|---|---|---|---|
| F07 | **Conversation skill compiler** ⭐ *the moat* — compile a conversation into a verified, replayable, permission-scoped program; replay with **zero model calls** | Replay p50 **< 300 ms**, arguments **byte-identical**, 100% permission re-check on replay | [#207](https://github.com/Quasynvo/Quasnooze/issues/207) | #145 ledger, #151 skill loader, skill-02 shipped |
| F08 | **Drift repair: stop, don't guess** — detect drifted replay, recover or stop cleanly, never misapply | **≥ 90%** of drifted runs recover or stop cleanly, **zero** misapplied runs | [#208](https://github.com/Quasynvo/Quasnooze/issues/208) | F07 |
| F09 | **Verified OS action vocabulary** — typed dictation into focused app, clipboard, window ops, each with per-action read-back (extends `laptop-01..07`) | Every OS action **verified/contradicted/unverified**; **0 silent wrong-success** in fault suite; undo for reversible ops | [#209](https://github.com/Quasynvo/Quasnooze/issues/209) | #138 grounding, #140 shortcuts |

### Phase 4 — Proof moat (measurement)

| # | Feature | Performance Contract | Issue | Depends on |
|---|---|---|---|---|
| F10 | **Quasnooze Bench + offline backup/restore + local cost ledger** — public reproducible eval harness (stranger corpora, physical-mic matrix, byte-for-byte baselines); versioned backup/restore with verification; per-turn cost/spend ledger, local-only | Every README number **reproducible in 1 command**; stale baseline **fails the build**; restore round-trip **100%** with zero silent loss; cost ledger **100%** local, zero network bytes | [#210](https://github.com/Quasynvo/Quasnooze/issues/210) + [#211](https://github.com/Quasynvo/Quasnooze/issues/211) | #161 mic matrix, #173 waterfall |

**What NOT to build (endorse the repo's DEFER list):** mandatory cloud audio, enterprise SSO/social channels, image/video generation, unbounded desktop automation, always-on mic, self-installing skill marketplaces, a rewritten UI/runtime without measured evidence.

---

## 05 · Winning Tips & Common Mistakes

| Rule | How this roadmap obeys it |
|---|---|
| One key message per slide | One moat per phase; one contract per feature |
| Relevant charts/data | Every contract names baseline, target, n, reproduce command |
| Stress-test your solution | F08 drift repair + F10 fault suites; "what would make this wrong" per issue |
| Final check: numbers correct? | F10 makes stale numbers fail the build (fixes the 1,003 vs 1,014 drift class) |
| Avoid: overcrowded slides | F02 docs map; archive, don't append |
| Avoid: unsupported assumptions | Synthetic/mock limits stated; stranger corpora required before expanding the fast path |
| Avoid: irrelevant data | No vanity metrics; PR-area percentages stay labelled as text-size, not improvement |
| Avoid: poor time management | 4 phases, 20% buffer, prerequisites gate filing — no exact-date promises |
| Avoid: weak storytelling | Problem → analysis → solution → pitch (§06) is the deck flow |
| Avoid: last-minute changes | CI matrix + smoke test + baseline gates stay green before release |

---

## 06 · The Pitch & Q&A

**2-minute pitch:**
1. **Problem (20 s):** "Cloud assistants act with no proof. Local assistants act with no permission model. Nobody does both."
2. **Analysis (40 s):** "12 dimensions vs 14 rivals: we lead on permission + honest failure, last on latency and reach. Evals: 31/31 routing, 0/28 wrong, 4.3 ms p50, 20/20 faults caught — and 70% on numbers, published."
3. **Solution (40 s):** "Four moats: ship the package, adaptive brain, full-duplex local voice, and the conversation→verified-skill compiler nobody else has — all under public contracts."
4. **Close (20 s):** "Local by default. Permission-first. Verified, not just 'done'. `npx @quasynvo/quasnooze demo` — real panel, canned brain, two seconds."

**Q&A prep:**
- **Key numbers:** 1,014 tests · 21/21 audit · 4.3 ms p50 · 31/31 + 0/28 · 20/20 · 70% numbers · 14★.
- **Assumptions (volunteer them):** synthetic corpora, mock brain, author-written utterances, single-machine latency.
- **Why not more channels / cloud / Moshi latency:** distribution > surface; cloud deletes the trust boundary; borrow the technique, keep the wedge.
- **Risks:** voice latency, physical-mic untested, shell unverified, bus factor, no release yet — each tracked to an issue above.

---

## 07 · Learn Beyond the Case

Keep practising: structure problems, use the right frameworks, analyse data, question assumptions before solving. For Quasnooze specifically: study OpenAdapt's verified replay, LiveKit's semantic turn detection, whisper.cpp/Piper/Kokoro local audio, and openWakeWord — borrow *techniques*, never *architectures* that violate local-first + permission-first.

> **You're ready to crack the case.** Ship the package, build the skill compiler, prove every number — and "unbeatable" stops being a slogan and becomes a measurement.

---

### Appendix — Issue index
| Feature | Issue |
|---|---|
| F01 Ship v1.0 (release + npm + demo) | [#202](https://github.com/Quasynvo/Quasnooze/issues/202) |
| F02 Docs map (folded into #202 acceptance) | — |
| F03 Adaptive Brain (router + deadline + context) | [#203](https://github.com/Quasynvo/Quasnooze/issues/203) |
| F04 Streaming TTS + full-duplex barge-in | [#204](https://github.com/Quasynvo/Quasnooze/issues/204) |
| F05 On-device TTS (every surface) | [#205](https://github.com/Quasynvo/Quasnooze/issues/205) |
| F06 On-device wake-word model | [#206](https://github.com/Quasynvo/Quasnooze/issues/206) |
| F07 Conversation skill compiler ⭐ | [#207](https://github.com/Quasynvo/Quasnooze/issues/207) |
| F08 Drift repair | [#208](https://github.com/Quasynvo/Quasnooze/issues/208) |
| F09 Verified OS action vocabulary | [#209](https://github.com/Quasynvo/Quasnooze/issues/209) |
| F10a Quasnooze Bench | [#210](https://github.com/Quasynvo/Quasnooze/issues/210) |
| F10b Backup/restore + cost ledger | [#211](https://github.com/Quasynvo/Quasnooze/issues/211) |

Each issue body contains Context, Upgraded design specification, Affected files, Acceptance criteria, How to verify, Time estimate, Dependencies, and a Performance Contract.
