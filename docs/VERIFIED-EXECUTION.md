# Verified execution — the read-back, and why it has three states

Most assistants report what they *tried*. A tool returns `{ ok: true }` and the
reply says "done", and the user has no way to tell a file that was written from a
file that was nearly written. OpenAdapt is the one project in this category that
took the obvious next step — read the result back from the system of record —
and it does that inside a hand-recorded program.

Here it is per action, in a conversation, with the result carried into the reply.

```bash
node --test test/verify.test.js
```

---

## 1. The three states

| State | Meaning | What the user sees |
|---|---|---|
| `verified` | an independent read of the world agrees with the claim | the action, marked verified, with its evidence |
| `contradicted` | the world disagrees with the claim | a visible warning; the model is told it may not say "done" |
| `unverified` | there is no read-back worth trusting for this action | the action, marked unverified — not "success" |

The third state is the one that matters and the one that gets skipped. A boolean
`ok` forces "it worked" and "we did not check" to look identical, which is how a
system says something false without containing a bug.

## 2. What is actually verified

| Tool | Read-back | Status when it disagrees |
|---|---|---|
| `write_file` | reads the file back and compares byte for byte | `contradicted` |
| `calculator` | recomputes the expression independently | `contradicted` |
| `add_task` | the task list must contain the exact title | `contradicted` |
| `remind` | a pending reminder with that text must exist | `contradicted` |
| `remember` | the fact must be in memory | `contradicted` |
| everything else | none defined | `unverified`, with a reason |

`write_file` has one special case worth naming: a path outside the workspace is
`contradicted`, not `unverified`, because the claim "wrote it" is false by
construction — the policy forbids the write.

## 3. The fault-injection suite

`test/verify.test.js` feeds the verifier twenty actions whose return value is a
lie. The count and the verdicts are the evidence:

| Injected fault | Verdict |
|---|---|
| write that landed | `verified` |
| write that never happened | `contradicted` |
| write whose content differs | `contradicted` |
| write that was truncated | `contradicted` |
| empty file, written as asked | `verified` |
| write outside the workspace | `contradicted` |
| sum that recomputes | `verified` |
| sum reported wrong (`2+2 = 5`) | `contradicted` |
| sum of different numbers | `verified` |
| float sum, still exact | `verified` |
| expression that cannot be recomputed | `unverified` |
| task that is in the list | `verified` |
| task that never landed | `contradicted` |
| task whose title was changed | `contradicted` |
| task already marked done | `verified` |
| reminder that is pending | `verified` |
| reminder that was never stored | `contradicted` |
| reminder whose text was altered | `contradicted` |
| fact that is remembered | `verified` |
| fact that was never saved | `contradicted` |

**20 faults, 20 correct verdicts, 0 silent wrong successes.** A verifier that
throws is `unverified`; an unknown tool is `unverified`; a failed action is not
verified at all (`ok:false` is already the honest record).

## 4. Cost

| Read-back | p50 | p95 | n |
|---|---|---|---|
| 2 KB file write, read back and compared | **0.28 ms** | **0.69 ms** | 100 |
| arithmetic recomputation | 0.00 ms | 0.02 ms | 100 |

The `skill-02` contract allowed 50 ms p95. The measurement is two orders of
magnitude inside it, which is why verification runs on every action rather than
on a sample.

## 5. Where the contradiction goes

A contradicted action is not quietly annotated. It travels two ways:

1. **Into the tool message**, with an instruction the next model turn cannot
   miss: `[verification: contradicted — … Do not describe this action as done]`.
   The model has to correct itself rather than explain a success that did not
   happen.
2. **Into the reply**, appended after the guard: *"⚠︎ One action could not be
   confirmed by an independent read-back: …"*. This half does not depend on the
   model repeating it.

Both are covered end to end: the test registers a tool that claims to have
written a file it never touches, and asserts the contradiction appears in the
message the model receives and in the text the user reads.

## 6. What this is not

- **Not a sandbox.** Verification reads afterwards; it does not prevent.
- **Not universal.** A `shell` command's exit code is the tool's own report, so
  it stays `unverified`. Saying so is more useful than a green tick that means
  nothing.
- **Not a plan-level stop — that gap is closed (F08).** As of #208 the tool
  loop *is* force-stopped on a contradiction: the remaining calls of the plan
  are abandoned, the model is not consulted again, and the user is told which
  action was contradicted and that nothing further ran. A compiled skill's
  replay does the same, and additionally re-reads the system of record before
  each step — drifted runs repair with the owner's explicit choice or stop
  cleanly (`src/skills/drift.js`), and unattended runs always stop.
- **Not proof the action was the right one.** It proves the action produced the
  state the tool said it produced. Whether that state is what the user wanted is
  the preview and approval gate's job.

## 7. From an action to a turn: receipts (issue #136)

Section 5 covers one action that lied. This section covers twelve actions where
three landed, because that is the shape a personal assistant actually fails in:
not a tool inventing success, but a *summary* of real results going further than
the results did.

`src/agent/receipts.js` builds one receipt per tool call from what the tool
returned — never from the text it printed. The batch file tools now carry a
machine-readable `receipt` (`requested`, `applied`, `failed`, `notRun`, the
failed items), so "3 of 12" is a number read off the batch. A tool with no such
record is one operation if it succeeded and zero if it did not; a refused call is
one operation that was never attempted. There is no code path that adds an
operation to a receipt.

Three things then follow, in order:

| Layer | What it does | Where |
|---|---|---|
| Correction | one model turn with the numbers, tools withheld; the rewrite is accepted only if it is better supported, never merely different | `src/agent.js` |
| Honesty flag | `receipt-count-mismatch` and `partial-failure-unreported` join the existing guard codes | `src/guard.js` |
| Visible receipt footer | per-step truth, including the failed items and whether `undo_last` applies | `renderReceipts()` |

The correction is bounded (`MAX_CLAIM_CORRECTIONS = 1`), cannot call a tool, and
is skipped on a transport failure. When the model cannot be reached, the flag and
the footer still tell the truth: the user-facing half never depends on the model
agreeing to be corrected.

```
node --test test/agent-receipts.test.js
```

What this is **not**: it is not a plan executor, and it does not stop a plan when
an action is contradicted — that belongs to the compiled-skill replay in
`skill-01`. It checks the *answer*, not the sequencing.
