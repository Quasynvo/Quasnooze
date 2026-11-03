# Diagnostics: readiness states and the latency baseline

Two questions a first-run user actually has — *"can this machine do a local turn right
now?"* and *"how slow is it, measured how?"* — now have structured answers. Both are
built on the diagnostics that already existed (`src/doctor.js` probes, `src/telemetry.js`
timing conventions); nothing here is a second, competing diagnostics system.

```bash
npm run health                                    # checks + readiness, human-readable
npm run health -- --json                          # one object: checks, readiness, model_info
npm run health -- --no-network                    # configuration only → not-verified
npm run health -- --baseline                      # + synthetic content-free latency baseline
npm run health -- --baseline --samples 5 --warmup 1 --out baseline.json
```

Exit code stays the doctor's: **1 when any check fails** (and when a baseline phase
records errors), so both forms can gate CI.

## Readiness

`runDoctor()` reports now carry a `readiness` object derived from the same checks by
`src/readiness.js` — derivation only, no new probes. There are two surfaces:
`surfaces.text` (can a local turn complete?) and `surfaces.voice` (can a spoken turn
complete?). The top-level `state` is the text surface's; voice is reported alongside it,
never averaged into it.

| State | Meaning | Typical next action |
|---|---|---|
| `ready` | The selected provider answered a real probe and the selected model is installed | Run a first turn |
| `ready-mock` | The mock brain is selected — plumbing only, **not** a verified local turn | Configure Ollama and re-run |
| `missing-model` | Backend answered, but the selected model is not installed | `ollama pull <model>` — diagnostics never downloads it for you |
| `unreachable-backend` | The selected provider did not answer (or is unconfigured) | `ollama serve`, or fix the endpoint/key in `.env` |
| `companion-unavailable` | *(voice)* No Windows resident companion in the observed process | `npm run desktop` on Windows 10/11 |
| `mic-muted` | *(voice)* Companion is running; the microphone is muted | Explicitly choose Talk locally / enable Hey Quasnooze — diagnostics never unmutes it |
| `not-verified` | Nothing was actually probed (`--no-network`, or no in-process companion observable) | Re-run with probes, or read `GET /api/desktop` inside the desktop process |
| `blocked` | The provider answered, but a runtime/data check failed | The failing check's hint (e.g. upgrade Node) |

Every surface always carries a non-empty `next_action` — including `ready`.

Two rules keep this honest:

- **A configured model name is not evidence.** With `--no-network` the state is
  `not-verified`, never `ready`.
- **A mock is not a measurement.** `ready-mock` is a distinct state and `ready: false`.

Companion state is only observable inside the desktop process, so the standalone CLI
reports voice as `not-verified` with that explanation. An in-process caller passes its
snapshot explicitly: `runDoctor({ companion: desktop.snapshot() })`. Readiness reads
only `available`, `mic` and a whitelisted `phase` from that snapshot — speech text and
recent commands in the snapshot are never copied into diagnostics output (there is a
canary test for exactly this).

## The latency baseline

`--baseline` times **fixed synthetic scenarios** and produces a versioned artifact
(`kind: "quasnooze-latency-baseline"`, `schema_version: 1`) designed to be diffed
against a later run on purpose, not read once and believed.

| Phase | What is timed | What it isolates |
|---|---|---|
| `deterministic_handler` | Risk classification of a fixed read-only command (`classifyCommand`). Nothing is executed | Orchestration floor — no model involved |
| `first_text` | Fixed synthetic prompt → first streamed delta | Inference start (incl. cold load) |
| `full_answer` | Fixed synthetic prompt → complete reply | Total synthetic turn time |
| `audio` | A caller-supplied probe, only with explicit consent | Speech path — **not measured by the CLI**, which opens no microphone |

Each measured phase records: individual `samples_ms`, `n`, `errors`, `error_codes`
(stable codes from `src/failure.js`, never error text), nearest-rank `p50_ms`/`p95_ms`,
`min_ms`/`max_ms`, `cold_ms` (first successful sample) and a `warm` summary of the rest.
`--warmup N` runs unrecorded warm-ups first and labels the run warm instead.

The artifact also records the comparison context, picked field-by-field:

- OS platform/release/arch, CPU model + core count, total memory, Node version,
  process peak RSS (`peak_rss_mb`, this process only);
- provider and model, plus — for Ollama, when `/api/tags` reports them — model
  **digest**, quantization, parameter size and family (also on the doctor report as
  `model_info`). Two runs on one model *name* with different digests are different runs;
- settings this run actually used (`num_ctx`, `num_predict`, synthetic max tokens).
  Anything not set or not measurable dependency-free (temperature, GPU, driver) is an
  explicit `null` — never an invented value;
- `evidence_kind`: `local-model`, `cloud-model` or `mock`, and `providers_observed`
  (which provider actually answered — visible if an opt-in fallback engaged).

Model phases run **only when readiness verified the configured provider**
(`ready`/`ready-mock`). Otherwise they are recorded as not measured with the readiness
state as the reason code. The baseline downloads nothing, starts no backend, tries no
other provider on its own, and weakens no approval: it makes the same `brain.chat` call
a turn would make, with a fixed harmless prompt.

### Content-free is enforced, not promised

- The synthetic prompt is a code constant; it is sent, never written to the artifact.
- Model output is timed via deltas and discarded — no text, no preview.
- Failures are stable codes; provider error messages (which can echo keys/URLs) are dropped.
- The environment is assembled field-by-field; the config object (which holds every
  channel token) is never spread or serialized.
- Before returning, `assertContentFree()` scans the serialized artifact for the
  configured secret values and rejects content-shaped keys (`prompt`, `response`,
  `clipboard`, `token`, …) at any depth. On violation it throws and nothing is emitted.
- `--out FILE` writes with mode `0600`.

Tests: `test/readiness.test.js` (every state, next actions, companion canary, doctor
integration) and `test/baseline.test.js` (deterministic percentiles with a manual clock,
cold/warm, consent gates, secret canaries in replies, errors and config).

## The consented Windows first successful local turn

A first successful **real** local turn on Windows hardware is a manual acceptance check.
It is documented separately from everything above because none of the automated results
— mock baselines included — are evidence for it.

> **Status for the change that introduced this document: NOT RUN.**
> It was developed and tested on Linux (Node 22) with injected provider/companion
> fixtures. No Windows machine, physical microphone or local model was used, and no
> hardware numbers are claimed anywhere in it. The procedure below is the record a
> consenting hardware tester fills in; until then it stays blank.

### Procedure (tester, on their own Windows 10/11 machine)

1. Consent first: the tester agrees to run the desktop host and to unmute the
   microphone manually for step 6 only. Nothing in the tooling unmutes it.
2. `git clone … && npm run setup && npm run doctor` — configure Ollama and an installed
   model. Pull a model only as an explicit tester action (`ollama pull …`).
3. `npm run health -- --json` — require `readiness.surfaces.text.state == "ready"`
   (not `ready-mock`), and note `model_info.digest`.
4. `npm run health -- --baseline --out baseline-<date>.json` — require
   `evidence_kind == "local-model"` and zero phase errors.
5. `npm run desktop` — in that process, `GET /api/desktop` shows the companion;
   readiness voice should read `mic-muted` (the designed start state).
6. Tester explicitly unmutes (Talk locally), says one short command, confirms a local
   reply, then mutes again. Record success/failure and the companion phases observed —
   **not** the spoken or replied text.
7. Fill in the record below and attach the baseline artifact. Timings come only from
   the artifact; nothing is estimated by hand.

### Record (copy, fill in, attach the artifact)

```text
Date / tester (handle):
Commit under test:
Windows version / CPU / RAM / GPU (as reported by the tester):
Node version (`node --version`):
Ollama version / model name / model_info.digest from health JSON:
Speech pack present (docs/DESKTOP.md prerequisites): yes / no
Readiness before desktop  — text: ______   voice: ______
Readiness in desktop      — voice before unmute: ______  after: ______
Baseline artifact filename + evidence_kind (must be local-model):
  deterministic_handler p50/p95: ______ / ______
  first_text cold / warm p50:    ______ / ______
  full_answer p50/p95:           ______ / ______
  phase errors (codes only):     ______
First spoken turn completed locally: yes / no
Mic returned to muted afterwards:    yes / no
Anything surprising (no transcript, no prompt/response text):
```

If any field cannot be filled from an actual observation, it stays blank and the run
does not count as the accepted first turn.

## Limits

- Percentiles over a handful of synthetic samples describe **this machine, this model
  digest, this run** — they are a regression baseline, not a performance claim and not
  a hardware tier.
- `audio` has no CLI measurement path by design. A future Windows harness that owns
  microphone consent can pass `runBaseline({ consentAudio: true, audioProbe })`.
- Readiness proves a probe answered at check time. It cannot prove the next real turn
  will succeed; typed turn failures (`docs/ROUTING.md`) remain the source of truth then.
