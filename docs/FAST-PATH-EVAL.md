# Fast path — the measurement behind `mind-01`

`mind-01-intent-fast-path` said: matched intents answer in under 400 ms at p50,
routing accuracy is at least 95% on a labelled set, and ambiguity falls through
100% of the time. This is the run that decided whether it shipped.

Reproduce it:

```bash
node scripts/fast-path-eval.js          # table
node scripts/fast-path-eval.js --json   # machine-readable
```

The corpus is [`test-fixtures/fast-path-corpus.json`](../test-fixtures/fast-path-corpus.json).

---

## 1. What it replaces

Every turn used to start with a prefill. On fixed local hardware that is the
dominant cost of a short request — the model has to read the system prompt, the
last ~24 messages and the tool schemas before it can emit the word "yes". The
project's own budget in [VOICE-CONTROL-ROADMAP.md](VOICE-CONTROL-ROADMAP.md) puts
time-to-first-token at ≤ 700 ms p50 for a local 7B; a hosted model is not faster
in wall clock once the network is honest.

A deterministic turn does not read anything. It matches one of a closed set of
sentence shapes, calls the same tool the model would have called, and returns the
tool's own output.

---

## 2. Measured on this machine (2026-11-05)

| Measurement | Value | Notes |
|---|---|---|
| Matcher decision (in-process) | **p50 5 µs**, p95 10 µs | 59 utterances × 200 repeats, `test/fast-path.test.js` |
| Whole fast turn, end to end | **p50 4.3 ms, p95 7.9 ms** (n = 50) | includes the tool run, the honesty guard, the session write and telemetry |
| Model turn it replaces | ≥ 700 ms p50 budget | `voice-01`'s time-to-first-token ceiling, not a measurement of this machine |

The interesting number is the second row: the matcher is 0.1% of the turn. What
remains is the work every turn does anyway — persist the message, audit the
reply, record the telemetry. That is the point: skipping the model should not
require skipping the safety.

These are single-machine numbers from the test harness with no model installed.
They bound the fast path, not the model path; the README may quote them only
alongside the sentence above.

---

## 3. Routing, on 59 labelled utterances

| | count | result |
|---|---|---|
| deterministic phrasings | 31 | **31 matched** (100%) |
| neighbouring phrasings that must not match | 28 | **0 wrong routes** |

By intent: `time_now` 8/8, `calculator` 7/7, `remember` 5/5, `add_task` 5/5,
`remind` 6/6.

The 28 negatives are the interesting half. They are the sentences that *look*
like a match and would be wrong to act on:

- **A request that is really a different kind of thing.** "remember to buy milk" is
  a to-do or a reminder; filing it as a durable fact is a guess about the user.
- **An incomplete request.** "add a task" and "remind me to call mom" have no
  title and no time. The model can ask; a regex cannot.
- **A compound request.** "add a task to buy milk and then remind me at 5pm" is a
  plan in one sentence, and half-executing it is the worst available outcome.
- **A neighbouring capability.** "what time is it in Tokyo", "convert 5 km to
  miles", "calculate the odds of rain" — arithmetic-shaped, not arithmetic.
- **A reference to something else.** "make a note of this" points at the previous
  turn.

---

## 4. Safety rules the corpus cannot encode

The corpus is evidence about routing; these are the rules that make a wrong
route survivable, and they are enforced in code and tests rather than measured:

1. **A closed allowlist.** `FAST_TOOLS` has five entries. A fast turn cannot reach
   a tool that writes files, runs a shell or touches the OS, and it cannot reach
   anything marked dangerous, so the approval gate is never bypassed.
2. **A failed fast call is not an answer.** If the tool returns `ok:false` — an
   unparseable time, a missing argument — the turn falls through to the model
   unchanged, because "I could not understand" written by a regex is worse than a
   question asked by a model.
3. **Unattended runs never take it.** A scheduled run has nobody to correct a
   wrong guess.
4. **Attachments disable it.** A message carrying a document is a request about
   the document.
5. **The reply is the tool's output.** Nothing is paraphrased, so nothing can be
   invented. The one exception is the clock, whose raw output carries an ISO line
   that is diagnostics rather than an answer.
6. **It is switchable.** `QUASNOOZE_FAST_PATH=off` restores the previous
   behaviour exactly, and a test asserts the model path is otherwise untouched.

---

## 5. Bugs this exercise found

- `parseClock("13pm")` and `parseClock("99pm")` used to succeed, because
  `setHours()` rolls 99 into four days later. A request for "99pm" quietly became
  a reminder at 03:00 on an unrelated day. Both are now refused, with
  `test/timeparse.test.js` pinning the boundary cases (`12am`, `12pm`, `1pm`).

That one was worth the corpus on its own. The failure mode — a reminder the user
never asked for, at a time they never said — is exactly the class of error a
deterministic path is supposed to eliminate, and it was sitting in the tool the
fast path calls.

---

## 6. What would make this report wrong

- **The corpus is mine.** 59 utterances I wrote, labelled by me, evaluating a
  matcher I read while writing them. It proves the rules fire as specified; it
  does not estimate how often a stranger phrases "what time is it" differently.
  The next step is real transcripts, collected after the local STT path (`ear-01`)
  starts producing them, and re-labelled by someone who did not write the matcher.
- **Coverage is not usefulness.** 100% of a set chosen because it matches is
  circular. The useful number is how many real turns this captures; `voice-01`'s
  telemetry will answer it with `mode: "fast"` counts once there are real users.
- **Latency is not the same as felt latency.** A 4 ms answer still waits for the
  microphone to stop listening and for the browser to paint. The end-to-end voice
  budget is `voice-01`'s, not this document's.
