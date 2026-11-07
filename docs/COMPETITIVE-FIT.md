# Competitive fit: local conversational assistants (2026-11-07)

Companion to [COMPETITIVE-FRONTIER.md](COMPETITIVE-FRONTIER.md) (voice/OS
control) and [CAPABILITIES.json](CAPABILITIES.json) (what we can *prove*).
This note is a product-architecture filter: what the leaders do, what we
already have, what we refuse, and what we take — rewritten so it is faster
or stricter on **one laptop, zero runtime deps, permission-first**.

Star counts below are **reported by third-party write-ups in 2026**, not a
live `api.github.com` fetch on this date. Treat them as order-of-magnitude.

---

## 1. Landscape

The domain is **self-hosted personal assistants that talk and act**, not
model servers and not coding IDEs.

| Leader | Role | USP we do not copy blindly | Structural hole |
|---|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | Full personal assistant, many channels, skills, browser CDP | Reach and 24/7 “digital employee” | Skills are prose re-read every turn; host execution; security CVEs in 2026 write-ups ([3](https://www.mgsoftware.nl/en/blog/openclaw-the-open-source-ai-assistant-taking-over-github)) |
| [openinterpreter/open-interpreter](https://github.com/openinterpreter/open-interpreter) | Natural language → code on the machine | Code as the universal action | No voice loop, no per-action approval, AGPL |
| [janction/jan](https://github.com/janhq/jan) (Jan.ai) | Desktop chat + local GGUF | One-click model UX | Not an acting assistant; Electron weight |
| [livekit/agents](https://github.com/livekit/agents) / [pipecat-ai/pipecat](https://github.com/pipecat-ai/pipecat) | Realtime voice *frameworks* | Semantic turn-taking, barge-in, first audio | You still bring the agent, the laptop, the permissions |
| [OpenAdaptAI/OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt) | Record → compile → verify GUI tasks | Outcome verification vs the system of record | Not conversational; you record by hand |

Quasnooze’s identity (from `.github/prompts/self-improvement.md`): **Ollama
default, no `dependencies`, one person, the gates are the product.**

### What we already lead or match

| Dimension | Quasnooze evidence |
|---|---|
| Local default | `local-model` settled |
| Channels | Telegram, Discord, Slack, WhatsApp, web, Windows |
| Permission-first | risk tiers + previews + kill switch |
| Honest results | verified-execution 20/20 |
| Fast talk | `mind-01` 4.3 ms p50; `mind-08` talk-only (no tool schemas) |
| Zero runtime deps | `package.json` |

### Gaps that are *not* features here

| Tempting copy | Why it is filtered |
|---|---|
| OpenClaw skill marketplace / ClawHub | Untrusted remote code; we load owner-reviewed local tools only |
| OpenClaw Chrome CDP “full computer use” | Unbounded host control; we take accessibility-tree + approval (`lead-02`) instead |
| Open Interpreter “just run the code” | Typed tools + risk tiers beat generated scripts |
| Jan Electron + bundled GGUF runtime | New native stack; Ollama remains the brain |
| Multi-user / team admin | `multi-user` is **missing** and out of product identity |
| Cloud-first memory DB | Facts stay in `data/` JSON |

---

## 2. Second-pass: take the idea, invert the cost

For each keeper, the question is not “match X” but “make it cheaper, local, and
unable to act without the owner.”

| Keeper | Inspired by | Quasnooze version | Why it is better *here* |
|---|---|---|---|
| Talk without tools | OpenClaw always-on chat (they still send full tool lists) | `mind-08` already ships: closed questions omit schemas | Prefill − tool JSON on a 7B; false-talk is the fail |
| Smallest model that can answer | OpenClaw model-agnostic cloud | `mind-03` local router, no silent cloud | Cost cut without leaving the machine |
| Prefix / KV cache | Jan/Ollama keep_alive | `mind-04` static prefix + residency | Cache hits only if the system prompt is stable |
| Semantic end of turn | LiveKit | `duplex-01` | Same idea, on-device, no LiveKit dependency |
| First audio before last token | hosted voice agents | `duplex-02` | Must not break barge-in ≤ 150 ms |
| Compile a *conversation* into a skill | OpenAdapt + OpenClaw skills | `skill-01` + `skill-02` verify | Replay with **zero** model calls and a read-back |
| Proactive work | OpenClaw morning briefing | Existing `scheduled-agents` + `harness-09` scout | Consent, local sources, no inbox scraping by default |
| See the screenshot | Jan / OpenClaw multimodal | **`pinch-035`** Ollama vision on attachments we already accept | No new extractor; refuse if the active model is not vision |
| Prove the talk path | LiveKit test judges | **`pinch-036`** first-token bench talk vs agent | Numbers, not adjectives |
| Split the prompt for cache | Ollama prefix caching | **`pinch-037`** static vs turn-varying blocks | Unlocks `mind-04`; talk/agent share one static prefix |

---

## 3. Phased sequence

### Phase 1 — conversation speed (already in motion)

1. `mind-08-talk-only-hotpath` **shipped 2026-11-07**
2. `pinch-029-talk-classifier-eval` — 0 false-talk on neighbours
3. `pinch-036-talk-ttft-bench` — **new** — measure it
4. `pinch-030-repeat-talk-cache` (after `mind-04`)

### Phase 2 — mind (prefill and routing)

5. `mind-04-prefix-cache-residency`
6. `pinch-037-static-system-prefix` — **new** — make the prefix actually static
7. `mind-03-model-router`
8. `mind-07-first-token-deadline`
9. `pinch-028-memory-recall-budget` (agent path; talk already overlaps)

### Phase 3 — voice duplex and verified hands

10. `voice-03` barge-in → `duplex-01/02` → `lead-01` CPU duplex
11. `skill-01/02/03` compile / verify / stop on drift
12. `pinch-035-ollama-vision-route` — **new** — images we already store
13. Safety surfaces already queued: `pinch-031` kill-switch HTTP (`auto_file: false`), `pinch-034` read-only worker (`auto_file: false`)

Machine-readable issues live in `.github/roadmap.json`. Ordering is
`depends_on` only.

---

## 4. New items (this revision)

See the manifest for full bodies. Summary:

| ID | Source | Complexity | Value | Success |
|---|---|---|---|---|
| `pinch-035-ollama-vision-route` | Jan / OpenClaw multimodal | **landed** | High | Non-vision model refuses; `llava` / `qwen2-vl` pass (`src/converse/vision.js`) |
| `pinch-036-talk-ttft-bench` | LiveKit judges | **landed** | High | `node scripts/talk-ttft-bench.js` — talk prompt ~13% of agent+tools |
| `pinch-037-static-system-prefix` | Ollama prefix cache | **landed** | High | `staticPrefixHash()` identical after new memories |
