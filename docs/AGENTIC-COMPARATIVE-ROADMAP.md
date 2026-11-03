# Comparative audit and 30-day agentic workflow roadmap

**Snapshot:** 2026-11-03; [Superpowers `2ce8aa15d05b`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/README.md) and [Quasnooze `c33bd55e0474`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/README.md). These are repository snapshots, not runtime performance measurements. Inspection covered skills, hooks and plugin integration on the reference side; agent loop, model routing, tools, prompts, approvals, storage, capability inventory, tests, growth and GitHub workflows on the target side. Findings are architectural comparisons, not evidence that every prompt instruction is enforced by code. No reference code or prompts are copied.

## Executive assessment

Superpowers is a coding-agent methodology distributed as skills and harness integrations; Quasnooze is a general personal assistant, so forcing all interactions through a coding workflow would be a regression. Quasnooze already has an iterative model/tool loop (not just a single prompt), tests, approvals, local extension mechanisms and contributor automation. Its biggest gaps relative to the reference are an explicit approved plan, traceable per-step test/review evidence, and optional branch isolation. Deliver these as an opt-in coding mode, starting with deterministic state and safety, not a heavy autonomous multi-agent platform.

**Principles:** local-first, owner-controlled, disabled by default; Ollama pinned for new workflow calls with no automatic remote fallback; bounded work and context; existing permissions never weakened; no implicit test execution, installs, network, push or cleanup. Optional cloud providers already exist elsewhere: avoid overstating current offline guarantees. Git worktrees and child model contexts are **not security sandboxes**. Treat repository content, tool output, and local skills as untrusted instructions; a local model review cannot authorize or guarantee safety.

## Phase 1–2: evidence-based comparative analysis and architecture

| Pillar and capability | Reference mechanism and evidence | Current target evidence and limitation | Native adaptation, placement and proof |
|---|---|---|---|
| Design before code | [Brainstorming](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/brainstorming/SKILL.md) sizes work, discusses alternatives, approves design; permits straightforward/opted-out work. [Writing plans](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-plans/SKILL.md) decomposes verifiable tasks. These are primarily agent instructions, not a universal enforcement engine. | [`src/prompt.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/prompt.js) asks for inspect, a short plan and verification; [`src/agent.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/agent.js) runs up to eight tool rounds. No explicit approved plan state is visible. | `src/agent/workflow.js`: opt-in deterministic state + bounded plan, approval distinct from tool approvals. **Proof:** rejected design executes zero tools; simple greetings retain fast path. Issue `agentic-01-phased-flow`. |
| TDD and verifiable completion | [TDD skill](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/test-driven-development/SKILL.md) instructs RED → GREEN → refactor; [verification-before-completion](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/verification-before-completion/SKILL.md) requires fresh evidence. This is a methodology, not proof of universal automatic enforcement. | [`src/agent.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/agent.js) records traces and [`src/guard.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/guard.js) audits response claims; extensive `node:test` suites exist, but no task-level RED/GREEN receipt gate. | `src/eval/tdd.js` + `src/agent/ledger.js`: approved test command, witnessed intended assertion failure, fresh green revision and exception recording. **Proof:** unrelated errors, stale/skipped tests cannot satisfy gate. Issues `agentic-02-evidence-ledger`, `agentic-04-tdd`. |
| Branch isolation | [Worktree skill](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/using-git-worktrees/SKILL.md) detects existing isolation, asks consent, prefers native support, checks ignore and baseline tests. | [`src/tools.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/tools.js) confines file paths and screens shell commands, while [`src/agent.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/agent.js) applies risk tiers and approvals; no linked-worktree workflow found. Shell screening is heuristic and approved shell commands are not confined to a security sandbox. | `src/agent/worktree.js` + `src/agent/finish.js`: consent, canonical workspace roots, argv-based Git, protect dirty work and explicit cleanup. **Proof:** main/dirty data unchanged, traversal refused, no unattended mutations. Issues `agentic-03-worktree`, `agentic-08-finish`. |
| Skills and context | [Session hook](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/hooks/session-start) injects bootstrap context; [OpenCode integration](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/.opencode/plugins/superpowers.js) registers skills and host-specific mappings and handles parent/child distinctions. Distribution includes marketplace manifests; no marketplace should be copied into a privacy-focused runtime. | [`src/tools.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/tools.js) includes owner-reviewed executable local tool loading; [`src/custom-tools.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/custom-tools.js) and [`src/mcp.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/mcp.js) are additional extension paths. [`src/personas.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/personas.js) provides style presets; [`src/budget.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/budget.js) fits context. These are not an instruction-only, task-scoped skill registry. | `src/skills/loader.js`, `src/skills/registry.js`, `src/agent/resume.js`: opt-in owner-approved data-only skills, size limits, no dynamic code or network, policy-first compact restore. **Proof:** malicious skill cannot grant tool permissions; trimmed/restarted workflow preserves authority and pauses. Issues `agentic-05-skills`, `agentic-11-resume`. |
| Task delegation and review | [Subagent-driven development](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/subagent-driven-development/SKILL.md) uses fresh task implementers, task review and a final review; [requesting-code-review](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/requesting-code-review/SKILL.md) supplies scoped review guidance. These rely on host capabilities and model compliance. | [`src/agent.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/agent.js) iterates a single active turn and pins `brain.active`; [`src/brain.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/brain.js) supports local Ollama, mock and optional remote providers; [`src/router.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/router.js) includes fallback. No task-scoped worker/reviewer lifecycle identified. | `src/agent/worker.js`, `src/agent/review.js`: sequential least-context child calls, shared budget, no silent remote fallback, deterministic evidence gates and human escalation. **Proof:** critical findings or failing evidence block completion, child calls still require user approval. Issues `agentic-06-worker`, `agentic-07-review`. |
| Diagnosis and handoff | [Systematic debugging](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/systematic-debugging/SKILL.md) emphasizes root cause before fixes; [branch finishing](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/finishing-a-development-branch/SKILL.md) guides verification and disposition. | Existing development guidance in [`src/prompt.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/prompt.js) mentions hypothesis testing and [`src/failure.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/src/failure.js) classifies provider errors; neither is a tracked debug/branch handoff. | `src/agent/debug.js`, `src/agent/finish.js`: bounded hypothesis → check → evidence and explicit keep/export/integrate. **Proof:** retry budget escalates; dirty work is never removed. Issues `agentic-09-debug`, `agentic-08-finish`. |
| Growth, triage and metrics | Reference includes skill diagnostic/reporting guidance in [diagnosing-superpowers](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/diagnosing-superpowers/SKILL.md); this audit did not find evidence for a superior general-purpose issue scheduler or measured growth engine. | Target already has [`scripts/growth.js`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/scripts/growth.js) deterministic collectors and deduplication, [`docs/CAPABILITIES.json`](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/docs/CAPABILITIES.json) evidence inventory, and [contributor queue](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/.github/workflows/contributor-queue.yml) plus issue lifecycle. Do not duplicate them or call them absent. | `src/eval/workflow-metrics.js`, existing `scripts/growth.js` and inventory: optional local aggregate counters and evidence checks; no content telemetry. **Proof:** off means no writes, stale evidence yields deterministic report, existing caps/dedupe remain. Issue `agentic-10-metrics`. |

### Cross-cutting integration contract

* `runAgent` retains ownership of session-bound approvals, validation, denial and unattended policy; new modules call into the same gate instead of running tools directly. Preserve existing opt-in `autoApprove` semantics for legacy paths, but the new coding workflow requires explicit per-action consent and never inherits a broad design approval as permission.
* Pin the active local provider/model per workflow; fail closed if it is unavailable. Redact secrets and apply bounded data minimization at every persistence, worker and model boundary. Local-only does not mean safe from malicious repository instructions or host side effects.
* For Git, verify real paths and ownership immediately before each operation; worktree metadata is shared. Never execute repository hooks, installs, builds or tests implicitly; show and approve exact commands and side effects. In the absence of an OS sandbox, document that approved commands may affect the host or network. No auto-merge, auto-push or destructive cleanup.
* User-visible state is goals, decisions, checks and evidence, not hidden chain-of-thought. Denial, timeout, malformed model output, crash, stale evidence and over-budget states pause safely. Persistent data requires owner controls, retention and deletion.

## Phase 3: 30-day plan and dispatch contract

Assumed day 1 **2026-11-03 UTC**; dates are earliest rollout windows, not deadlines or guarantees. Four seven-day sprints plus days 29–30 for stabilization. The roadmap is ambitious for one engineer: plan approximately two parallel engineers plus security review; dependencies, release cadence and existing queue capacity can push delivery beyond day 30. No feature in this document is claimed to be implemented by this audit.

| Sprint | UTC window | Outcomes and issue IDs |
|---|---|---|
| 1 | Nov 3–9 | opt-in plan state, local ledger, worktree consent: 01–03 |
| 2 | Nov 10–16 | TDD receipts, data-only skills and sequential worker: 04–06 |
| 3 | Nov 17–23 | evidence review, branch handoff and bounded debugging: 07–09 |
| 4 | Nov 24–30 | offline metrics, safe resume and end-to-end release gate: 10–12 |
| Stabilize | Dec 1–2 | security review, supported Node matrix, local Ollama manual smoke test, documentation and go/no-go. Defer unfinished work; no quality-gate bypass. |

**Scheduler:** the canonical machine-readable issue objects are appended to `.github/roadmap.json`; complete bodies and labels are mirrored below. The existing hourly [contributor queue](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/.github/workflows/contributor-queue.yml) checks history, caps, complete sections and the tested selector. This PR extends that selector with optional UTC `not_before` and `depends_on` fields: all prerequisites must have manifest status `shipped` (not merely a closed issue or merged PR). Maintainers must mark each prerequisite shipped after actual release; this deliberately makes release progress human-controlled. Existing items without the fields are unchanged. Invalid dates/dependencies fail closed, and the manifest validator rejects unknown references/cycles.

After this PR is merged, eligible backlog entries **may be filed automatically** at or after their dates as queue slots allow; existing ready and earlier backlog items can take precedence. The existing cap (shared with growth), all-history marker deduplication, `auto_file: false` manual gate, and no-auto-close-without-release safeguards still apply. This is **not** exact-day or guaranteed weekly dispatch; a late merge, full queue, unsatisfied shipped dependency or manual gate delays filing. Review the [workflow dispatch](https://github.com/Quasynvo/Quasnooze/blob/c33bd55e04744e010d4584e29a9f6f1219984e72/.github/workflows/contributor-queue.yml) dry run before enabling changes in production. Do not label all tasks “good first issue”: these are security-sensitive hard tasks. Labels are created by the existing publisher.

### Operational validation

```bash
node scripts/validate-roadmap.js .github/roadmap.json
node --test test/roadmap-queue.test.js
# Local dry-run selector; replace history with a current, complete GitHub issue export.
printf '[]' > /tmp/quasnooze-history.json
node scripts/roadmap-queue.js .github/roadmap.json /tmp/quasnooze-history.json
```

The empty-history example is only a local schema/selection exercise, **not** an accurate prediction of live filing. No GitHub issue is created until the workflow actually runs after merge. The issue bodies below are proposals, not implemented features; paths marked new do not yet exist.

## Distinct issue objects

### agentic-01-phased-flow: feat(agent): opt-in bounded design and plan workflow

**Week:** 1 | **Labels:** `architecture`, `agentic-flow`, `roadmap` | **Earliest:** 2026-11-03 UTC

## Context

The existing eight-round tool loop can inspect and act but has no durable design, explicit design approval or structured multi-step plan.

## Upgraded design specification

Add an opt-in coding workflow with deterministic states inspect → design → awaiting-design-approval → planned → executing → verifying → done/blocked. Store bounded goal, scope, concrete steps and success checks as data, not hidden chain-of-thought. Ask at most one focused clarification when genuinely needed; simple chat remains on its existing fast path. Treat approval of design as distinct from every tool approval; stop on denial, cancellation or malformed state. Integrate at runAgent without replacing its action gates.

## Affected files / modules

- `src/agent.js`
- `src/agent/workflow.js (new)`
- `src/prompt.js`
- `test/agent-workflow.test.js (new)`

## Acceptance criteria

- [ ] A design must be explicitly approved in the originating session before execution; approval alone cannot authorize any tool call.
- [ ] A mock model produces a bounded plan; malformed/oversized steps fail closed with an actionable message.
- [ ] Greeting path makes no planning call; cancellation and restart never execute a pending step.

## How to verify

```bash
node --test test/agent-workflow.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 1; not before 2026-11-03 UTC. Prerequisites: none.

### agentic-02-evidence-ledger: feat(agent): local task ledger and truthful verification receipts

**Week:** 1 | **Labels:** `architecture`, `agentic-flow`, `roadmap` | **Earliest:** 2026-11-03 UTC

## Context

Conversation history and trace do not supply a durable, bounded per-task execution and verification ledger.

## Upgraded design specification

Define versioned task records keyed to session and task, with approved plan revision, phase, scoped steps and redacted execution receipts (command identity, cwd, exit status, timestamp and bounded output digest). Persist atomically in owner-only local storage with configurable retention and deletion; never record secrets or raw output by default. Revalidate paths and approvals on resume; do not replay actions after crash.

## Affected files / modules

- `src/agent/ledger.js (new)`
- `src/store.js`
- `src/agent.js`
- `test/agent-ledger.test.js (new)`

## Acceptance criteria

- [ ] Crash/restart restores state as paused and cannot repeat a side effect without a fresh decision.
- [ ] A completion claim is blocked or explicitly marked unverified when current receipts are absent, stale or failing.
- [ ] Two sessions cannot access or approve each other’s task records; no network transmission is added.

## How to verify

```bash
node --test test/agent-ledger.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 1; not before 2026-11-03 UTC. Prerequisites: `agentic-01-phased-flow` (shipped).

### agentic-03-worktree: feat(security): consent-based Git worktree for code changes

**Week:** 1 | **Labels:** `architecture`, `security`, `agentic-flow`, `roadmap` | **Earliest:** 2026-11-03 UTC

## Context

Existing path confinement and confirmation gates are not branch-level isolation; direct edits can affect the user’s working checkout.

## Upgraded design specification

Only in explicitly enabled coding mode, discover a Git root under an allowed workspace, inspect dirty/untracked files and existing worktrees, then offer a new generated branch and ignored, workspace-confined worktree using execFile argv (never shell interpolation). Bind file tools to that root, keep existing checks, pin base SHA, and ask separately before creation, merge, deletion or other dangerous operation. Refuse ambiguous, symlinked or outside-root locations, hooks/config surprises and unsupported submodules; surface manual recovery. A linked worktree is NOT an OS sandbox: shell, hooks, network, shared Git metadata and test scripts may access the host. Do not advertise containment or run untrusted repo code automatically.

## Affected files / modules

- `src/agent/worktree.js (new)`
- `src/agent/workflow.js (new)`
- `src/tools.js`
- `src/agent.js`
- `test/agent-worktree.test.js (new)`

## Acceptance criteria

- [ ] A temporary Git integration fixture shows main branch and dirty/untracked data unchanged; no destructive cleanup on error or cancellation.
- [ ] Traversal, symlink escape, branch-name injection and missing Git fail closed; existing approval rules still apply.
- [ ] No command, hook, install or test runs without its existing explicit approval; unattended mode refuses dangerous actions.

## How to verify

```bash
node --test test/agent-worktree.test.js test/hardening.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 1; not before 2026-11-03 UTC. Prerequisites: `agentic-01-phased-flow` (shipped).

### agentic-04-tdd: feat(tdd): record red-green-refactor evidence for coding tasks

**Week:** 2 | **Labels:** `tdd-engine`, `agentic-flow`, `roadmap` | **Earliest:** 2026-11-10 UTC

## Context

The engineering prompt asks for tests, but no runtime records a failing test before an implementation or verifies the later pass.

## Upgraded design specification

For opt-in coding work only, provide a state machine for test-added → witnessed expected RED → GREEN → refactor verification. Use user-approved project test command/argv and safe working directory through existing action policy; capture exit status and bounded redacted evidence tied to test and code revision. Distinguish setup failure or unrelated failure from a witnessed assertion failure; a human can mark an exception with reason, which is explicitly unverified, not TDD-complete. No test or install is implicitly safe.

## Affected files / modules

- `src/eval/tdd.js (new)`
- `src/agent/ledger.js (new)`
- `src/agent/workflow.js (new)`
- `test/tdd-engine.test.js (new)`

## Acceptance criteria

- [ ] Fixture test demonstrably fails for the intended assertion before implementation, then passes; refactor triggers a fresh run.
- [ ] Syntax errors, missing runner, timeouts, stale revision, skipped tests and unknown failure cannot count as RED or GREEN.
- [ ] Denial and unattended mode run no test command; user sees exact command and risk before approval.

## How to verify

```bash
node --test test/tdd-engine.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: `agentic-02-evidence-ledger` (shipped), `agentic-03-worktree` (shipped).

### agentic-05-skills: feat(skills): load owner-reviewed local workflow instructions

**Week:** 2 | **Labels:** `architecture`, `agentic-flow`, `security`, `roadmap` | **Earliest:** 2026-11-10 UTC

## Context

Quasnooze supports local executable tools, MCP, custom tools and personas, but does not expose a separately scoped, instruction-only coding skill registry.

## Upgraded design specification

Add a disabled-by-default registry of versioned, size-limited local JSON/text manifests in an owner-configured, canonical trusted directory outside workspace. Owner explicitly enables each skill; load only matched task instructions as low-priority data and never dynamic-import, install packages, discover a marketplace or grant tools. Maintain system policies and tool gates as authoritative. Reuse budget.fit and inject compact selected skill identifiers and approved constraints after history trimming; never accept instructions from tool outputs as policy.

## Affected files / modules

- `src/skills/loader.js (new)`
- `src/skills/registry.js (new)`
- `src/prompt.js`
- `src/budget.js`
- `test/skills-loader.test.js (new)`

## Acceptance criteria

- [ ] Invalid schema, duplicate IDs, symlinks outside trusted directory, excessive bytes and unapproved skills are rejected.
- [ ] A malicious skill cannot expand tool permissions or change the system policy; simple chat does not load coding skills.
- [ ] Context fitting retains system policy and approved active constraints while staying within the existing budget.

## How to verify

```bash
node --test test/skills-loader.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: `agentic-01-phased-flow` (shipped).

### agentic-06-worker: feat(agent): scoped, sequential task workers with shared budgets

**Week:** 2 | **Labels:** `architecture`, `agentic-flow`, `security`, `roadmap` | **Earliest:** 2026-11-10 UTC

## Context

The current loop uses a single conversational context and has no isolated task-scoped implementer/reviewer context.

## Upgraded design specification

Provide one sequential child context per approved plan step with minimal brief, selected non-secret files and restricted tool schemas. Reuse the pinned local model (no silent router fallback to remote), parent session approvals, a global round/token/time budget and cancellation. Child cannot grant itself permissions, create children, schedule, or use tools outside parent policy; results are structured status, evidence and concerns. Context isolation is not process isolation; never claim an adversarial security boundary.

## Affected files / modules

- `src/agent/worker.js (new)`
- `src/agent/workflow.js (new)`
- `src/brain.js`
- `src/agent.js`
- `test/agent-worker.test.js (new)`

## Acceptance criteria

- [ ] Mock worker receives only its brief and allowlisted context, with no unrelated session or credential data.
- [ ] A child write asks the originating user through the same gate; denial, timeout and unattended operation cannot execute it.
- [ ] Recursive delegation, over-budget execution and remote fallback are refused; parent records blocked status.

## How to verify

```bash
node --test test/agent-worker.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 2; not before 2026-11-10 UTC. Prerequisites: `agentic-02-evidence-ledger` (shipped), `agentic-05-skills` (shipped).

### agentic-07-review: feat(review): evidence-based review before proposing completion

**Week:** 3 | **Labels:** `architecture`, `agentic-flow`, `security`, `roadmap` | **Earliest:** 2026-11-17 UTC

## Context

Response honesty checks and tool confirmations are useful but do not independently assess a coding diff against the approved design and test evidence.

## Upgraded design specification

Use a fresh, read-only local reviewer context with approved plan, bounded diff and receipts; separately report spec and quality findings with severity and evidence. Deterministic missing/failing/stale evidence blocks done regardless of model output; critical findings block completion until fixed and re-reviewed, with capped retries and human escalation. Before approval, show exact proposed action and deterministic warnings; model self-review is advisory, never a security decision or a substitute for approval.

## Affected files / modules

- `src/agent/review.js (new)`
- `src/agent/worker.js (new)`
- `src/agent/ledger.js (new)`
- `test/agent-review.test.js (new)`

## Acceptance criteria

- [ ] Injected critical finding blocks done until a fresh review of a changed revision resolves it.
- [ ] Hallucinated review success cannot override a failed or stale deterministic receipt.
- [ ] Reviewer cannot invoke write, shell, network or alter approvals; malformed output fails closed and requests human review.

## How to verify

```bash
node --test test/agent-review.test.js test/guard.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: `agentic-04-tdd` (shipped), `agentic-06-worker` (shipped).

### agentic-08-finish: feat(agent): transparent branch finishing and safe recovery

**Week:** 3 | **Labels:** `security`, `agentic-flow`, `roadmap` | **Earliest:** 2026-11-17 UTC

## Context

There is no structured handoff from isolated coding work with reviewed verification evidence and safe cleanup.

## Upgraded design specification

Show base and final SHA, diff summary, tests and unresolved findings. Offer keep, export patch, or separately approve integration; do not auto-push, merge, delete branches or discard dirty/untracked work. Recheck worktree identity, base divergence, status and approval immediately before any mutation; on mismatch stop and retain data. Cleanup is an explicit action with a preview and refuses dirty worktrees.

## Affected files / modules

- `src/agent/finish.js (new)`
- `src/agent/worktree.js (new)`
- `src/agent/ledger.js (new)`
- `test/agent-finish.test.js (new)`

## Acceptance criteria

- [ ] A changed base, unknown worktree identity or dirty/untracked file prevents cleanup/integration.
- [ ] Every destructive action needs fresh explicit approval, and unattended mode refuses it.
- [ ] Failure leaves the worktree intact and presents manual recovery; no push happens by default.

## How to verify

```bash
node --test test/agent-finish.test.js test/agent-worktree.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: `agentic-03-worktree` (shipped), `agentic-07-review` (shipped).

### agentic-09-debug: feat(agent): structured local debugging and blocked-state handoff

**Week:** 3 | **Labels:** `agentic-flow`, `architecture`, `roadmap` | **Earliest:** 2026-11-17 UTC

## Context

The prompt advises testing a hypothesis after failure but there is no structured mechanism to track evidence, retries or escalation.

## Upgraded design specification

For coding tasks, add a compact debugging skill that records observed failure, one falsifiable hypothesis, a proposed minimally invasive check, result and next decision. Limit retries, never rewrite evidence or invent a root cause, and escalate on recurring or unverified failures. Commands still use normal tool approval and local model restrictions.

## Affected files / modules

- `src/agent/debug.js (new)`
- `src/agent/workflow.js (new)`
- `src/skills/registry.js (new)`
- `test/agent-debug.test.js (new)`

## Acceptance criteria

- [ ] A deterministic fake failure advances observation → hypothesis → approved check → result; denial halts.
- [ ] After a fixed retry budget the task becomes blocked and exposes evidence and uncertainty.
- [ ] No diagnostic content is uploaded; ordinary chat does not activate this workflow.

## How to verify

```bash
node --test test/agent-debug.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2 engineer-days.

## Dependencies and release window

Week 3; not before 2026-11-17 UTC. Prerequisites: `agentic-05-skills` (shipped), `agentic-02-evidence-ledger` (shipped).

### agentic-10-metrics: feat(eval): offline workflow metrics and capability inventory checks

**Week:** 4 | **Labels:** `architecture`, `growth-proposed`, `roadmap` | **Earliest:** 2026-11-24 UTC

## Context

Growth already measures repository signals, but coding workflow adoption, failure modes and evidence-backed capability changes have no focused offline inventory.

## Upgraded design specification

Aggregate only opted-in local counters (started, completed, blocked, verification status, approval denial and duration buckets) from redacted receipts with retention/deletion controls. Keep metrics local, off by default, and never send task content, paths, prompts or identifiers. Update capability inventory only as features actually ship; extend existing deterministic collectors with fixture-based checks for stale or missing evidence without model-generated issue churn.

## Affected files / modules

- `src/eval/workflow-metrics.js (new)`
- `scripts/growth.js`
- `docs/CAPABILITIES.json`
- `test/workflow-metrics.test.js (new)`
- `test/growth.test.js`

## Acceptance criteria

- [ ] Disabled metrics write nothing; enabled counters contain no prompts, paths, credentials, tool output or unique user identifiers.
- [ ] Fixture with missing evidence yields one deterministic report candidate and no direct GitHub write.
- [ ] Inventory claims link to existing files/tests; growth caps, fingerprints and maintainer review remain intact.

## How to verify

```bash
node --test test/workflow-metrics.test.js test/growth.test.js test/market.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 4; not before 2026-11-24 UTC. Prerequisites: `agentic-02-evidence-ledger` (shipped).

### agentic-11-resume: feat(agent): safe resume after context trimming and process restart

**Week:** 4 | **Labels:** `agentic-flow`, `security`, `roadmap` | **Earliest:** 2026-11-24 UTC

## Context

Budget fitting can discard conversation history and a restart loses the live state needed to safely continue a multi-step workflow.

## Upgraded design specification

Reconstruct a small data-only checkpoint from the local ledger: approved plan revision, current phase, active skill IDs, bounded recent evidence and constraints. Reapply authoritative system policy first; treat checkpoint and repository content as untrusted data. After restart require explicit resume and reapproval of pending side effects, revalidate worktree/revision and never replay a pending tool call.

## Affected files / modules

- `src/agent/resume.js (new)`
- `src/agent/ledger.js (new)`
- `src/budget.js`
- `src/agent.js`
- `test/agent-resume.test.js (new)`

## Acceptance criteria

- [ ] After simulated trimming the system policy and active approved constraints remain within the context budget.
- [ ] Restart during a pending dangerous operation produces paused state and zero tool executions until new approval.
- [ ] Stale or corrupted checkpoints, changed base and session mismatch fail closed without cross-session disclosure.

## How to verify

```bash
node --test test/agent-resume.test.js test/agent.test.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

2–3 engineer-days.

## Dependencies and release window

Week 4; not before 2026-11-24 UTC. Prerequisites: `agentic-02-evidence-ledger` (shipped), `agentic-05-skills` (shipped), `agentic-07-review` (shipped).

### agentic-12-release: test(agent): offline end-to-end safety and rollout gate

**Week:** 4 | **Labels:** `security`, `tdd-engine`, `roadmap` | **Earliest:** 2026-11-24 UTC

## Context

The proposed modules need an integrated offline regression and a product-safe rollout before their behavior can be claimed as shipped.

## Upgraded design specification

Keep the workflow behind an explicit default-off setting. Build a mock-brain, temporary Git repository end-to-end test spanning consent, plan, test failure/pass, review, handoff and cleanup refusal. Exercise session-bound approvals, no cloud fallback, no unauthorized side effects, cancellation and restart; document exact limitations and update inventory only for implemented behaviors. On Node 22, 24 and 26 run full test suite and audit.

## Affected files / modules

- `test/agent-workflow-e2e.test.js (new)`
- `docs/CAPABILITIES.json`
- `docs/GUIDE.md`
- `src/config.js`

## Acceptance criteria

- [ ] With feature disabled existing conversation, tools, approvals and scheduler behaviors are unchanged.
- [ ] With feature enabled fake model and local Git complete the happy path without internet or an Ollama server; denial, malicious skill, stale evidence and crash paths stay blocked.
- [ ] CI runs node --test and node scripts/audit.js on supported Node versions; docs explicitly state worktrees are not a security sandbox.

## How to verify

```bash
node --test test/agent-workflow-e2e.test.js && node --test && node scripts/audit.js
```

Use `node:test` with temporary directories and deterministic fakes; no real secrets, external service or model required. Implement tests first and demonstrate the expected failure before the fix.

## Time estimate

3–4 engineer-days.

## Dependencies and release window

Week 4; not before 2026-11-24 UTC. Prerequisites: `agentic-04-tdd` (shipped), `agentic-07-review` (shipped), `agentic-08-finish` (shipped), `agentic-09-debug` (shipped), `agentic-10-metrics` (shipped), `agentic-11-resume` (shipped).
