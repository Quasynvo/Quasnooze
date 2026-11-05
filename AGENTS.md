# AGENTS.md — working on Quasnooze (for humans and AI agents)

Quasnooze is a local-first personal AI assistant: plain Node.js 22+, **zero
runtime dependencies**, 817 tests in 67 files, MIT. If you remember one rule:
every claim in the README is either linked to evidence or enforced by a test —
keep it that way.

## Run this first

```bash
npm test                    # node --test — 817 tests, no model, ~26 s
node scripts/audit.js       # adversarial self-check
npm run demo                # canned brain, real panel, ~2 s
node scripts/evaluate-speech.js && node scripts/evaluate-retrieval.js && node scripts/fast-path-eval.js
```

## Invariants you may not break

1. **No runtime dependencies.** Dev-only tooling is debated in an issue first.
2. **Permission gate is sacred.** Read-only runs; state-changing asks
   (`Allow once / Deny`); nothing — animation, voice, a plugin — approves.
3. **Honest numbers.** Measured baselines (`docs/*-BASELINE-V1.md`,
   `docs/RESULTS.md`) are runner output, byte-compared by tests. Regenerate
   them with their scripts; never hand-edit a metric, and never delete a
   failing corpus case to raise a score.
4. **Verified execution.** New tools either implement a read-back or report
   `unverified` with a reason. No silent "done".
5. **Docs are claims.** `test/docs.test.js` executes README/guide examples
   against the real risk classifier and CLI. Prose that drifts fails CI.
6. **Local by default.** Cloud presets, channels, and browser speech are
   each explicit opt-ins with documented boundaries (`docs/PROVIDERS.md`,
   `docs/VOICE.md`, `docs/CHANNELS.md`).

## Where things live

| Area | Place |
|---|---|
| Agent loop / brain / providers | `src/agent.js`, `src/brain.js`, `src/providers.js` |
| Tools & risk tiers | `src/tools.js`, `src/risk.js` |
| Fast path (deterministic intents) | `src/fast-path.js` + `docs/FAST-PATH-EVAL.md` |
| Retrieval | `src/documents.js` + `docs/RETRIEVAL-EVALUATION.md` |
| Channels | `src/channels/` (implement `registerSender`, don't special-case the agent) |
| Scores & reproduction | `docs/RESULTS.md` |

## Before you open a PR

- Add a focused regression test for any behaviour change; run the full suite.
- If you touched a measured path, re-run its evaluator and commit the
  regenerated baseline in the same PR.
- Keep PRs small; say what you measured, not what you hope.
