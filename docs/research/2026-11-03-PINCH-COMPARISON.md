# Pinch: primary-source comparison and upgrade opportunities

Review date: **2026-11-03**. Pinch baseline: [`295c9c7`](https://github.com/pinchfoundry/Pinch/tree/295c9c768c73cbcce7c9234e2cdf2b831fc5c6e6).

## Method and limits

Seven highly starred, relevant assistant projects were selected for personal-agent, local desktop, retrieval, or interaction relevance. Two additional projects inform runtime benchmarking and Windows UX. This is a **purposive sample, not an exhaustive ranking of every related repository**. GitHub repository search and public web search helped discovery; feature conclusions below use the projects' own pinned READMEs and explicitly listed official documentation, not third-party roundup claims.

Star counts are live GitHub REST observations collected during this review and saved in [the machine-readable snapshot](2026-11-03-comparator-snapshot.json). They change and are not evidence of security, speed, usability, active installation counts, or suitability for Pinch. READMEs establish **documented capabilities**, not independently verified behavior. No competitor was installed, penetration-tested, timed or evaluated with real users. Official documentation links D1/D2 are unpinned web documents and may change.

GitHub redirects were followed: `danny-avila/LibreChat` currently resolves to `LibreChat-AI/LibreChat`; `menloresearch/jan` resolves to `janhq/jan`; `openinterpreter/open-interpreter` resolves to `openinterpreter/openinterpreter`. Recommendations use current primary sources rather than assuming old product descriptions still apply.

## Comparable assistants — ordered by observed stars within this sample

| Source | Project | Observed stars | What its primary source documents | Relevant lesson; not a superiority claim |
|---|---|---:|---|---|
| S1 | OpenClaw | 393,744 | Local gateway for sessions/tools/channels; onboarding verifies model access; local/hosted model plugins and device companions. README says main-session tools run on host unless sandboxing is configured. | Adopt explicit readiness, effective-policy explanations and recovery-oriented operations. Do not inherit broad host authority or assume the default is sandboxed. |
| S2 | Open WebUI | 157,572 | Persistent memory, live workflows, recurring automations, hybrid retrieval/reranking, and multiple speech providers. README links a separate desktop project with a system-wide chat bar and push-to-talk. | Borrow visible task progress, keyboard-first access and evaluated retrieval. Keep Pinch's single-user local path small; do not replicate an enterprise platform or assume all speech is local. |
| S3 | Open Interpreter | 68,779 | The current README describes a Codex-fork coding agent focused on low-cost model harnesses, native sandboxing, permissions, local session state and model switching. | Borrow explicit execution boundaries and clear execution-state UX. Do not describe the current project solely using older generic computer-control descriptions, or assume Pinch's JS path checks equal native sandboxing. |
| S4 | AnythingLLM | 67,861 | Local/cloud model connections, document workspaces, source citations, agents, dynamic model routing and intelligent tool selection. | Evaluate reducing irrelevant tool schemas and clearer ingestion status. Prefer a lightweight selector before adding a reranker or vector stack. |
| S5 | LibreChat | 46,644 | Ask/Allow/Deny code controls; trace viewer; checkpoint recovery; local/remote providers and attachment/tool provisioning. | Borrow understandable action previews and local, redacted execution timelines. Avoid a Full-access default, tenant infrastructure or mandatory external observability. |
| S6 | Jan | 45,332 | Desktop downloads, local model downloads, optional cloud providers, local OpenAI-compatible API and MCP. | Borrow model acquisition/readiness UX and explicit provider identity. A downloadable application is not itself proof of reliable Windows startup or microphone performance. |
| S7 | Khoj | 37,946 | Document/semantic search, custom knowledge/persona/model/tool agents, recurring research notifications and voice interactions. | Borrow evidence-bound knowledge profiles and reviewable read-only briefings. Keep retention and background runs explicit rather than importing an enterprise/cloud architecture. |

## Adjacent references — not assistant parity scores

| Source | Project | Observed stars | Verified documentary relevance |
|---|---|---:|---|
| S8 | llama.cpp | 133,176 | README documents quantization and CPU/GPU hybrid inference. The pinned `llama-bench` guide exposes repetition, warmup, prompt-processing, generation and structured output options. Use it to characterize inference independently of Pinch orchestration; it does not measure microphone-to-action latency. |
| S9 | PowerToys | 140,428 | README lists Command Palette, PowerToys Run and keyboard utilities, with Windows install paths. Study discoverable keyboard UX and explicit command selection; it is not an LLM assistant and its popularity cannot establish AI quality. |

## Capability transfer decisions

| Pattern | Pinch now, with local evidence | Proposed adaptation | Decision |
|---|---|---|---|
| Readiness-led onboarding (S1/S6) | `scripts/setup.js`, `scripts/braincheck.js`, `src/model-choice.js` already exist. `src/config.js` and setup still use package-relative config/state defaults. | A structured readiness result and durable per-user state location, with explicit migration/rollback and no hidden download. | NOW; improve existing components, do not create a competing setup stack. |
| Resident lifecycle visibility (S1/S9) | `src/windows-companion.js` already detaches on exit/error and rejects pending actions. `src/desktop.js` already models availability/mute/speech/busy state. | Add tested restart/reconnect/ready timeouts and visible recovery with bounded backoff; never restore microphone arming or replay approvals automatically. | NOW; missing automatic recovery is a code observation, not a reproduced hardware hang. |
| Schema selection (S4) | `src/agent.js` generally passes `toolSchemas()` on full turns; existing social routing and deterministic desktop intents already avoid much overhead. | Optional deterministic tool families with an explicit full-tool fallback, evaluated against full-schema baseline. Permission checks remain independent of tool visibility. | NEXT, benchmark-gated. |
| Trace viewer (S5) | `src/telemetry.js` already records local aggregate durations, token approximations, guard/error metadata without message text. Desktop keeps a small command history. | Add local phase timestamps and a redacted per-turn timeline; diagnostics export requires preview/consent and excludes content/secrets by default. | Extend, not duplicate telemetry; no external collector by default. |
| Native sandbox/permissions (S3; S1/D1) | `src/tools.js` confines built-in paths and scrubs child credentials; approval does not create an OS sandbox. Local JS modules run at import time outside call approval, explicitly documented. | First improve effective-permission explanations. Investigate optional process isolation and OS sandboxing separately; a subprocess or scrubbed env alone does not stop filesystem/network access. | Security design spike before any containment claim. |
| Retrieval/workspaces (S2/S4/S7) | `src/documents.js` already has bounded BM25, fingerprinted cache invalidation and source registration. | Test answerability/citation quality, show skipped/stale files, then consider an optional local semantic adapter only if measured benefit justifies it. | Evaluate first; do not rebuild lexical retrieval or require a vector service. |
| Memory/agents/automations (S1/S2/S7) | `src/personas.js`, `src/store.js`, `src/scheduler.js` and `src/schedules.js` already supply saved presets, history and schedules; dangerous unattended calls are refused. | Retention controls and opt-in read-only briefings with run history, bounded retries and resource limits. | Later; no autonomous sensitive action bundles. |
| Browser/native computer control (S2/S3) | Native desktop intents are intentionally bounded; generic UI automation is not an existing guarantee. | A separate allowlisted, visible, consented automation experiment after lifecycle/cancellation/permission gates pass. | Defer broad control, marketplace auto-installation and credential-bearing browser sessions. |

### Avoid copying performance marketing

D2 claims tool selection can save "up to 80%" and also documents reranking overhead of **100–500 ms** and a low-end-device tradeoff. These are **vendor documentation claims, not measurements reproduced here**; the page also makes claims about competing products that this research does not adopt. A selector can make a small Pinch workload slower. Measure both schema-token reduction and completed-task latency/quality before enabling anything by default.

## Licensing and reuse boundary

This research borrows **product patterns**, not implementations, assets or branding. Any future code reuse requires a file-level license/dependency review, applicable notices and maintainer approval. This is not legal advice.

- S1/S4/S5/S8/S9: GitHub metadata reports MIT; attribution/notice obligations still apply to reused code, and dependencies may differ.
- S3: GitHub metadata reports Apache-2.0; review its fork lineage and required notices before reuse.
- S7: GitHub metadata reports AGPL-3.0. Do not transplant code into Pinch's MIT-distributed product without reviewing compatibility and applicable obligations; an independent implementation from functional requirements avoids assuming permission to copy.
- S2: GitHub reports `NOASSERTION`. The inspected pinned LICENSE includes branding restrictions and exceptions; **do not call it ordinary MIT** or copy/rebrand its UI/code without review.
- S6: GitHub reports `NOASSERTION`; the pinned LICENSE declares Apache License 2.0 and requests attribution. Record that discrepancy, inspect the exact files and dependencies, and do not silently substitute a confident SPDX conclusion.

## Primary sources

- **S1** — [openclaw/openclaw: pinned README](https://github.com/openclaw/openclaw/blob/cd56ab1a54c81b3a515388ca1014d2d22deab1cb/README.md); [repository metadata](https://api.github.com/repos/openclaw/openclaw); commit `cd56ab1a54c81b3a515388ca1014d2d22deab1cb`.

- **S2** — [open-webui/open-webui: pinned README](https://github.com/open-webui/open-webui/blob/f7ac7ee10962ddec0017f5c29b6740d9b9c5faca/README.md); [repository metadata](https://api.github.com/repos/open-webui/open-webui); commit `f7ac7ee10962ddec0017f5c29b6740d9b9c5faca`.
  Inspected [LICENSE](https://github.com/open-webui/open-webui/blob/f7ac7ee10962ddec0017f5c29b6740d9b9c5faca/LICENSE).

- **S3** — [openinterpreter/openinterpreter: pinned README](https://github.com/openinterpreter/open-interpreter/blob/79c297a088b1d8dec415747f330f21023b7da8fc/README.md); [repository metadata](https://api.github.com/repos/openinterpreter/openinterpreter); commit `79c297a088b1d8dec415747f330f21023b7da8fc`.

- **S4** — [Mintplex-Labs/anything-llm: pinned README](https://github.com/Mintplex-Labs/anything-llm/blob/9caf2b4c29d9782f1cba4142be2525ebfa0ecd43/README.md); [repository metadata](https://api.github.com/repos/Mintplex-Labs/anything-llm); commit `9caf2b4c29d9782f1cba4142be2525ebfa0ecd43`.

- **S5** — [LibreChat-AI/LibreChat: pinned README](https://github.com/danny-avila/LibreChat/blob/f4154b649efa37e1345ccc517a4d8d1ed2178c82/README.md); [repository metadata](https://api.github.com/repos/LibreChat-AI/LibreChat); commit `f4154b649efa37e1345ccc517a4d8d1ed2178c82`.

- **S6** — [janhq/jan: pinned README](https://github.com/menloresearch/jan/blob/e3a75ab41ee9d3352e1109d38839ac61cc52d7f2/README.md); [repository metadata](https://api.github.com/repos/janhq/jan); commit `e3a75ab41ee9d3352e1109d38839ac61cc52d7f2`.
  Inspected [LICENSE](https://github.com/janhq/jan/blob/e3a75ab41ee9d3352e1109d38839ac61cc52d7f2/LICENSE).

- **S7** — [khoj-ai/khoj: pinned README](https://github.com/khoj-ai/khoj/blob/ae229ca894c0b80ad84664afcfdde523b5e87057/README.md); [repository metadata](https://api.github.com/repos/khoj-ai/khoj); commit `ae229ca894c0b80ad84664afcfdde523b5e87057`.

- **S8** — [ggml-org/llama.cpp: pinned README](https://github.com/ggml-org/llama.cpp/blob/29c720eaf72fcf8e4e61a56a88b994d92668261d/README.md); [repository metadata](https://api.github.com/repos/ggml-org/llama.cpp); commit `29c720eaf72fcf8e4e61a56a88b994d92668261d`.
  Inspected [llama-bench guide](https://github.com/ggml-org/llama.cpp/blob/29c720eaf72fcf8e4e61a56a88b994d92668261d/tools/llama-bench/README.md).

- **S9** — [microsoft/PowerToys: pinned README](https://github.com/microsoft/PowerToys/blob/780daf2c6aeb67bb6e19067a979d139435e02f94/README.md); [repository metadata](https://api.github.com/repos/microsoft/PowerToys); commit `780daf2c6aeb67bb6e19067a979d139435e02f94`.

- **D1** — [OpenClaw sandboxing documentation](https://docs.openclaw.ai/gateway/sandboxing): sandboxing off by default; gateway remains on host; tool deny policy still applies.
- **D2** — [AnythingLLM intelligent tool selection](https://docs.anythingllm.com/agent/intelligent-tool-selection): documented selection threshold, reranking overhead and low-end-device tradeoff.
