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
- **Not a plan-level stop.** The tool loop is not force-stopped on a
  contradiction: the model is told and the user is warned, but a compiled skill
  with a plan to abandon needs `skill-01`'s replay to abandon it. That gap is
  recorded in the roadmap item rather than papered over.
- **Not proof the action was the right one.** It proves the action produced the
  state the tool said it produced. Whether that state is what the user wanted is
  the preview and approval gate's job.
