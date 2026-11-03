# Routing, failure codes, and the doctor

What happens when the model does not answer, and how to find out why.

Reviewed against [agent-reach `7a38047`](https://github.com/Panniantong/agent-reach/tree/7a38047acf26a729cbb27851e3cb81639da86b29) and this checkout at `196df43`.

---

## The problem this replaces

Every provider failure used to reach the user as the same sentence:

```
∿ Model unavailable: HTTP 429: rate limit exceeded

Check ollama / qwen2.5-coder:7b; for Ollama use `ollama serve` and pull the selected model.
```

A rate limit, a rejected key, a refused socket and a reply cut off mid-stream were indistinguishable. The advice was Ollama advice even when Ollama was serving fine and the cloud endpoint had rate-limited the turn. `brain.probe()` could not help either: openai's probe only checks that `OPENAI_API_KEY` is set, so a dead cloud endpoint reads as healthy.

## What a turn does now

```
messages ──▶ ResilientRouter ──▶ [ primary ]  ──── ok ──▶ answer
                                     │
                                     └─ failed, retryable?
                                          │
                                          ├─▶ [ fallback ]  (only if LLM_FALLBACK is set)
                                          │        │
                                          │        └─ ok ──▶ answer, marked degraded
                                          │
                                          └─▶ QuasError: code + provider + hint + attempts
```

One pass, in order, no retries, no loops. Every attempt is recorded — backend, outcome, code, latency, and whether text had already been streamed — so the error a person sees can say what was tried and what each one said.

### The fallback is opt-in, on purpose

Quasnooze is local-first. Falling back from a local Ollama model to a cloud endpoint would send the conversation off the machine to keep a turn alive. That is a decision for the person using it, not a sensible default, so it is empty unless you ask:

```bash
LLM_FALLBACK=openai     # local model first, cloud if the local one fails
LLM_FALLBACK=ollama     # cloud first, local if the cloud fails
LLM_FALLBACK=           # the default: one provider, and a clear failure if it breaks
```

Two things are never fallbacks:

- **`mock`.** Canned text presented as an answer would break the honesty rule the guard exists to enforce.
- **A provider that cannot work.** `LLM_FALLBACK=openai` with no `OPENAI_API_KEY` adds no second hop rather than a fake one; a fallback to the primary is not a fallback.

This also preserves behaviour the existing tests pin deliberately: a failing model call fails, rather than quietly answering from a different model than the one selected.

### Which failures fall through, and which stop

| Code | Comes from | Falls through? | Why |
|---|---|---|---|
| `RATE_LIMITED` | 429, or a body saying `rate_limit_error` | yes | another provider is not rate limited |
| `NEED_AUTH` | 401/403, missing key | yes | a rejected cloud key should not silence a working local model |
| `UNREACHABLE` | refused socket, DNS miss | yes | the fallback is precisely for this |
| `TIMEOUT` | accepted, then silent | yes | |
| `UPSTREAM_BROKEN` | 5xx, non-JSON, truncated reply | yes | provider-side, not request-side |
| `PAYLOAD_MISMATCH` | parsed, wrong shape | **no** | the same turn fails identically everywhere |
| `BAD_INPUT` | invalid request | **no** | ditto, and a metered API bills twice |
| `CONTEXT_LIMIT` | conversation too long | **no** | ditto |
| `STREAM_CUT` | failed after text was shown | **no** | see below |

The "stops" set is the idea borrowed from agent-reach's `FINAL_CODES` (`agent_reach/runtime/result.py`): *codes where trying another backend cannot help*. Retrying a malformed request on the next provider doubles the latency and, on a metered endpoint, the bill, for an answer that cannot arrive.

### Streaming pins the chain to one backend

Once a delta has been handed to the caller, the reply is already on someone's screen. A second attempt would print a different beginning after the first one, so the failure is reported as `STREAM_CUT` and the chain stops there. Streaming and fallback are fundamentally at odds; this is the only honest resolution, and it is covered by a test that asserts the fallback backend is *never* called.

## The doctor

Two commands, for two audiences:

```bash
pinch doctor        # prose, for setting things up (scripts/setup.js --check, unchanged)
pinch health        # provider matrix, routing plan, verdict — exits 1 if anything fails
npm run health -- --json          # the same as one object, for scripts and agents
npm run health -- --no-network    # configuration only; no request leaves the machine
```

| Check | What it observes |
|---|---|
| `runtime` | Node version against the `engines` floor |
| `security` | empty `PINCH_KEY`, `PINCH_AUTO_APPROVE=true` |
| `data` | data directory writable, and not group/world-readable |
| `brain` | the selected provider and model |
| `provider.ollama` | **real request** to `/api/tags`: status, latency, model count, whether the selected model is installed |
| `provider.openai` | **real request** to `/models`: status, latency. A 404/405 is "reachable, this endpoint has no model list", not a failure |
| `routing` | the exact plan a turn would use, and whether losing the provider leaves anywhere to go |
| `voice` | `WHISPER_URL` answers, when one is configured |
| `channels` | which messaging channels are configured (presence only) |
| `regressions` | checks that passed on the previous run and fail on this one |

The `routing` check is the one that answers the question people actually have — *would this survive its provider disappearing?* — and it says so in plain words:

```
▲ routing           single provider (ollama) — a 429, 5xx or refused connection has nowhere to go
    Set LLM_FALLBACK=openai to survive an Ollama outage. That sends the turn's history to the
    cloud endpoint, so it stays off by default.
```

The JSON form is stable enough to branch on, which is agent-reach's other good idea (a single envelope, `ok` plus stable keys, never parse the prose):

```json
{
  "schema_version": 1,
  "ok": false,
  "summary": { "ok": 1, "warn": 3, "fail": 2, "skip": 3 },
  "routing": { "plan": [{ "provider": "ollama", "model": "qwen2.5-coder:7b", "role": "primary" }], "resilient": false, "provider": "ollama" },
  "checks": [{ "id": "provider.ollama", "status": "fail", "detail": "no answer from http://127.0.0.1:11434 (UNREACHABLE)", "hint": "Start it with `ollama serve`, …" }]
}
```

`regressed: true` marks a check that passed last time and fails now — a broken thing is called out once, on the run where it breaks, instead of blending into a wall of red.

## What was taken from agent-reach, and what was not

| Pattern | agent-reach | Here | Taken? |
|---|---|---|---|
| Ordered backends per action | `runtime/dispatch.py` walks `action.backends` | `ResilientRouter` over providers | **yes**, same shape |
| Failure codes agents branch on | 9 codes, `ok`/`error.code` envelope | 9 codes, `QuasError.toJSON()` | **yes** |
| Codes that end the chain | `FINAL_CODES` | `FINAL_CODES` | **yes**, the key idea |
| Per-code recovery hints | `DEFAULT_HINTS` | `HINTS` | **yes** |
| Doctor with state and regression flags | `runtime/manage.py` | `src/doctor.js` + `data/doctor-state.json` | **yes** |
| Backend cooldowns (`BACKEND_PAUSE_SECONDS`, `RATE_LIMIT_SECONDS`) | per-backend pause after a failure | not implemented | **no** — a single user answering one turn benefits little from cooling a provider down; it needs a request-rate model this app does not have yet |
| Shared browser/profile sessions | `browser_binding`, `session_reuse` | not applicable | **no** — Quasnooze has no scraping surface |
| Silent fallback between interchangeable backends | correct there: every backend fetches the same public data | **rejected here** — providers differ in *where the conversation goes* | **no**, and deliberately |
| Chinese-language onboarding docs | its primary audience | Quasnooze is English-first | **no** |

The important difference is the last two rows. agent-reach's backends are interchangeable in privacy terms — all of them fetch a public page. Quasnooze's two providers are not: one is a model on your own machine, the other is a third party. Copying "try the next backend" wholesale would have been the wrong lesson to learn from it, which is why the chain exists but is off by default.

## Evidence

Run on this machine (Node 20.20.2, no Ollama running, no channels configured):

| Command | Result |
|---|---|
| `npm test` before any change | 510 tests, 0 failures |
| `npm test` after | **544 tests, 0 failures** (510 pre-existing + 34 new) |
| `npm run verify` (tests + adversarial self-check) | **544 pass**, audit **16/16 pass** |
| `npm run health` | exit **1**: `runtime` fail (Node 20 < 22), `provider.ollama` fail (refused), 3 warns, 3 skips |
| `npm run health -- --json` | one object, `schema_version: 1`, `state_written: true` |
| second run | no regression lines — nothing newly broke, correctly |

New tests: `test/router.test.js` (17) — first-answer-wins, fall-through, primary-reason-on-total-failure, final-code-stops-the-chain, no-retry-after-streaming, fall-through-before-streaming, timings, plan order, status→code mapping, fetch-error classification, hint completeness, `toJSON`, and the three fallback-policy cases; `test/doctor.test.js` (17) — healthy install, unreachable provider, missing model, auth-rejected cloud, single-provider warning, opted-in resilience, regression detection, already-failing is not a regression, JSON shape, `--no-network` making zero requests, human rendering, security posture, world-readable data dir, old Node.

## Limits

- **No hardware claims.** Nothing here was tested against a real rate limit, a real upstream schema change, or a phone in Doze. The fallback paths are exercised with fake backends that fail on purpose, which is the only way to test them deterministically.
- **`provider.openai` was exercised only against a local fake.** The 401 and 404 branches are covered by tests, not by a live cloud account.
- **The doctor's exit code is 1 on any failure** including an unsupported Node; a CI job running `npm run health` on Node 20 will fail on the runtime check by design.
- **No cooldown / request-rate model yet.** A rate-limited provider is tried again on the next turn; there is no backoff state. That is the next obvious step if turns start arriving faster than the provider's limit.
