# Four-repository functionality audit and local-first upgrade roadmap

**Audit date:** 2026-11-03. **Status:** architecture and issue proposals, not implemented assistant features. **Scope:** repository catalog and targeted inspection of representative runtime, integration, tests and documentation relevant to the six requested pillars. The four references contain hundreds of skills and demos; this is not a line-by-line review of every file or a measured competitive benchmark. No claim of market leadership or universal correctness is substantiated. The predecessor [comparative roadmap](AGENTIC-COMPARATIVE-ROADMAP.md) has been merged; its `agentic-*` issues remain proposals, not shipped runtime. This document adds distinct capability slices and explicit prerequisites rather than duplicating that roadmap.

## Pinned evidence index

* [Quasnooze](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/README.md) `3928f7e21117c86d45a16b6aa02fb028f81d87af`
* [Addy Osmani Agent Skills](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/README.md) `301b02b12bff98e4688e6984af6556802322bbde`
* [Awesome LLM Apps](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/README.md) `6c16b23f1bacd0fdf240bb5141ef45e59e82c306`
* [ECC](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/README.md) `b38be6a7f6350964d59328b52f0624e1d1d552d1`
* [Matt Pocock Skills](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/README.md) `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`
* [Superpowers (security/worktree reference)](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/README.md) `2ce8aa15d05bd57213e6f746f953aafb7ded7a8b`

Primary sources below are pinned to these snapshots. The references have different scopes and licenses: skills and instructions are not necessarily enforcement code; app samples often use cloud services; ECC's AgentShield is a separate tool/package. Designs here are independently specified, not copied source or instructions.

## 1. Comparative repository matrix

| Capability | Evidence and distinct strengths | Quasnooze baseline and gap | Proposed native slice and verification |
|---|---|---|---|
| **Harness lifecycle (ECC)** | [Lifecycle contract](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/memory-persistence/README.md) documents session-start, pre-compact, pre/post tool and stop hooks; [pre-commit quality hook](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/scripts/hooks/pre-bash-commit-quality.js) and [hook configuration](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/hooks/hooks.json) provide host-specific implementations. Hook support differs across harnesses. | [Agent loop](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/agent.js) validates arguments, enforces eight-round bound and performs approval inline; [risk tiers](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/risk.js) and [reply guard](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/guard.js) are already present. No reusable lifecycle contract found. | `src/harness/events.js` adds bounded in-process events, never arbitrary hook execution or authorization bypass. **Test:** validate → policy → approval → run order; failure/denial/unattended cannot run tools (`harness-01`). |
| **Skill conventions and deterministic evals (Addy + ECC)** | [Skill anatomy](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/docs/skill-anatomy.md) defines frontmatter, on-demand references and evidence checks; [validator](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/scripts/validate-skills.js) and [trigger/behavior evals](https://github.com/addyosmani/agent-skills/blob/301b02b12bff98e4688e6984af6556802322bbde/evals/README.md) test positive and negative routing. Many execution steps remain model instructions. ECC offers host-specific adapters. | [personas](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/personas.js), [local tool registry](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/tools.js) and [manifest tools](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/custom-tools.js) exist; no data-only workflow skill runtime has shipped. Prior `agentic-05-skills` already proposes one. | Extend that loader with `src/skills/evaluate.js` fixtures, schema/size bounds and context budget. **Test:** positive/negative routing, malicious skill cannot grant tools (`harness-03`). |
| **Instincts and adaptations (ECC)** | [Continuous Learning v2](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/skills/continuous-learning-v2/SKILL.md) describes project-scoped, confidence-weighted patterns, observation and promotion; its capture/reliability figures are claims, not independently validated here. | Explicit [local memory](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/store.js) and per-session personas exist; no equivalent reviewed learned-preference workflow found. | `src/harness/instincts.js` proposes opt-in, review-before-use project-scoped suggestions, not automatic training/policy. **Test:** isolation, revoke and prompt-injection cannot override authority (`harness-04`). |
| **Multi-agent & MoA (Apps)** | [Mixture of Agents](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/starter_ai_agents/mixture_of_agents/mixture-of-agents.py) fans out four hosted-model answers then synthesizes; [competitor team](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/advanced_ai_agents/multi_agent_apps/agent_teams/ai_competitor_intelligence_agent_team/competitor_agent_team.py) illustrates domain roles. These are examples, not quality evidence and may transmit user data remotely. | [brain](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/brain.js) has Ollama and optional compatible providers; [router](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/router.js) has bounded fallback, not a specialist panel. Earlier `agentic-06-worker` is proposed only. | `src/agent/panel.js` uses opt-in sequential local perspectives with shared budget, no child tools or cloud fallback. **Test:** partial failure, no egress and source/disagreement retention (`harness-08`). |
| **MCP routing & fallback (Apps)** | [Agent Forge](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/mcp_ai_agents/multi_mcp_agent_router/agent_forge.py) maps roles to selected MCP servers using keyword classification; it can spawn configured tools. | [MCP client](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/mcp.js) already handles stdio, namespacing and untrusted output; an explicitly trusted server is marked non-dangerous and can bypass normal approval. [Tests](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/test/mcp.test.js) confirm that opt-out. Model fallback is already present, so do not duplicate it. | `src/mcp/router.js` narrows schemas and dispatch per task; new scoped mode treats every MCP call as dangerous regardless of legacy trust, while preserving legacy behavior elsewhere. **Test:** spoofed tools denied, unattended blocked even for legacy-trusted server (`harness-07`). |
| **Background scouts (Apps)** | [Release radar](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/always_on_agents/release_radar_agent/radar.py) parses manifests, matches releases and ranks signals; [HN scout](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/always_on_agents/always_on_hn_briefing_agent/scout.py) demonstrates feeds. These samples access external sources. | [Scheduler](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/scheduler.js) and [schedule storage](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/schedules.js) already support unattended runs; [inventory](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/docs/CAPABILITIES.json) describes bounds and no dangerous unattended calls. | `src/agent/scout.js`: owner-opt-in allowed sources, deduped local digest, egress disclosure, SSRF hardening, no unattended dangerous actions. **Test:** fake-clock dedupe and denied network (`harness-09`). |
| **Issue setup/triage (Pocock)** | [Setup](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/setup-matt-pocock-skills/SKILL.md) discovers repo and asks tracker, labels and domain layout; it is explicitly prompt-driven, not a deterministic adapter. [Triage](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/triage/SKILL.md) describes roles and human review. | [GitHub lifecycle bot](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/.github/workflows/issue-lifecycle-bot.yml) and [reviewed contributor queue](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/scripts/roadmap-queue.js) already operate on this repository; desktop runtime has no generic repo tracker adapter found. | `src/tracker/{adapter,local,setup,github,gitlab,triage}.js`: local first, remote explicit, normalized label mapping and per-write consent. **Test:** no setup egress; path escape/remote denial means no mutation (`harness-10`–`12`). |
| **Domain → spec → tickets (Pocock)** | [Domain mapping](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/domain-modeling/SKILL.md), [to-spec](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/to-spec/SKILL.md) and [to-tickets](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/to-tickets/SKILL.md) describe shared terminology and dependency-aware vertical slices, with user approval. | [Prompt](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/prompt.js) gives short engineering guidance; prior `agentic-01-phased-flow` proposes an approved plan but has not shipped. | `src/tracker/spec-to-tickets.js`: draft from approved plan and glossary, validate acyclic blockers and require approval before publication. **Test:** missing evidence cannot silently become agent-ready (`harness-12`). |
| **Memory and compaction (Apps + ECC)** | [Shared multi-model memory](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/advanced_llm_apps/llm_apps_with_memory_tutorials/multi_llm_memory/README.md) uses Qdrant plus cloud models; [ECC memory vault](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/skills/unified-memory/SKILL.md) is a separate runtime with user/project/team scopes and untrusted recall; [pre-compact](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/scripts/hooks/pre-compact.js) saves a summary. | [Store](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/store.js) already preserves explicit memory and session history across model changes; [fit](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/budget.js) trims history with system retention. No scoped provenance/correction ledger. | `src/memory/provenance.js` adds optional scoped provenance and reversible migration; reuse prior `agentic-11-resume` for context restore. **Test:** legacy migration, correction and scope isolation across model switches (`harness-05`). |
| **Token optimization (Apps)** | [TOON demo](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/advanced_llm_apps/llm_optimization_tools/toonify_token_optimization/README.md) and [Headroom demo](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/advanced_llm_apps/llm_optimization_tools/headroom_context_optimization/README.md) show format/compression approaches; advertised savings are example claims, not measurements for Quasnooze/Ollama. | [Existing budget](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/budget.js) estimates tokens, reserves response and drops whole old messages; it does not measure task fidelity of compression. | `src/eval/context-compression.js`: offline reversible fixture benchmark, report bytes/tokens/fidelity; no TOON or Headroom dependency or rollout until measured. **Test:** identifiers, citations and tool protocols survive or fall back (`harness-06`). |
| **Security scanner & isolation (ECC + Superpowers)** | [ECC scanner guidance](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/skills/security-scan/SKILL.md) covers configuration, secrets, hooks and MCP; [ECC runner provenance](https://github.com/affaan-m/ECC/blob/b38be6a7f6350964d59328b52f0624e1d1d552d1/README.md) identifies AgentShield as separately installed and recommends reviewed provenance. [Worktree guidance](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/using-git-worktrees/SKILL.md) isolates Git working state, not processes. | [Workspace and command controls](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/tools.js), [risk tiers](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/risk.js) and [security self-check](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/scripts/audit.js) exist. [scan.js](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/scan.js) is a bounded walker, not an agent-config vulnerability scanner. | `src/security/config-scan.js` independently implements a small read-only config preflight, redacted and explicit about incomplete coverage. **Test:** known findings, bounded traversal, clean scan cannot authorize (`harness-02`). Prior `agentic-03-worktree` covers Git isolation. |
| **Voice and multimodal (Apps)** | [Voice RAG](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/voice_ai_agents/voice_rag_openaisdk/README.md) combines PDF retrieval and speech with OpenAI/Qdrant; [live multimodal example](https://github.com/Shubhamsaboo/awesome-llm-apps/blob/6c16b23f1bacd0fdf240bb5141ef45e59e82c306/voice_ai_agents/insurance_claim_live_agent_team/README.md) relies on a live hosted service. These are demonstrations, not evidence of local, low-latency behavior. | [Voice docs](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/docs/VOICE.md) describes Windows local System.Speech, optional Whisper-compatible endpoint, browser SpeechRecognition that may send audio to vendor, and local-service speech synthesis. [Documents](https://github.com/Quasynvo/Quasnooze/blob/3928f7e21117c86d45a16b6aa02fb028f81d87af/src/documents.js) already provides bounded local BM25 retrieval with citations. | `src/voice/stream.js`, `src/voice/document-session.js` and UI meter: explicit local endpoint, consent, cancellation, text/source parity and no silent cloud fallback. **Test:** fake audio, local docs and denied remote endpoint (`harness-13`–`15`). |

### Trust boundaries and design decisions

1. Default-off, zero new mandatory runtime dependencies; existing chat, API, `.env`, scheduler and data contracts stay backward compatible. In-process event handling is built-in and deterministic; model text, observations, memories, skills, repository files and tool results never become system policy.
2. The existing approval and risk gates remain authoritative. New orchestrated MCP mode tightens trusted-server behavior rather than pretending the current opt-out does not exist. Parent-session binding, cancellation and unattended denial apply across workers and tracker writes.
3. New panels and background work pin local Ollama and do not silently route private inputs to cloud providers. Existing explicit cloud paths continue as-is. Network scouts and trackers need explicit consent, exact target visibility, credential isolation, bounded traffic and SSRF-safe redirects; default makes no new outbound calls.
4. A worktree is **not** a host sandbox: Git metadata, hooks, filters, builds, network and shell can affect the machine. A scanner is neither complete nor an authorization mechanism. A model-generated “safe” verdict cannot override deterministic controls.
5. Persist only what is necessary with explicit consent, limited retention and user deletion; never treat confidence scores as calibrated probabilities. Audio capture starts muted and any remote dictation is identified. Reversible JSON compaction must not change protocol structure or lose evidence.

## 2. Thirty-day delivery schedule

Day 1 is **2026-11-03 UTC**. Four 7-day sprints, followed by days 29–30 (Dec 1–2) for security review, offline E2E and go/no-go. Dates are filing windows, not delivery guarantees. This is a portfolio, not a credible promise for one engineer in a month: roughly 4 engineers plus security/voice review and prior `agentic-*` work already released would be needed. Dependencies and human release gates may make the 30-day target unattainable; defer slices rather than remove safeguards.

| Sprint | Window | Suggested scope |
|---|---|---|
| 1 | Nov 3–9 | lifecycle and safe scanner foundations; skill-evaluation design (`harness-01`–`03`) |
| 2 | Nov 10–16 | reviewed instincts, memory provenance, compression benchmark, scoped MCP, local tracker (`04`–`07`, `10`) |
| 3 | Nov 17–23 | local panel, consented scouts, remote trackers, triage, local voice (`08`–`09`, `11`–`13`) |
| 4 | Nov 24–30 | local document voice, optional meter and integrated rollout gate (`14`–`16`) |
| Days 29–30 | Dec 1–2 | supported Node matrix, privacy/security review, local hardware smoke checks; hold anything incomplete |

**Bot contract.** Canonical issue objects, including `title`, `labels`, `problem_statement`, `upgraded_design_spec`, `affected_files`, `acceptance_criteria`, complete `body`, and `verify`, are appended to `.github/roadmap.json`. Entries use the existing publisher's `not_before` UTC and `depends_on` fields. The existing hourly queue can file them only after this PR merges, once dates, **manifest status `shipped`** for every prerequisite, capacity and dedupe rules permit; closed or merged alone is insufficient. Existing ready/backlog entries and shared growth cap can delay them indefinitely. Maintainers control releases and may set `auto_file: false`; no exact-date dispatch or automatic completion is promised. This PR does not itself create feature issues.

## 3. Ready-to-review pull request description

The PR below merges the **audit, roadmap and reviewed manifest only**, not the proposed feature implementations. The requested title is retained, but the summary explicitly prevents the title from implying that unimplemented capabilities ship in this PR.

### PR Title

`feat(harness): Ultimate AI Assistant Architecture Upgrade (ECC + Agent-Skills + LLM-Apps + Pocock-Skills Integration)`

### Summary of Changes

**Actual changes in this PR:** a pinned comparative audit, 16 structured issue objects, and queue metadata using the existing bot. No new runtime modules, integrations or third-party code are installed.

**Proposed subsequent work by subsystem:**
- **Harness Hooks:** deterministic local event boundaries, reviewable instincts, skill fixture evaluation and scanner (`harness-01`–`04`); dependent on the previous skill-loader proposal where noted.
- **Multi-Agent Teams:** scoped MCP visibility, local sequential panel and consented scheduled scout (`harness-07`–`09`), building on the earlier proposed worker.
- **Tracker Adapter:** local repository tracker first, optional GitHub/GitLab and approval-gated spec-to-ticket triage (`harness-10`–`12`).
- **Memory & Token Compression:** compatible provenance/correction semantics and reversible offline compression benchmark (`harness-05`–`06`); no unmeasured savings claim.
- **Voice Engine:** opt-in local streaming interface, cited local document answers and privacy-preserving activity UI (`harness-13`–`15`), followed by the offline integration gate (`harness-16`).

### Breaking Changes & Migration Guide

**This PR:** no API, data, configuration or runtime behavior changes; no migration needed. The repository bot may file eligible new issues after merge, bounded by its existing controls. **Future feature PRs:** default off, keep legacy `memory.json` readable, use a versioned opt-in migration with backup and documented rollback, retain existing aliases and voice paths; never replace trusted MCP behavior globally without a separate compatibility decision. Local tracker is default; remote tracker/feeds require opt-in and visible egress. No silent cloud fallback, microphone activation or new mandatory dependencies.

### Testing Verification Steps

```bash
node scripts/validate-roadmap.js .github/roadmap.json
node --test test/roadmap-queue.test.js test/roadmap.test.js
node --test
node scripts/audit.js
```

Run on supported Node 22, 24 and 26 in CI. Future subsystem issues specify additional tests that do not exist until implemented; their commands are acceptance targets, not results of this PR. Use fake clocks, models, HTTP and audio in CI; hardware/Ollama checks are separate documented manual smoke tests. A workflow dry run and a current issue-history export are needed to predict real queue behavior.

## 4. Bot-ready issue objects

The following readable issues mirror the structured manifest. Paths marked new are proposed; `files` in the existing bot manifest lists existing anchors for its drift checker, while `planned_files` and `affected_files` identify new modules.

### harness-01-policy-events — feat(harness): deterministic action lifecycle policy events

**Labels:** `harness`, `security`, `roadmap`  
**Sprint:** 1 · **Earliest:** 2026-11-03 UTC

## Context

The agent validates and gates tools inline, but has no shared typed lifecycle contract for pre-action checks and post-action evidence.

## Upgraded design specification

Add a small in-process, built-in-only event pipeline: beforeTool, afterTool, beforeCommit and beforeContextTrim. Events carry bounded, redacted metadata; beforeTool may deny or ask but never grant or suppress the existing validator, risk gate or session approval. A commit proposal is recognized structurally and always gated. Timeouts/errors on policy checks fail closed; observational callbacks cannot change actions. No arbitrary plugin code, network or shell hooks. Keep ordinary turns unchanged while disabled.

## Affected files / modules

- `src/harness/events.js` (new)
- `src/agent.js`
- `src/risk.js`
- `test/harness-events.test.js` (new)

## Acceptance criteria

- [ ] Order is validate → deterministic policy → existing user approval → execute → bounded after event; a handler cannot convert denial into authorization.
- [ ] Fake tool and commit attempts show cancellation, handler failure and unattended actions do not execute; unconfigured mode preserves old behavior.
- [ ] No credentials, raw prompts or tool output are written by default; no arbitrary callback or runtime dependency is installed.

## How to verify

```bash
node --test test/harness-events.test.js test/agent.test.js test/risk.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 1; not before 2026-11-03 UTC. Prerequisites: none.

### harness-02-config-scan — feat(security): local agent configuration preflight scanner

**Labels:** `security`, `harness`, `roadmap`  
**Sprint:** 1 · **Earliest:** 2026-11-03 UTC

## Context

Quasnooze has command and path guardrails but no targeted, inspectable scanner for risky agent configuration changes.

## Upgraded design specification

Implement native read-only bounded scanning of explicitly selected local agent, MCP and hook manifests using src/scan.js and canonical workspace rules. Flag a documented, testable set of obvious secret literals, shell interpolation, broad trust and remote installers, with path/line/severity but no secret values. Show scan incompleteness and false positives; scanner failure cannot make a dangerous action safe. No auto-fix, external binary, npx download, telemetry, raw secret copies, or claim that static scanning proves safety. Integrate with beforeTool as advisory review and deterministic high-confidence blocks, never as permission.

## Affected files / modules

- `src/security/config-scan.js` (new)
- `src/scan.js`
- `src/harness/events.js` (new)
- `test/config-scan.test.js` (new)

## Acceptance criteria

- [ ] Known fixtures for each rule yield stable redacted locations; benign fixtures and unreadable/truncated scans report accurately.
- [ ] Traversal, symlink escape, oversized files and malicious input stay bounded and never contact a network.
- [ ] A clean result does not bypass approvals; scan failure blocks configured high-risk preflight and reports why.

## How to verify

```bash
node --test test/config-scan.test.js test/hardening.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 1; not before 2026-11-03 UTC. Prerequisites: `harness-01-policy-events` (shipped).

### harness-03-skill-evals — test(skills): local skill schema and trigger regression fixtures

**Labels:** `harness`, `agentic-flow`, `roadmap`  
**Sprint:** 1 · **Earliest:** 2026-11-03 UTC

## Context

The prior roadmap proposes an instruction-only skill registry, but does not specify a repeatable evaluation of activation, exclusions and behavioral contracts.

## Upgraded design specification

Extend the proposed local-only agentic-05 skill loader with a versioned manifest schema and deterministic fixture runner. Each skill declares scoped trigger/exclusion examples and observable expected behavior; validate malformed, duplicate and oversized inputs. Test routing with deterministic fakes and separately offer a manual local Ollama evaluation without recording transcripts. Guidance remains untrusted data; deterministic permission rules live in code, not Markdown. Do not import or execute external skill scripts.

## Affected files / modules

- `src/skills/loader.js` (new)
- `src/skills/evaluate.js` (new)
- `test/skills-evaluate.test.js` (new)
- `src/budget.js`

## Acceptance criteria

- [ ] At least three positive and two negative fixture cases per bundled skill distinguish false routing from no match.
- [ ] Invalid schema, duplicate identifiers, oversized content and external references fail closed; instructions cannot grant tools.
- [ ] A mock-model behavioral fixture and a trimmed-context case pass offline; reports state model quality is not proven by static lint.

## How to verify

```bash
node --test test/skills-evaluate.test.js test/skills-loader.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 1; not before 2026-11-03 UTC. Prerequisites: `agentic-05-skills` (shipped).

### harness-04-instinct-review — feat(harness): reviewed project-scoped preference suggestions

**Labels:** `harness`, `memory`, `security`, `roadmap`  
**Sprint:** 2 · **Earliest:** 2026-11-10 UTC

## Context

Personas and explicitly saved memory exist, but repeated corrections cannot become scoped, reviewable workflow preferences.

## Upgraded design specification

Add an opt-in local-only suggestion store using explicit user corrections or annotated events, not automatic raw transcript collection. Record a bounded trigger, proposed preference, project scope, provenance, timestamps and evidence count; confidence is a heuristic, not calibrated probability. Suggestions remain inert until owner previews and approves; imports, cross-project promotion, deletion and expiration require explicit consent. Inject approved preferences as low-priority data, never security policy, tools or permissions.

## Affected files / modules

- `src/harness/instincts.js` (new)
- `src/store.js`
- `src/prompt.js`
- `src/export.js`
- `test/instincts.test.js` (new)

## Acceptance criteria

- [ ] Disabled mode writes nothing; two projects cannot read each other’s suggestions; imported or model-generated instructions remain inert until approved.
- [ ] A malicious preference cannot alter system rules, model endpoint, risk policy or approvals; revoke/delete works after restart.
- [ ] Export includes these entries only under an explicitly documented owner-controlled policy and never includes raw secret material.

## How to verify

```bash
node --test test/instincts.test.js test/personas.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: `harness-01-policy-events` (shipped), `agentic-05-skills` (shipped).

### harness-05-memory-provenance — feat(memory): scoped facts with source and correction history

**Labels:** `memory`, `security`, `roadmap`  
**Sprint:** 2 · **Earliest:** 2026-11-10 UTC

## Context

Local facts and session history already persist across model selection, but facts lack explicit project scope, provenance and conflict/correction semantics.

## Upgraded design specification

Extend existing store in a backward-compatible versioned shape with opt-in provenance, scope, timestamps and supersession markers; retain existing remember/recall/forget and export semantics. A local-only migration preserves old facts in user scope; edits/deletion remain owner-controlled. Recall must filter by authorized scope and treat facts as data, not instructions. No cross-user sharing, automatic remote synchronization or embedding service.

## Affected files / modules

- `src/memory/provenance.js` (new)
- `src/store.js`
- `src/tools.js`
- `src/export.js`
- `test/memory-provenance.test.js` (new)

## Acceptance criteria

- [ ] A legacy memory.json migrates losslessly; rollback from backup is documented and deletion removes all active copies.
- [ ] Correction supersedes stale fact and citations show source/time without claiming truth; malformed records do not corrupt other entries.
- [ ] Scope filtering survives restart and model switch; neither remote fallback nor new network traffic is triggered.

## How to verify

```bash
node --test test/memory-provenance.test.js test/export-cost.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: none.

### harness-06-compression-eval — test(context): measure safe structured-data compression before adoption

**Labels:** `harness`, `memory`, `roadmap`  
**Sprint:** 2 · **Earliest:** 2026-11-10 UTC

## Context

budget.fit trims history using approximate token counts, but no local benchmark establishes whether structured-output compression helps the installed model without dropping evidence.

## Upgraded design specification

Add a zero-dependency benchmark comparing existing JSON baseline and a reversible compact representation on bounded synthetic fixtures, with local tokenizer/model measurement optional and offline-only. Record measured bytes, estimated/actual tokens, latency and exact field/identifier round trips; never compress system policy, authorization, citations, denied actions or the active tool-call protocol. Keep compression disabled pending demonstrated quality and an explicit follow-up; do not add TOON or Headroom as runtime dependencies.

## Affected files / modules

- `src/eval/context-compression.js` (new)
- `src/budget.js`
- `test/context-compression.test.js` (new)

## Acceptance criteria

- [ ] Round-trip fixtures retain ordering, Unicode, nested objects, IDs, errors and citation numbers; malformed data falls back to original JSON.
- [ ] Results show measured versus estimated values and regressions without asserting vendor marketing savings or model understanding.
- [ ] No model call or network is needed in CI; opted-in local evaluation identifies model/version and has no private data.

## How to verify

```bash
node --test test/context-compression.test.js test/agent.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: `agentic-11-resume` (shipped).

### harness-07-mcp-scope — feat(mcp): per-task tool visibility without weakening trust policy

**Labels:** `mcp-router`, `security`, `roadmap`  
**Sprint:** 2 · **Earliest:** 2026-11-10 UTC

## Context

MCP tools are currently registered globally and namespaced; an explicitly trusted server can skip the danger gate, so an orchestration router must not assume all servers are always gated.

## Upgraded design specification

Add an optional task-scoped view over existing stdio MCP registry, matching owner-approved server and tool names. Filter offered schemas and enforce the same allowlist at dispatch, rejecting unknown names, collisions and any worker attempt to expand its scope. For the new scoped mode mark all MCP calls dangerous regardless of legacy trusted opt-outs, require originating-session approval and refuse unattended calls; leave legacy mode compatible. No remote transport, auto-install, shared credentials or new model-selected process.

## Affected files / modules

- `src/mcp/router.js` (new)
- `src/mcp.js`
- `src/agent.js`
- `test/mcp-router.test.js` (new)

## Acceptance criteria

- [ ] A filtered or spoofed server/tool cannot be invoked even by fabricated model output; names remain collision-safe.
- [ ] A legacy trusted server still needs approval in the new scoped mode and is refused unattended; denial causes zero calls.
- [ ] MCP crash, oversized result and malformed schema produce bounded errors; no server is spawned solely by model instruction.

## How to verify

```bash
node --test test/mcp-router.test.js test/mcp.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: `harness-01-policy-events` (shipped).

### harness-08-panel — feat(agent): optional bounded local multi-perspective panel

**Labels:** `agentic-flow`, `harness`, `roadmap`  
**Sprint:** 3 · **Earliest:** 2026-11-17 UTC

## Context

Moa and specialist examples provide multiple perspectives, while Quasnooze currently runs one selected model per agent turn and has no bounded aggregation step.

## Upgraded design specification

Build on prior agentic-06 sequential worker with opt-in read-only analyst roles and a local-only aggregator; default one worker at a time and at most three perspectives within a shared token/time/cancellation budget. Pin Ollama endpoint/model, reject automatic remote fallback, exclude private unrelated context, expose disagreements and sources. No child tools by default, writes or financial advice automation. Failure yields partial results labelled as such, not confident consensus.

## Affected files / modules

- `src/agent/panel.js` (new)
- `src/agent/worker.js` (new)
- `src/brain.js`
- `test/agent-panel.test.js` (new)

## Acceptance criteria

- [ ] Fake roles receive only approved bounded context and no tools; maximum calls/concurrency and cancellation are enforced.
- [ ] An unavailable local model, malicious analyst output or partial failure cannot trigger remote fallback, tool execution or fabricated consensus.
- [ ] Aggregated result retains evidence IDs and visibly records disagreement; social turns incur no extra calls.

## How to verify

```bash
node --test test/agent-panel.test.js test/router.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: `agentic-06-worker` (shipped).

### harness-09-scout — feat(scout): consented local schedule-backed source briefing

**Labels:** `agentic-flow`, `security`, `roadmap`  
**Sprint:** 3 · **Earliest:** 2026-11-17 UTC

## Context

Scheduled agent turns already exist but lack a structured, deduplicated source-backed digest with user-visible egress controls.

## Upgraded design specification

Add an opt-in scout configuration using existing scheduler and outbound routing: owner selects exact allowed feed/source endpoints, cadence and delivery. Default local-only with no network; optional explicitly permitted remote fetches must reuse hardened SSRF-safe network code, enforce redirects, byte/time/rate limits and label egress. Scheduled runs stay unattended and read-only, cannot schedule children or execute dangerous MCP tools, and store bounded fingerprints for dedupe. Treat all fetched text as untrusted; include citations and last-run/failure state.

## Affected files / modules

- `src/agent/scout.js` (new)
- `src/schedules.js`
- `src/scheduler.js`
- `src/outbound.js`
- `test/scout.test.js` (new)

## Acceptance criteria

- [ ] A fake clock and local transport demonstrate one digest, deduplication, no catch-up storm and cancellation with no real network.
- [ ] No allowlist or disabled setting means zero fetches; DNS rebinding, redirect to private address and oversized content fail closed.
- [ ] No unattended action can write externally or bypass approval; receipts distinguish fetch failure from no updates.

## How to verify

```bash
node --test test/scout.test.js test/schedules.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: none.

### harness-10-tracker-local — feat(tracker): owner-approved per-repository local issue adapter

**Labels:** `tracker-integration`, `security`, `roadmap`  
**Sprint:** 2 · **Earliest:** 2026-11-10 UTC

## Context

The repository has GitHub contributor automation, but the desktop assistant has no user-selectable per-project tracker abstraction or local Markdown ticket workflow.

## Upgraded design specification

Add a narrow adapter interface for list/read and draft/write plus an interactive repo discovery flow. The first implementation is local Markdown in an owner-selected canonical workspace directory; parse and bound metadata, refuse symlink escapes, and preview every write through existing approval. Store per-repo configuration locally, never mutate git remotes or repo policy files during discovery, and do not alter the existing GitHub contributor bot.

## Affected files / modules

- `src/tracker/adapter.js` (new)
- `src/tracker/local.js` (new)
- `src/tracker/setup.js` (new)
- `src/agent.js`
- `test/tracker-local.test.js` (new)

## Acceptance criteria

- [ ] A temporary workspace lists and drafts tickets offline; two repositories remain isolated and reconfiguration needs owner consent.
- [ ] Traversal, malicious filenames and symlink escape fail closed; denial or unattended mode writes no ticket.
- [ ] Default disabled mode and existing contributor queue remain unchanged; setup never changes remote configuration.

## How to verify

```bash
node --test test/tracker-local.test.js test/hardening.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: none.

### harness-11-tracker-remote — feat(tracker): explicitly authorized GitHub and GitLab adapters

**Labels:** `tracker-integration`, `security`, `roadmap`  
**Sprint:** 3 · **Earliest:** 2026-11-17 UTC

## Context

Local-first issue drafts alone cannot publish or read a user-selected remote tracker when the owner explicitly asks.

## Upgraded design specification

Implement optional GitHub and GitLab adapters over a common narrow interface after local adapter ships. Discovery only suggests hosts; remote access needs explicit opt-in and exact owner-approved repo/host. Minimize scopes, use owner-supplied credentials held outside repo and logs, TLS with allowlisted origin/redirect policy and bounded responses. Preview each create, comment or label change and require session approval; no bulk mutation, automatic PR creation, token forwarding to model or silent remote fallback. Fake HTTP for tests.

## Affected files / modules

- `src/tracker/github.js` (new)
- `src/tracker/gitlab.js` (new)
- `src/tracker/adapter.js` (new)
- `src/tracker/setup.js` (new)
- `test/tracker-remote.test.js` (new)

## Acceptance criteria

- [ ] Fake GitHub and GitLab API fixtures verify pagination bounds, error handling, canonical repo mapping and equivalent local draft behavior.
- [ ] No egress occurs before explicit setup; redirect/host mismatch and token leakage to logs, model or another host are rejected.
- [ ] Each write requires fresh origin-session approval, and denial/unattended runs make zero write requests.

## How to verify

```bash
node --test test/tracker-remote.test.js test/tracker-local.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: `harness-10-tracker-local` (shipped).

### harness-12-triage — feat(tracker): draft-only triage and spec-to-ticket pipeline

**Labels:** `tracker-integration`, `agentic-flow`, `roadmap`  
**Sprint:** 3 · **Earliest:** 2026-11-17 UTC

## Context

The existing repo labeler classifies GitHub issues, but the desktop assistant cannot convert an approved spec into portable, dependency-aware ticket drafts.

## Upgraded design specification

Use the approved plan from agentic-01 and the tracker adapter to propose glossary-aware spec and vertical slices with stable local IDs, blocking edges, acceptance criteria and test seams. Provide configurable mappings for needs-triage, needs-info, ready-for-agent, ready-for-human and wontfix, without asserting auto-triage correctness. Show the full preview and require explicit approval for each publish/change; never auto-close issues or overwrite human work. Remote writes remain separately approved.

## Affected files / modules

- `src/tracker/triage.js` (new)
- `src/tracker/spec-to-tickets.js` (new)
- `src/tracker/adapter.js` (new)
- `test/tracker-triage.test.js` (new)

## Acceptance criteria

- [ ] Fixtures produce independent vertical slices with resolvable, acyclic dependencies; missing evidence stays needs-info rather than ready-for-agent.
- [ ] A user can edit or reject drafts; no issue, label, comment or close occurs before approval.
- [ ] A malicious tracker response cannot change labels or authorize operations; local and remote adapters see the same normalized draft.

## How to verify

```bash
node --test test/tracker-triage.test.js test/tracker-local.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: `harness-10-tracker-local` (shipped), `agentic-01-phased-flow` (shipped).

### harness-13-local-voice — feat(voice): bounded opt-in local streaming speech interface

**Labels:** `voice-engine`, `security`, `roadmap`  
**Sprint:** 3 · **Earliest:** 2026-11-17 UTC

## Context

Windows has local System.Speech recognition/TTS; browser dictation may be remote and the optional Whisper adapter is request/response, not a guaranteed local streaming pipeline.

## Upgraded design specification

Introduce an optional loopback-only, explicitly configured local STT stream adapter behind existing voice paths. Mic starts muted; no raw audio is retained by default. Enforce chunk size, timeout, cancellation, local origin, DNS/redirect restrictions and visible recording state. Reuse existing local playback, cancel old speech on barge-in where supported; otherwise honestly report that capability unavailable. Never silently fall back to browser vendor or a remote endpoint.

## Affected files / modules

- `src/voice/stream.js` (new)
- `src/voice.js`
- `src/server.js`
- `public/index.html`
- `test/voice-stream.test.js` (new)

## Acceptance criteria

- [ ] Fake local stream yields ordered partial and final transcripts; cancellation, backpressure, device error and disconnect release the input.
- [ ] Remote/redirected origins are refused in local-only mode; absence of adapter never invokes browser or cloud recognition silently.
- [ ] Startup remains muted, no audio file or transcript telemetry is written by default, and old voice APIs remain compatible.

## How to verify

```bash
node --test test/voice-stream.test.js test/voice.test.js test/voice-reply.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: none.

### harness-14-voice-rag — feat(voice): cite local document answers in spoken sessions

**Labels:** `voice-engine`, `memory`, `roadmap`  
**Sprint:** 4 · **Earliest:** 2026-11-24 UTC

## Context

Local BM25 document retrieval and speech output already exist, but there is no dedicated voice-document retrieval end-to-end contract.

## Upgraded design specification

Compose existing search_documents and source registry with the local voice path; preserve a visible text answer and source references while speaking a short answer using an explicitly local TTS voice. Never upload documents or audio, open a Qdrant service, or invent citations; if no source exists say so and allow text-only fallback. Keep spoken content, evidence and approval state in sync when interrupted.

## Affected files / modules

- `src/voice/document-session.js` (new)
- `src/documents.js`
- `src/sources.js`
- `src/agent.js`
- `test/voice-document-session.test.js` (new)

## Acceptance criteria

- [ ] Temporary local text/PDF fixture yields cited answer through mocked speech and document tool without network.
- [ ] Missing source, cancelled playback or unavailable local voice cannot fabricate citations or trigger cloud TTS.
- [ ] File permission and prompt-injection tests preserve workspace boundaries; no document or audio is persisted by this feature.

## How to verify

```bash
node --test test/voice-document-session.test.js test/documents.test.js test/citations.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 4; not before 2026-11-24 UTC. Prerequisites: `harness-13-local-voice` (shipped).

### harness-15-visualizer — feat(voice): privacy-preserving local audio activity indicator

**Labels:** `voice-engine`, `security`, `roadmap`  
**Sprint:** 4 · **Earliest:** 2026-11-24 UTC

## Context

Voice UI can indicate state but lacks a bounded reactive level visualization that consistently stops with microphone capture.

## Upgraded design specification

Add an optional level meter using local in-memory audio amplitude only while the owner has enabled capture. Surface listening, processing and muted states in accessible text; respect reduced motion, no audio storage, no third-party assets or network. Remove listeners and stop rendering at mute, disconnect or tab close; provide an unavailable fallback rather than requesting new permissions solely for decoration.

## Affected files / modules

- `public/index.html`
- `desktop/Companion.cs`
- `test/voice-visualizer.test.js` (new)

## Acceptance criteria

- [ ] Fake audio input drives level and accessible state while active and ceases immediately on mute/cancel.
- [ ] No capture starts at boot or solely for visualization; no audio or amplitude trace leaves the process or is persisted.
- [ ] Reduced-motion and no-WebAudio paths remain usable; repeated toggle does not leak event listeners.

## How to verify

```bash
node --test test/voice-visualizer.test.js test/voice-reply.test.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 4; not before 2026-11-24 UTC. Prerequisites: `harness-13-local-voice` (shipped).

### harness-16-offline-gate — test(harness): integrated offline rollout and migration safety

**Labels:** `harness`, `security`, `voice-engine`, `roadmap`  
**Sprint:** 4 · **Earliest:** 2026-11-24 UTC

## Context

The proposed features require a cross-subsystem regression before any capability claim or default enablement.

## Upgraded design specification

Keep all additions opt-in, no new mandatory runtime dependencies. Compose mock brain, fake local voice, mock tracker and temp workspace in an end-to-end fixture covering explicit setup, permission, memory migration, local scout, MCP scope and cancellation. Document backward-compatible defaults, data retention/export changes, rollback, optional remote egress and non-sandbox limits; update capability inventory only after each feature ships. Run supported Node CI matrix and audit.

## Affected files / modules

- `test/harness-e2e.test.js` (new)
- `docs/GUIDE.md`
- `docs/VOICE.md`
- `docs/CAPABILITIES.json`
- `src/config.js`

## Acceptance criteria

- [ ] Disabled configuration produces unchanged existing behavior and no added outbound requests or stored private audio.
- [ ] Integrated offline test demonstrates approval denial, prompt injection, tracker escape, stale memory and MCP trust isolation without external services.
- [ ] Node 22, 24 and 26 run the suite and self-audit; migration/rollback is exercised on a copy and all outstanding risks are documented.

## How to verify

```bash
node --test test/harness-e2e.test.js && node --test && node scripts/audit.js
```

Use deterministic fixtures, temporary workspaces and fake models/transports; no cloud account, actual network or microphone required in CI.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 4; not before 2026-11-24 UTC. Prerequisites: `harness-02-config-scan` (shipped), `harness-03-skill-evals` (shipped), `harness-04-instinct-review` (shipped), `harness-05-memory-provenance` (shipped), `harness-06-compression-eval` (shipped), `harness-07-mcp-scope` (shipped), `harness-08-panel` (shipped), `harness-09-scout` (shipped), `harness-11-tracker-remote` (shipped), `harness-12-triage` (shipped), `harness-14-voice-rag` (shipped), `harness-15-visualizer` (shipped).
