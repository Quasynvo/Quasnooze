> **Historical proposal/evidence:** this document records the earlier Pinch-era proposal and its own checks. For the adopted Quasnooze / Quasynvo identity and current compatibility rules, see [the rebrand guide](REBRANDING.md). Historical names, source links and results below are preserved rather than rewritten as new evidence.

# Pinch — proposed evidence-led product upgrade roadmap

**Status: proposal only.** Review date: **2026-11-03**. No feature, release, permissions change, issue filing, or replacement of the curated roadmap is authorized by this document.

Baseline reviewed: [`295c9c768c73cbcce7c9234e2cdf2b831fc5c6e6`](https://github.com/pinchfoundry/Pinch/tree/295c9c768c73cbcce7c9234e2cdf2b831fc5c6e6) (merge of PR #82). Current file links below refer to the proposal branch; that baseline pins the inspected implementation.

Read alongside the [primary-source competitor comparison](research/2026-11-03-PINCH-COMPARISON.md) and [star/commit/license snapshot](research/2026-11-03-comparator-snapshot.json). Source IDs S1–S9 and D1–D2 below resolve there. The supplied earlier assessment was treated as hypotheses to check, not a completed test report.

## A. Executive decision

Build **a dependable, permission-aware Windows companion for a small set of everyday tasks**, with local inference/data by default. Do not aim for generic enterprise-chat parity or promise that Pinch is already faster or safer than larger projects.

**Keep:** deterministic native intents, local-model selection, explicit action approval, source-backed answers, bounded retrieval, opt-in local voice and lightweight dependencies.

**Upgrade first:** measurable readiness/performance, crash/reconnect recovery and durable per-user configuration/state. Then evaluate selective tool schemas, safe cancellation, clearer permission previews and better retrieval/retention controls. Existing voice consent, personas, history search and local plugin loading should be maintained and tested—not proposed as missing features.

**The differentiation is a testable product outcome, not a marketing assertion:** a non-technical user can understand readiness, complete an allowed local task, interrupt safely, recover from a restart, and see exactly what ran without silently broadening access.

### Competitive lessons

- S1 OpenClaw: gateway readiness, effective policy and lifecycle visibility. Its own docs say sandboxing is off by default; local does not imply contained.
- S2 Open WebUI / S5 LibreChat: visible task phases, accessible controls and source/tool activity. Adopt compact local UX, not multi-user enterprise infrastructure.
- S4 AnythingLLM: relevant-tool provisioning and ingestion visibility. Evaluate low-cost selection; its documented reranker overhead may hurt small local workloads.
- S6 Jan / S9 PowerToys: model onboarding and keyboard-first desktop access. Pinch already has a hotkey and command deck; improve discovery and acceptance testing rather than build duplicate launchers.
- S3 Open Interpreter / S8 llama.cpp: explicit execution boundaries and reproducible inference measurement. Their documented capabilities are not Pinch benchmarks.
- S7 Khoj: knowledge profiles and opt-in useful recurring tasks. Keep read-only automation boundaries and deliberate retention.

## B. Current state — implementation is not validation or release

| Area | Local evidence / inspected behavior | State and remaining evidence |
|---|---|---|
| Model/runtime | [brain.js](../src/brain.js), [model-choice.js](../src/model-choice.js), [budget.js](../src/budget.js) | Local/default and runtime switching exist. Provider settings/timeouts are implemented; representative hardware speed/quality is **unmeasured here**. |
| Security/approvals | [agent.js](../src/agent.js): `runAgent`, `createApproval`; [risk.js](../src/risk.js); [tools.js](../src/tools.js) | Code-enforced approvals, bounded paths, screening and secret scrubbing exist. Passing audits are not proof of no vulnerabilities or OS-level isolation. |
| Desktop presence | [desktop.js](../src/desktop.js): `DesktopRuntime`; [windows-companion.js](../src/windows-companion.js): `startWindowsCompanion`; [Companion.cs](../desktop/Companion.cs) | Tray/native host, availability states and deterministic intents exist. Exit/error cleanup already exists. No bounded automatic restart loop is present in the inspected bridge. Real-device failure/recovery remains unverified; no reproduced universal hang is asserted. |
| Voice | [VOICE.md](VOICE.md), [VOICE-REVIEW.md](VOICE-REVIEW.md), [SpeechDoctor.cs](../desktop/SpeechDoctor.cs), [voice-reply tests](../test/voice-reply.test.js) | Muted startup/consent, local Windows speech and local-service browser reply voices exist. Browser dictation privacy is separate. Wake accuracy, acoustic false activations, devices and interruption need physical tests. |
| Onboarding/state | [setup.js](../scripts/setup.js), [config.js](../src/config.js), [braincheck.js](../scripts/braincheck.js) | Setup/doctor/model probes exist. Defaults locate `.env`/`data` under package root; fragility under global/npx install/update is a **design inference to reproduce**, not a tested user-loss incident. |
| Search/knowledge | [documents.js](../src/documents.js), [store.js](../src/store.js), [sources.js](../src/sources.js), [citations.js](../src/citations.js) | Bounded incremental BM25, local history and citation checks exist. Citation-validity tests do not prove retrieval relevance or answer faithfulness. |
| Presets/extensions | [personas.js](../src/personas.js), [tools.js](../src/tools.js): `loadLocalTools`; [custom-tools.js](../src/custom-tools.js), [mcp.js](../src/mcp.js) | Implemented. Local JS import is arbitrary owner-reviewed code outside per-call approval; subprocess execution alone would not make it safe. |
| Observability | [telemetry.js](../src/telemetry.js), [agent.js](../src/agent.js) | Local bounded/rotated aggregate records, first-text timing and health summaries exist. Extend phase attribution rather than claiming no instrumentation. |
| Portability | [export.js](../src/export.js), [store.js](../src/store.js) | Versioned export exists. No corresponding complete validated import/restore path was identified in the CLI. Exported user content can be private despite excluding `.env`. |
| Delivery | [package.json](../package.json), [ci.yml](../.github/workflows/ci.yml), [roadmap.json](../.github/roadmap.json) | Safe packlist tests and CI exist. GitHub Releases API returned zero release entries during review; npm publication/signing/update behavior was **not verified**. |

## C. Existing roadmap reconciliation

The 11 curated task issues are closed in the inspected issue snapshot: #22, #23, #24, #41, #42, #43, #44, #59, #62, #63 and #65. That does not independently prove each release gate. Roadmap metadata still has three `shipped`, four `ready`, four `backlog`, and an empty `latest_release`.

| Existing work | Disposition / next action |
|---|---|
| 001 doctor docs; 002 symlink regression; 003 CLI smoke | Maintain existing implementation/tests; review release references rather than repeating the tasks. |
| 004 history search; 005 Telegram reply context | Keep implemented baseline; add scale/approval-routing cases only when a measured gap warrants them. |
| 006 Whisper health/bounds | Maintain input/security tests; real microphone acceptance is separate and not supplied by transcription HTTP mocks. |
| 007 model switching | Maintain; add readiness/hardware measurements to existing model control. |
| 008 personas | Already implemented, exported, documented and safety-tested. Capability status was corrected to `have`; do not create another persona implementation issue. |
| 009 npm preparation | Package preparation exists. Do not call it a published/tested installer or silently publish a package. |
| 010 local plugins | Implemented opt-in loader; retain explicit unsandboxed-import warnings and workspace placement restrictions. |
| 011 workspace documents | Implemented bounded retrieval; evaluate corpus quality before adding semantic infrastructure. |
| #60 voice replies; #68 persona inventory; #71 environment docs | Merged in baseline history (#80/#81/#82); maintenance/validation, not missing-feature work. |
| #40 rolling dashboard | Keep open while its workflow expects an open tracker. Reconcile implementation/release metadata through a separate reviewed change; do not blanket-mark tasks released. |

## D. Delivery sequence

Effort below is an **engineering estimate**, not a commitment: S = 1–3 developer-days, M = 4–8, L = 9–15; hardware access, external review, installer signing and user-study lead time are excluded. Confidence is lower where platform work is involved. Keep at most two implementation items active; do not run every row in parallel.

### NOW — first delivery cycle (three bounded workstreams)

#### N1 · P0 · Readiness + reproducible performance baseline

**Problem/evidence:** users cannot infer a complete local turn from model selection or native compilation. Existing setup/brain checks and local telemetry provide building blocks (S6/S8 inform measurement).

**Scope:** structured readiness report for model installed/reachable, workspace/state writable, native host and speech availability; extend existing diagnostics with local phase timings. Use fixed synthetic scenarios and record hardware/OS/driver/model digest/quantization/context/sampling settings. No hidden model downloads, microphone capture or content telemetry.

**Acceptance:**
- Distinct missing-model, unreachable-backend, unavailable-companion, mic-disabled and ready states with an actionable next step; no misleading green readiness from a selected model name.
- A local JSON benchmark artifact separates deterministic command, first visible text, full answer and optional consented speech latency; includes warm/cold status, errors, n, p50/p95 and peak resource observations where measurable.
- Existing telemetry contains no prompt/response/clipboard/file-content addition by default; a diagnostics preview demonstrates redaction.
- Performance results label OS measurements vs mocks and inference vs orchestration; unsupported machines are not assigned fabricated hardware tiers.

**Tests/gate:** mocked readiness/failure fixtures, secret-canary output checks, deterministic schema tests; manual first successful local turn on agreed Windows machines. Prerequisite for performance claims in N2/T1. **Effort M, confidence medium.** Owner role: runtime/onboarding maintainer plus hardware tester.

#### N2 · P0 · Bounded resident recovery, always muted on reattach

**Problem/evidence:** bridge cleanup exists but an inspected automatic restart/reconnect loop does not. S1/S9 suggest understandable lifecycle UX, not silent background authority.

**Scope:** startup-ready timeout, crash/backoff/exhausted states, explicit retry/restart and bounded reconnect; preserve existing detach cleanup. Do not persist an approval grant or automatically re-run an interrupted action. Do not claim to resume an unknown side effect safely.

**Acceptance:**
- Simulated crash, pipe failure and no-ready child cannot leave a false ready state; UI shows recovery or a usable failure explanation.
- At most three bounded restart attempts per recovery episode, then explicit user retry; no tight respawn loop. Exact delays configurable in tests, not a new general configuration surface without need.
- Reattach is muted with fresh consent, invalidates stale approval IDs, and does not replay commands. Quit stops retries.
- A reminder is not displayed as delivered until its actual delivery outcome is known; interrupted side effects are shown as unknown where verification is impossible.

**Tests/gate:** injected child/clock lifecycle tests, duplicate/stale event and approval tests; physical Windows logout/login, sleep/wake, device-disconnect and host-crash checklist. No microphone rearm while testing automatic recovery. N1 supplies timings. **Effort M–L, confidence medium-low.** Owner role: desktop maintainer + independent security reviewer.

#### N3 · P0 · Durable per-user state and readiness-led migration

**Problem/evidence:** config/setup default to package-relative paths; global/npm-cache installs may be read-only, replaced or ephemeral. Reproduce those paths before changing defaults. S6 is a UX reference, not proof of a migration design.

**Scope:** propose one platform-appropriate per-user config/data resolver shared by setup/runtime; retain explicit `PINCH_DATA`, workspaces and compatible clone workflows. Detect legacy state, preview source/destination and back up before explicit migration. No silent data move or merge.

**Acceptance:**
- Fresh, clone, extracted package, global-style read-only and npx-cache-like fixtures find stable owner-writable state across restart/update; existing installs are not silently abandoned.
- Migration requires confirmation, does not overwrite conflicting destinations, and has a tested rollback or leaves the original intact after every failed write/rename.
- No config keys/content in logs or public files; OS-appropriate ACL/permissions are verified where supported, with limitations reported.
- Uninstall clearly distinguishes app removal from deleting personal data. No npm release or unsigned automatic updater is included in this workstream.

**Tests/gate:** path-resolution fixtures on Windows/Linux CI, failure injection, conflicting state/rollback, new/legacy setup journeys. Reuse the existing readiness checks. **Effort M–L, confidence medium-low.** Owner role: packaging/config maintainer.

### NEXT — enter only after NOW has acceptance evidence

| ID / outcome | Evidence, scope and non-goals | Acceptance, validation and safety gate | Dependencies / estimate |
|---|---|---|---|
| T1 · P1 · Relevant tools with less prompt overhead | S4/D2; `agent.js` full-schema turns. Deterministic tool-family selection plus explicit full-tool fallback. Not an LLM router or permission grant. | Holdout tasks compare full vs selected schemas. Record selection overhead, schema tokens and action completion. Do not ship default selection if needed-tool recall or safe task success declines. All selected tools use the same registry/approval checks, including malicious arguments. | N1; M, medium. Proposed experiment goals in §E, not achieved results. |
| T2 · P1 · Safe turn cancellation and visible progress | S2/S5; `stop-voice` is not tool cancellation; provider timeouts are not user cancellation. Add session-scoped cancellation propagation, bounded tool interruption where supported, and phase/status UI. | Abort generation, invalidate waiting approvals and stop future dispatch. Stop a supported shell process tree with tested semantics; report unknown/non-cancellable side effects honestly. Another session cannot cancel this one. Tests cover partial writes, delayed callbacks and retries. No rollback promise for already-completed external effects. | N2 stable lifecycle; M–L, medium-low. |
| T3 · P1 · Previewable action permissions and local execution timeline | S3/S5/S1; existing approval descriptions and telemetry. Show target, scope, data destination and approval duration; explain effective policy. No broad permanent Full Access mode. | Cross-session/expired approvals fail; changes to action arguments invalidate grants. Timeline proves executed/denied/failed/unknown states with synthetic secret-canary redaction. Exports require preview and consent; no external analytics by default. | N1/N2; M, medium. Security reviewer required. |
| T4 · P1 · Versioned local backup and validated restore | Existing export only; improve portability rather than cloud sync. Preview merge/replace effects; validate schema, field sizes and paths; back up before applying. | Invalid/corrupt/oversized/conflicting payloads leave live state unchanged. Prevent traversal/symlinks, config/credential/plugin execution and imported approval grants. Reminders/schedules restored disabled until deliberately re-enabled. Round-trip and interruption/failure tests required. | N3 path model; L, medium-low. |
| T5 · P1 · Everyday task acceptance pack | PowerToys/S9 informs discoverability. Refine existing clock/status, allowlisted app launch, bounded file lookup, clipboard and reminders; do not build general computer control. | Synthetic/consented end-to-end tasks verify actual effects and explicit failure states, accessible keyboard/screen-reader paths and permission denials. Clipboard is not added to model history by default. Reminder limitations for offline/asleep hosts stay visible. | N1–N3; M + hardware/user-study access, medium. |

### LATER — evidence must justify added surface

| ID | Upgrade / user outcome | Required proof before implementation | Effort / dependencies |
|---|---|---|---|
| L1 · P2 | Retrieval quality + ingestion transparency (S2/S4/S7) | A synthetic corpus with answerable/unanswerable questions, skipped/stale file indicators, recall@k/MRR and citation/answer-faithfulness review. Add optional local embeddings/reranking only after a measurable lexical-baseline gain within resource/privacy limits. Never fabricate a reference or require a remote vector store. | M evaluation, L optional adapter; N1/T3. |
| L2 · P2 | Memory retention and opt-in read-only briefings (S1/S7) | Inspect/delete/expire saved facts and session retention; a purge also removes applicable indexes/derived cache. Schedules show last run/result and resource limits. No auto-imported schedules, opaque inferred memory or sensitive unattended action escalation. | M–L; N3/T4. |
| L3 · P2 | Plugin isolation and sandbox feasibility (S3/D1) | Separate robustness isolation from OS confinement. Threat model file/network/credentials/subprocesses and test supported Windows boundaries before claiming isolation. Preserve workspace and explicit-trust rules; no auto-installation or arbitrary import in the trusted host as a new default. | M design spike, L+ implementation only after review; T3. |
| L4 · P2 | Signed, recoverable desktop release/update path | Reproducible artifacts, ownership of signing keys, verified update manifests, rollback, user-state survival and an offline/manual install option. No credentials in CI logs; permissions changes separately approved. | L + signing/operational work; N3/T4 and hardware release gate. |

### DEFER / DO NOT BUILD by default

- Mandatory cloud audio, automatic provider fallback or silent model/file uploads.
- Enterprise tenants/SSO/social channels, image/video generation, calendars/mail accounts and multi-agent swarms merely to match competitor checklists.
- Unbounded browser/desktop automation, unattended sensitive actions, self-installing skill marketplaces or grants persisted by an imported prompt/persona.
- Always-on microphone without explicit opt-in; voice activity/wake phrase as authentication.
- A rewritten UI/runtime stack without measured evidence that the existing architecture prevents the target workflow.

## E. How to prove "faster, safer and easier"

These are **proposed experimental criteria**, not achieved improvements or comparative rankings. Revisit budgets after N1; do not sacrifice safety or task quality to pass a latency threshold.

### Speed protocol

1. Commit a synthetic task corpus: 10 deterministic everyday commands, 10 local knowledge queries and 10 tool-using tasks; separate unsupported tasks from failures. All filesystem/process effects stay in disposable approved fixtures.
2. Measure current Pinch vs candidate on the same machine, model digest/quantization, backend version, context/output limits, sampling, concurrency=1 and input history. Separate warm and cold starts; randomize run order. Use at least 20 repetitions per comparable scenario; disclose n/timeouts, p50/p95 and uncertainty. Do not report a stable p95 from three trials.
3. Capture route and phase times: startup-ready, UI acknowledgement, dispatch, prompt processing, first visible text, full completion and optional consented audio. Never equate a clock-handler millisecond with LLM or wake latency. `llama-bench` (S8) characterizes inference separately; existing Ollama timings can supplement it.
4. Tool-selection experiment: provisional goal >=20% median schema-token reduction on the tool-heavy subset, with no observed needed-tool misses or safe task-success regression in holdout tests; require <=5% warm p95 completion regression before enabling by default. These are design budgets requiring measured results, not guarantees.
5. Cross-product comparisons require the same supported task, actual model/backend controls and permission posture. If those cannot be held equal, publish capability/workflow differences, not a "Pinch is X% faster" result. No competitor timing was collected in this review.

### Security protocol

- Establish an explicit threat model: hostile prompt/tool/document, cross-session user, untrusted plugin, credential theft, network exposure, corrupted backup and local same-user code. Built-in path checks do not contain arbitrary host code.
- Extend existing denial/regression suites with stale/replayed approval, cancellation race, import/restore traversal, plugin exfiltration and reconnect cases as applicable. No actual credentials or live destructive targets.
- Permission refusals must precede execution. No performance feature may change that invariant. Red-team results are scoped evidence, not proof of total security.
- Observe traffic in an isolated test: local-mode inference/audio paths must not silently send data off-device. Document optional browser/provider behaviors separately; downloads and consented integrations are not magically offline.
- Require independent review for changes to permissions, file/process execution, memory import, plugins or network exposure; keep branch protections and human merges.

### Usage protocol

- Pilot the same 5 core journeys: fresh setup -> first local turn; mute/wake/talk/stop; find a workspace file with source; launch an allowlisted app with approval; reminder plus restart/failure explanation.
- Recruit an initial **five consenting non-maintainer users** across an agreed Windows hardware matrix. Measure completion, time, errors, help requests, and whether they correctly identify microphone/approval state. This is a formative sample, not a population-level claim.
- Provisional release gate: all safety-critical consent/denial/restart cases pass; every pilot participant can distinguish muted, active, unavailable and permission-waiting states after onboarding. Record assistance; do not convert coached completion into unassisted success.
- Hardware matrix proposal: CPU-only/integrated graphics and discrete-GPU Windows 10/11 machines, different microphones, missing English speech pack, sleep/wake and device-switch conditions. Confirm accessible machines before promising coverage or model sizes. Mock/CI compilation does not replace these checks.

## F. First three GitHub-ready issue drafts

These drafts are **not filed**. After maintainer approval, create only the first items with owners and dependencies; link this proposal rather than flooding the queue.

### Draft 1 — feat(diagnostics): report local readiness and record a reproducible latency baseline

**Problem:** existing setup/model selection, runtime health and first-text timings do not constitute one verified first-run readiness journey.

**Evidence:** `scripts/setup.js`, `scripts/braincheck.js`, `src/telemetry.js`, `src/agent.js`; N1 above.

**Scope:** reuse those components; return structured readiness states and content-free phase measurements. No model download, microphone capture or external metrics upload by default.

**Acceptance:** distinguish missing/unreachable model, unavailable companion and muted mic; give next actions; produce versioned synthetic benchmark JSON with settings/n/warm-cold/error/percentiles; secret-canary checks and mocked failures pass; a consented Windows first turn is documented separately.

**Verification:** targeted new readiness/schema tests, existing CLI/desktop tests, full suite and audit. Hardware report must list what was actually run. **Estimate M; maintainer + hardware tester; first dependency.**

### Draft 2 — fix(desktop): recover from native host failure without replaying approvals or microphone consent

**Problem:** existing detach cleanup should be preserved but does not provide a bounded automatic restart/recovery experience.

**Evidence:** `startWindowsCompanion()` exit/error handlers, `DesktopRuntime.detach()`, `docs/DESKTOP.md`.

**Acceptance:** ready timeout, three-attempt bounded recovery and explicit retry; quit cancels retries; reattach muted; old approvals and commands never replay; unknown interrupted actions labelled unknown. Inject child/clock failures in tests; validate crash/sleep-wake on real Windows. **Estimate M–L; N1 first.**

### Draft 3 — fix(config): preserve user configuration and state across packaged installs and updates

**Problem:** current ROOT-relative `.env`/`data` defaults may not be durable/writable in global/npx-style installs; reproduce before selecting migration behavior.

**Evidence:** `src/config.js`, `scripts/setup.js`, `src/export.js`, package/extracted-CLI tests.

**Acceptance:** one tested config/state resolver; backward-compatible explicit overrides; confirmation/preview/no overwrite; preserved originals or rollback on every failed migration step; config/keys absent from output; clone/read-only install/cache replacement/Windows CI fixtures. Do not publish a release as part of the fix. **Estimate M–L; coordinate with N1.**

## G. Sustainable product loop

Keep one product roadmap with core/runtime, Windows/voice, knowledge and delivery **lanes**, not competing roadmaps. Keep #40 as a live dashboard. Promote a small NOW queue through normal reviewed PRs; do not rewrite `.github/roadmap.json` from this proposal automatically.

The existing Growth loop is already configured hourly. Research cadence is not a requirement to file an issue every hour. Keep evidence thresholds, deduplication, open-work caps and pause controls; add local usability/failure evidence alongside README comparisons. Compare future proposals against actual main, not stale issue bodies. A quiet run can be correct.

For each item record independent states: **proposed -> implemented in main -> automated tests passed -> manual/hardware acceptance -> release artifact published -> user outcome observed**. Do not use one `shipped` checkbox for all six. Declined/closed work must carry a reason; release metadata needs actual tags/artifacts rather than invented versions. Revisit priorities after each accepted delivery cycle and prune speculative work.

### Maintainer decisions before scheduling

1. Confirm Windows resident use as the primary supported product experience and define actual test machines/accessibility participants.
2. Approve the per-user state/migration policy, secrets handling and installer/update ownership.
3. Choose initial task corpus, supported actions and measurable performance/resource budgets from real baselines.
4. Decide optional sandbox/OCR/semantic dependencies only after threat model, licenses and benchmarks; retain a lightweight default.
5. Assign independent reviewers and explicit release/hardware sign-off owners. No permissions changes are made by this proposal.

## H. Verification and uncertainty ledger

### Actually run in this research session

- Fresh clone and checkout of the pinned Pinch baseline; inspected source, docs, config, workflows, package metadata and current issue/release API data.
- Node 22 `node --test --test-concurrency=4`: **495/495 passed**, no failures/skips. Full CLI packaging cases are part of this suite.
- Node 22 `node scripts/audit.js`: **16/16 passed**. This is a scoped self-check, not an independent penetration test.
- Node 22 `node scripts/validate-roadmap.js`: passed, **11 items**, **4 filing candidates**, cap **3**. Validator success does not reconcile release metadata.
- Read seven assistant + two adjacent repository metadata/default-branch READMEs, pinned commits; inspected the ambiguous Open WebUI/Jan licenses, llama-bench guide and official D1/D2 documentation. Snapshot contains observed stars, API license data and references.
- GitHub snapshot returned only #40 open among fetched issues/PRs and no GitHub Release entries. States can change; npm publication, all CI executions and every historical closure were not independently release-audited.

### Not performed / not claimed

Physical Windows login/device/voice tests; real microphone capture; CPU/GPU inference benchmarks; cross-product performance/security tests; user study; independent penetration test; installer signing/release validation; npm publication check; implementation of any proposed feature.

**Conclusion:** approve an evidence-led small upgrade cycle, not a claim that Pinch is already the fastest, safest or best assistant. The proposed improvements have explicit acceptance and comparison gates so those claims can eventually be tested rather than assumed.
