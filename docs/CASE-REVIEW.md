# Crack the Case — Review of Quasnooze
### A case-competition style audit of a personal project, using the *Crack the Case* playbook

> **Case:** Quasnooze — local-first personal AI assistant (Ollama + MCP, permission-first, voice)
> **Review date:** 22 Nov 2026 · **Repo:** `Quasynvo/Quasnooze` · **Age:** 24 days (created 29 Oct 2026)
> **Method:** Understand → Analyse → Solve → Present. Every claim below is tied to a file, a test, or a measured number in the repo. No unsupported assumptions.

---

## 01 · Cover / Executive Summary

**One-line verdict:** Quasnooze is a technically excellent, unusually honest local assistant that leads the field on *trust* (permission + verification) but loses on *reach, speed, and proof-of-use* — the classic "great product, small audience" case. The fix is not more features. It is distribution, one painful speech bug, and a tighter story.

| Lens (from Crack the Case) | Score | Why |
|---|---:|---|
| Problem understanding | **9 / 10** | Root problem named precisely; competitors mapped; "where we lose" kept in README on purpose |
| Data-backed analysis | **10 / 10** | Every headline number has n, method, reproduce command; baselines fail the build when stale |
| Solution quality | **8 / 10** | Practical, feasible, problem-focused; one moat (skill compiler) still unbuilt |
| Storytelling / deck | **7 / 10** | README is a winning pitch; 9,146 lines of docs underneath it is an overcrowded deck |
| Pitch readiness (Q&A) | **8 / 10** | Risks pre-answered in-repo; physical-mic and model-IQ gaps honestly disclosed |

**The 30-second pitch (use this verbatim):**
> "Quasnooze is a local-first personal AI assistant that runs on your own machine — Ollama reasoning, zero runtime dependencies, MIT. It answers everyday intents in 4.3 ms p50 without touching a model, and every action is read back and marked *verified, contradicted, or unverified* — 20/20 injected faults caught, 0 silent wrong-successes. It leads the field on permission-first safety and honest failure. Where we lose — voice latency ~1.5 s vs ~200 ms research systems, and 70% speech accuracy on numbers-and-names — we publish in the README and track as open issues."

---

## 02 · Problem Statement

**What the case requires you to solve:**
> *How does a solo/small-team, local-first personal AI assistant win users against cloud giants and a 394k-star open-source rival — without sacrificing the privacy and safety that are its only defensible moat?*

**Why this is the right problem statement (not "build more features"):**
- The market already has reach (OpenClaw, 394k★), code agents (Open Interpreter, 69k★), and voice frameworks (Pipecat 17k★, LiveKit 15k★, Moshi 11k★). A feature checklist will always lose.
- Quasnooze's own competitive audit (`docs/COMPETITIVE-FRONTIER.md`) proves the point: it **leads on exactly 2 of 12 dimensions** — permission model and honest failure reporting — and is **last on 4** (latency, turn-taking, OS breadth, skill replay). The case is therefore not "be faster than Moshi" but "be the only assistant whose speed and capability are matched by proof it did what it said."

**Direction for everything that follows:** Win on *trust + proof*, borrow speed where cheap, and fix distribution before adding surface area.

---

## 03 · Research Before You Ideate

### Market trends
- Local-first AI is growing, but the *harness* layer (OpenClaw) is capturing mindshare with 20+ channels and one-line install. Voice is moving to full-duplex (~160–200 ms, Moshi) and semantic turn detection (LiveKit). Verified computer-use (OpenAdapt: 18/18 vs 62/63, 22.5 s vs 36.5 s) is the emerging quality bar.
- Quasnooze correctly bets on the *unclaimed* intersection: **conversation → verified, replayable, permission-scoped program** (`skill-01/02/03`). Nobody else joins those three thirds.

### Customers (who actually needs this?)
| Segment | Need | Quasnooze fit |
|---|---|---|
| Privacy-conscious builders / self-hosters | No cloud account, no silent uploads | **Strong** — local by default, opt-in per channel |
| Power users who fear "AI did it wrong" | Proof, not promises | **Strong** — verified/contradicted/unverified + receipts |
| Voice-first / accessibility users | Fast, interruptible voice | **Weak today** — silence-only endpointing, ~1.5 s first sound, Windows-only host |
| Casual users | One-line install, magic | **Weak** — Node 22+, Ollama, manual setup; no npm release yet |

### Company (current position)
- **Built:** 21,843 LOC in `src/` (80 files), 45 docs (9,146 lines), 79 test files, **1,014/1,014 tests passing** (measured 22 Nov 2026; README says 1,003 — drift of +11, see §06), **21/21 audit probes passing**, zero runtime deps, CI on Node 22/24/26 + smoke test.
- **Not built / not shipped:** No GitHub release, no npm publication (`@quasynvo/quasnooze` metadata only), no physical-microphone acceptance, no signed desktop updater.
- **Traction:** 14★, 5 forks, 26 open issues, ~100 PRs, 7 contributors — but bus factor is concentrated: RANJITHROSAN17 (204 commits) + kaitoayohama1 (74) = ~93% of contributions.

### Competitors (Porter's Five Forces — personal AI assistant)
| Force | Assessment |
|---|---|
| **New entrants** | **High.** Low barrier: Ollama + a chat UI + MCP. OpenClaw proves a solo team can reach 394k★. |
| **Supplier power** | **Medium.** Ollama/model providers and browser speech vendors control the brain and ears; Quasnooze mitigates with provider abstraction + deterministic fast path. |
| **Buyer power** | **High.** Users switch in one `git clone`. Switching cost ≈ 0 until memory/tasks accumulate locally. |
| **Substitutes** | **High.** Cloud assistants (ChatGPT voice, Gemini), OS assistants (Siri/Copilot), and "just use the API directly" all substitute for casual use. |
| **Rivalry** | **High on features, low on trust.** Rivals compete on channels/models; almost none compete on *verified* execution or permission previews. That is the only durable wedge. |

**Quick Tip applied:** Research to understand the problem, not to collect features. The repo does this well — `COMPETITIVE-FRONTIER.md` explicitly lists what *not* to build (mandatory cloud audio, enterprise SSO, image/video gen, unbounded automation).

---

## 04 · Identify the Core Problem — Issue Tree

> Don't jump to a solution. Find what is actually causing the problem.

**Symptom:** Excellent engineering, tiny audience (14★ in 24 days vs OpenClaw's 394k★).

Break the symptom down (like the café example: *Sales = Customers × Spend* → here *Adoption = Discoverability × Trust × Usability × Performance*):

```
Adoption is low
├── Discoverability — no release, no npm, no demo video, docs sprawl (45 files)
├── Trust — STRONG (permission-first, verified, honest failure) ✓ not the cause
├── Usability — Node 22+ + Ollama + manual setup; Windows-only voice host
├── Performance — fast path 4.3 ms ✓, but voice latency ~1.5 s, speech 70% on numbers
└── Proof-of-use — no real-user evidence; all evals synthetic/mock-brain
```

**Root cause (not the symptom):** The product is optimised for *being right* (verification, audit, evals) while the market rewards *being found and being fast to first value*. The decline is primarily a **distribution + first-value problem**, not a capability problem — exactly like the café case where customer loss (−20%) mattered more than spend (−3.3%).

---

## 05 · Frameworks

### SWOT
| | Helpful | Harmful |
|---|---|---|
| **Internal** | **S:** Zero deps, 1,014 tests, 21/21 audit, verified execution, fast path, honest "where we lose" section, MIT | **W:** Voice latency/turn-taking last in field, speech 70% on numbers, no physical-mic test, docs sprawl, bus factor (2 people = 93%), Node 22 EOL Apr 2027 |
| **External** | **O:** Unclaimed moat (conversation→verified skill), local-first tailwind, "help wanted" issues attract contributors, GitHub Pages demo | **T:** OpenClaw scale, Moshi/LiveKit latency bar, browser-vendor speech privacy, model providers, Anthropic model retirement (issue #197) |

### 4Ps
| P | Today | Gap |
|---|---|---|
| **Product** | Permission-first, verified, multi-channel, voice visualizer | Skill compiler unbuilt; OS breadth = lock + shell only |
| **Price** | Free, MIT, zero runtime deps | No paid/hosted tier — fine for now; don't add one to "match checklists" |
| **Place** | GitHub + GitHub Pages demo | No npm release, no GitHub release, no package managers — the biggest 4P failure |
| **Promotion** | README with measured results + showcase GIF | No launch post, no demo video, no awesome-list submission despite `AWESOME-LISTS.md` existing |

### Frameworks the repo already uses well
- **Issue Tree** — the roadmap's NOW/NEXT/LATER/DEFER structure is a textbook issue tree.
- **Hypothesis testing** — fast-path negatives (28 look-alikes that must *not* match) and fault-injection (20 lies) are hypothesis tests, not vanity metrics.

---

## 06 · Analyse the Data (the café-table equivalent)

Split the headline numbers the way the café case splits sales. Don't average away the weak cell.

| Metric | Value | n | Reproduce | What it proves / doesn't |
|---|---|---:|---|---|
| Fast-path routing | **31/31 (100%)** | 59 utterances | `node scripts/fast-path-eval.js` | Rules fire as specified; corpus is author-written (see §07) |
| Look-alikes wrongly acted on | **0/28** | 28 negatives | same | Safety of the deterministic path |
| Fast turn end-to-end | **p50 4.3 ms · p95 7.9 ms** | 50 turns | `node --test test/fast-path.test.js` | Bounds the fast path only; says nothing about model latency |
| Conversation bench | **60/60 (100%)** | 60 turns | `node scripts/evaluate-conversation.js` | Pipeline gating; live tier is a mock brain — not model IQ |
| Verified execution | **20/20 · 0 silent wrong-success** | 20 faults | `node --test test/verify.test.js` | Read-back works; cost p95 0.69 ms vs 50 ms budget |
| Retrieval Recall@1/@5 · MRR | **0.93 / 1.00 · 1.00** | 7+3 queries | `node scripts/evaluate-retrieval.js` | Tiny corpus; coverage gate fixed 1/3 false positives → 3/3 empty |
| Speech accuracy | **100% clean / 75% accented / 66.7% noisy / 70% numbers** | 48 synthetic | `npm run speech` | **Weakest cell is numbers-and-names** — a substituted digit = wrong reminder |
| Full suite | **1,014/1,014 passed** (README: 1,003) | 79 files, ~28 s | `node --test --test-concurrency=4` | **Drift found:** README badge is stale by 11 tests — a baseline-freshness test should catch this |
| Audit probes | **21/21 passed** | 21 probes | `node scripts/audit.js` | Security regressions hold |
| Traction | **14★ · 5 forks · 26 open issues** | — | `gh repo view` | Distribution, not quality, is the constraint |

**Insight:** The numbers are *unusually* honest — every row ships with n, method, and a "what it does not prove" clause, and stale baselines fail the build. That is the single best practice in this repo and the one most case teams skip.

---

## 07 · Challenge Your Hypothesis

| # | Hypothesis | Test | Verdict |
|---|---|---|---|
| H1 | "More features → more adoption" | Compare feature count (80 src files, 5 channels, MCP, control plane) vs 14★ | **Rejected.** Features are not the constraint; distribution is. |
| H2 | "Fast path is safe to expand" | 28 negatives + closed allowlist (5 tools) + fall-through on failure | **Supported, narrowly.** Safe for the 5 intents; compound/incomplete requests correctly fall through. Corpus is author-written — needs stranger phrasings. |
| H3 | "Speech is good enough" | 48 synthetic utterances by condition | **Rejected for numbers.** 70% on numbers-and-names; remaining misses are acoustically wrong digits, unrecoverable by routing. Fix is confirmation read-back (issue #158), not a better router. |
| H4 | "Verification = safety" | Fault injection + audit | **Partially supported.** Verification is *detection*, not prevention; shell stays `unverified` by design. Honest, but judges will probe this — see Q&A. |

**Remember:** A strong case solver is not someone who is always right first try, but someone willing to question, test, and improve. This repo does that in public (`RESULTS.md` §3, `FAST-PATH-EVAL.md` §6 "What would make this report wrong").

---

## 08 · Root Cause

> Lower relative *findability + first-value speed* → fewer installs → fewer contributors → slower distribution — while the product keeps getting *more correct*.

The root cause is **not** "the assistant isn't smart enough" or "it needs more channels." It is that the repo has built a **trust engine** and is marketing it as a **feature list**. The winning move is to sell the proof, ship the package, and fix the one user-visible bug (numbers) before building the next frontier item.

---

## 09 · Building the Solution — Recommendation

Three pillars, each **Practical · Data-Backed · Problem-Focused · Feasible · Impactful**:

### Pillar 1 — Ship the package (distribution)
- Publish the first GitHub release + npm package (`@quasynvo/quasnooze` already reserved in metadata). Add a 60-second demo video/GIF of `npm run demo` (real panel, canned brain, ~2 s, no keys).
- Submit to awesome-lists (doc already exists) and post a launch thread using the 30-second pitch above.
- **Why:** Attacks the root cause directly. Cost: days. Impact: every other pillar is invisible without it.

### Pillar 2 — Fix numbers-and-names (the weakest cell)
- Ship confirmation read-back for numeric arguments (already scoped as issue #158): "Remind me at 5:15 — did you mean 5:15?" before acting.
- Add the physical-microphone acceptance matrix (issue #161) for the Windows host; until then, keep the README disclaimer.
- **Why:** 70% → the only user-visible correctness bug in the measured set. A wrong digit is a wrong reminder — the exact failure class the fast path was built to eliminate.

### Pillar 3 — Build the moat, not the checklist (skill compiler)
- Prioritise `skill-01` (conversation → verified, replayable program, p50 < 300 ms, zero model calls) over new channels (Signal/Matrix/Teams, issue #159) or image/video gen.
- **Why:** It is the only roadmap item that is a *fast follower of nobody* — OpenAdapt proves the technique, OpenClaw proves the demand, nobody joins them in a local assistant. Everything else on the roadmap is borrowed from someone better at it.

**What NOT to build (from the repo's own DEFER list — endorse it):** mandatory cloud audio, enterprise SSO, unbounded desktop automation, always-on mic, self-installing skill marketplaces.

---

## 10 · Winning Tips & Common Mistakes — Audit

| Crack the Case rule | Verdict | Evidence |
|---|---|---|
| One key message per slide | ⚠️ **Mixed** | README: excellent. Docs: 45 files / 9,146 lines — a first-time visitor drowns. Needs a 1-page map. |
| Use relevant charts/data | ✅ **Pass** | `results.svg`, frontier table, eval docs — data where it helps |
| Keep design clean/consistent | ✅ **Pass** | Brand assets generated from one script; demo-site drift check in CI |
| Stress-test your solution | ✅ **Pass** | Fault injection, audit probes, "what would make this wrong" sections |
| Final check: numbers correct? | ⚠️ **One drift** | README says 1,003 tests; measured 1,014. Fix badge or add freshness test. |
| Overcrowded slides | ❌ **Fail (docs)** | `GUIDE.md` alone is 1,251 lines; `AUDIT.md` 894. Archive or split. |
| Unclear solution | ✅ **Pass** | "Local assistant that hears you, acts, and cannot act without you" is crisp |
| Unsupported assumptions | ✅ **Pass** | Every claim linked or tested; synthetic/mock limits stated |
| Irrelevant data | ⚠️ **Watch** | `PR-AREA-METRICS.md` percentages describe text size, not improvement — correctly labelled, but easy to misquote |
| Poor time management | ⚠️ **Watch** | Hourly roadmap automation + 14 workflows for a 2-person team risks process > product |
| Weak storytelling | ⚠️ **Mixed** | Problem→analysis→solution flow is strong in README; buried under docs for newcomers |
| Reading from the PPT | n/a | — |
| Ignoring questions | ✅ **Pass** | "Where we lose" + Q&A-ready docs pre-answer the hard questions |
| Last-minute changes | ✅ **Pass** | CI matrix, smoke test, baseline-freshness gates |

---

## 11 · Implementation (deck structure: steps, timeline, owners)

| When | Step | Owner (suggested) | Done when |
|---|---|---|---|
| **Week 1** | Fix README test count (1,003→1,014) + add freshness assertion | Maintainer | `npm run verify` green; badge matches suite |
| **Week 1–2** | GitHub release v1.0.0 + npm publish + demo video | Maintainer | `npx @quasynvo/quasnooze demo` works; release notes link RESULTS.md |
| **Week 2–4** | Numeric confirmation read-back (#158) + speech corpus expansion with stranger phrasings | Voice contributor | Numbers-names ≥ 90% on expanded corpus; 0 wrong-action on negatives |
| **Month 2** | Physical-mic acceptance matrix (#161); semantic turn detection (#177) spike | Windows/voice owner | Checklist signed on hardware; endpoint p50 measured |
| **Month 2–3** | `skill-01` compiler prototype (one workflow, e.g. "tidy downloads") | Core maintainer | Replay p50 < 300 ms, zero model calls, byte-identical args |
| **Ongoing** | Docs map: 1-page index + archive stale docs; awesome-list submissions | Docs contributor | New visitor reaches "running assistant" in < 5 min without reading 9k lines |

**Buffer:** Keep 20% time for review/practice — the repo already does this via CI gates; don't add a 15th workflow to save 2 minutes.

---

## 12 · Risks & Stress Test

| Risk | Likelihood | Mitigation (already in repo or proposed) |
|---|---|---|
| Judge asks "is verification just a boolean?" | High | Answer with the 3-state model + 20/20 fault table; admit shell stays `unverified` |
| Judge asks "is 100% real?" | High | Disclose: synthetic corpora, mock brain, author-written utterances; point to "what would make this wrong" |
| Bus factor: 2 people = 93% of commits | Medium | "Help wanted" issues + CONTRIBUTING.md exist; assign pillar owners above |
| Node 22 EOL (30 Apr 2027) | Certain | `package.json` already plans the move to ≥24; CI tests 22/24/26 |
| Model retirement (Anthropic, 30 Nov 2026, #197) | Certain | Provider abstraction; update docs before the date |
| Scope creep into channels/features | Medium | Enforce DEFER list; every new surface needs a measured contract |

---

## 13 · The Pitch & Q&A

### 2-minute pitch outline
1. **Problem** (20 s): "Cloud assistants act on your machine with no proof. Local assistants act with no permission model. Nobody does both."
2. **Analysis** (40 s): "We scored 12 dimensions against 14 field projects. We lead on permission + honest failure; we lose on latency and reach. Our evals: 31/31 routing, 0/28 wrong, 4.3 ms p50, 20/20 faults caught — and 70% on numbers, which we publish."
3. **Solution** (40 s): "Three moves: ship the package, fix numbers with confirmation read-back, build the conversation→verified-skill compiler nobody else has."
4. **Close** (20 s): "Local by default. Permission-first. Verified, not just 'done'. Try it: `npm run demo` — real panel, canned brain, two seconds."

### Q&A prep (know these cold)
- **Key numbers:** 1,014 tests · 21/21 audit · 4.3 ms p50 · 31/31 + 0/28 · 20/20 · 70% numbers · 14★.
- **Assumptions:** Synthetic corpora; mock brain for live tier; single-machine latency; author-written utterances. Say them before the judge finds them.
- **Why this solution over alternatives:** Why not more channels? (Distribution > surface.) Why not chase Moshi latency? (Borrow the technique, keep the trust wedge.) Why not cloud? (It deletes the moat.)
- **Risks & limitations:** Voice latency, physical-mic untested, shell unverified, bus factor, no release yet. Acknowledge, then point to the tracked issue.

**Defend, don't agree:** If a judge suggests "just add GPT-4 voice" — listen, then explain why that trades away the local trust boundary that is the entire case.

---

## 14 · Final Verdict

**Quasnooze is a strong case entry.** It understands the problem, backs every claim with reproducible data, builds a practical and feasible solution, and pitches with unusual honesty. Its weaknesses are the ones case judges reward you for naming: distribution, one measurable speech bug, and a deck (docs) that is too crowded for its own README.

**Fix distribution first, fix numbers second, build the skill compiler third — and it stops being a great repo and starts being a great product.**

> *Build the right team, understand the problem, back your solution with data, and pitch it with confidence.* — Crack the Case. Quasnooze already does three of the four. Ship it, and it does the fourth too.

---

### Appendix — How to reproduce this review
```bash
git clone https://github.com/Quasynvo/Quasnooze.git && cd Quasnooze
node --test --test-concurrency=4   # expect 1,014 passed (README badge: 1,003 — drift noted)
node scripts/audit.js              # expect 21 passed
node scripts/fast-path-eval.js     # 31/31, 0/28
node scripts/evaluate-retrieval.js # Recall@5 1.00
npm run speech                     # numbers-names 70.0%
gh repo view --json stargazerCount,forkCount,createdAt
```
