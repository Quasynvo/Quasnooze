# agent-reach: what its failure handling teaches Quasnooze

Review date: **2026-11-03**. Quasnooze baseline:
[`d68d565`](https://github.com/Quasynvo/Quasnooze/tree/d68d5652570b52a1e7d4c8e5d7c9c4f4c8f0f0f0)
(this note describes a change that has landed; it is not a proposal).

## Method and limits

Compared against [`Panniantong/agent-reach` @ `7a38047`](https://github.com/Panniantong/agent-reach/tree/7a38047acf26a729cbb27851e3cb81639da86b29)
(`release/1.6.1`), read from a local clone. Every claim below comes from that checkout's own source
(`agent_reach/runtime/result.py`, `runtime/dispatch.py`, `runtime/manage.py`) or from this
repository at the baseline commit — not from READMEs, star counts or third-party summaries.

This is a **single-project comparison, not a ranking**. agent-reach had ~108,050 stars and 9,640
forks at review time; that number is evidence that people find it useful, and evidence of nothing
else — not of reliability, security, or its applicability here.

**One correction to a common premise:** `github.com/pinchfoundry/Pinch` redirects to
`Quasynvo/Quasnooze` (GitHub repository id `1438888862`). They are one project under two names;
`bin/pinch.js` is now a compatibility alias for `bin/quasnooze.js`. There is no second "Pinch" to
compare, and an unrelated project of the same name exists on GitHub under a different owner.

**What was not done:** agent-reach was not installed, run, benchmarked or penetration-tested. Its
Python source was read; its runtime behaviour was not observed.

## Why the comparison is lopsided, and why that is fine

The two projects do not do the same job. Quasnooze is a local-first personal assistant reached
from chat channels; agent-reach gives an agent reach into social platforms behind login walls,
anti-bot checks and per-platform rate limits. Copying features across that gap would have been the
wrong instinct — most of agent-reach's surface (browser bindings, session reuse, platform
adapters) has no analogue here.

What does transfer is how it handles **failure**, and there it was ahead of us.

## The gap it exposed

Before this change, any model failure in Quasnooze produced one sentence:

```
🦞 My brain is unreachable: HTTP 429: rate limit exceeded

Check ollama / qwen2.5-coder:7b; for Ollama use `ollama serve` and pull the selected model.
```

A rate limit, a rejected key, a refused socket and a reply cut off mid-stream were
indistinguishable, and the advice was Ollama advice even when Ollama was healthy and the cloud
endpoint had rate-limited the turn. `brain.probe()` could not help: `openai.probe()` checks only
that `OPENAI_API_KEY` is non-empty, so a dead endpoint reports healthy to the panel.

agent-reach had already solved that class of problem:

| Capability | agent-reach | Quasnooze before |
|---|---|---|
| Ordered candidate backends per action | `runtime/dispatch.py` walks `action.backends` | one provider, one call |
| Stable failure codes | 9 codes in one envelope `{ok, channel, action, backend, items, meta, error}` | free-text messages |
| Codes that must not be retried elsewhere | `FINAL_CODES` | none |
| Per-code recovery hint | `DEFAULT_HINTS`, including "do not retry in a loop" | one hard-coded sentence |
| Doctor with persisted state and regression flags | `runtime/manage.py` (`needs_setup`, `needs_login`, `broken`, `regressed`) | prose only, no memory |
| Machine-readable diagnostics | JSON throughout | prose throughout |

## What was adopted

The idea worth taking is not "add a fallback". It is the pair: **a closed set of failure codes** and
**knowledge of which codes make another backend pointless**. A chain without that distinction
retries a malformed request on every provider, paying twice for the same guaranteed failure.

Landed in [#99](https://github.com/Quasynvo/Quasnooze/pull/99):

| File | Role |
|---|---|
| [`src/failure.js`](../../src/failure.js) | 9 codes, `FINAL_CODES`, one hint per code, `QuasError.toJSON()`, `classify()` for what `fetch` throws, `planFor()` |
| [`src/router.js`](../../src/router.js) | `ResilientRouter`: one pass over ordered backends, stops at the first answer, records every attempt with code and latency, stops on final codes, and refuses to retry once text has been streamed |
| [`src/brain.js`](../../src/brain.js) | model calls route through it; `brain.plan()` and `brain.lastRoute` expose what a turn would try and what it did |
| [`src/doctor.js`](../../src/doctor.js), [`scripts/doctor.js`](../../scripts/doctor.js) | `quasnooze health`: real probes with status codes and latencies, the routing plan, a `regressed` flag from the previous run, `--json` with a `schema_version`, exit 1 on failure |
| [`src/agent.js`](../../src/agent.js) | a failed turn names the code, the provider, what else was tried, and the fix |

The reference for behaviour and limits: [docs/ROUTING.md](../ROUTING.md).

### The deliberate divergence

agent-reach's backends are interchangeable because each fetches the same public data. Quasnooze's two
providers are not: one runs on the user's machine, the other is a third party. Falling back from a
local model to a cloud endpoint would send the conversation off the device to keep a turn alive.

So the chain exists but is **opt-in** (`LLM_FALLBACK=ollama|openai`, empty by default), and `mock`
is never a fallback — canned text presented as an answer would break the honesty guard.

This was not only a privacy judgement; it is existing behaviour. `test/agent.test.js` already points
both providers at one fake server and asserts that a failing call **fails** rather than quietly
switching models. A default-on chain would have broken that contract, and the tests were kept
unmodified.

### Rejected on purpose

- **Backend cooldowns** (`BACKEND_PAUSE_SECONDS`, `RATE_LIMIT_SECONDS` in its dispatch). Correct for
  a tool firing hundreds of requests per session; Quasnooze answers one turn at a time and has no
  request-rate model to cool against.
- **Session and browser-profile reuse** — no scraping surface here.
- **Silent fallback between providers** — the privacy boundary above.

## Verification

Run on this repository after the change landed, on Node 20.20.2 with no Ollama and no keys:

| Check | Result |
|---|---|
| `npm test` at the baseline before the change | 510 tests, 0 failures |
| `npm test` on merged `main` (`d68d565`) | **554 tests, 0 failures** |
| `npm run audit` (16-check adversarial self-check) | 16/16 pass |
| `node scripts/validate-roadmap.js` | OK |
| GitHub Actions on #99 | `test (22)`, `test (24)`, `test (26)`, `smoke`, `CodeQL`, Windows companion, dependency review — all success |
| `quasnooze health` on that machine | exit **1**, correctly: `runtime` fail (Node 20 < 22), `provider.ollama` fail (`UNREACHABLE`), 3 warns, 4 skips |

**Not verified:** no real rate limit, upstream schema change or Doze was exercised — those paths are
tested with fake backends that fail on purpose. `provider.openai` was tested against a local fake,
not a live cloud account. No latency or throughput claim is made from probe timings.

## What would come next

In order of value per unit of risk:

1. **Honour `Retry-After`** (already captured on `QuasError`) so a rate-limited provider is not
   asked again two seconds later.
2. **`quasnooze health --json` in the nightly audit** — the command already exits non-zero; a
   provider or key regression would then be caught before a user finds it.
3. **Regression history beyond one run** — agent-reach keeps only the previous check; a small ring
   buffer would distinguish flapping from a single failure.
4. **Tool-level routing** — the router is provider-generic and could order tools (local `grep`
   before a network search), which is where this project's surface is growing.

The lesson worth keeping from a 108k-star project is not its feature list. It is that it treats
failure as a typed, enumerable, agent-readable part of its interface — which is the part Quasnooze
was missing.
