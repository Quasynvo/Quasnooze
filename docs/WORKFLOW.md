# The design workflow — plan, approve, then act

*Opt-in. Off by default (`QUASNOOZE_WORKFLOW=off`). Nothing here changes what a
turn does unless you turn it on.*

A question is answered inside one turn. A piece of **work** — "tidy my downloads",
"make the failing tests pass", "reorganise this folder" — is ten tool calls, and
the eight-round loop has no place in it to show you the plan before it happens.
The workflow adds exactly that place:

```
inspect → design → awaiting-design-approval → planned → executing → verifying → done
                 ↘──────────────────────────────────────────────────────↘ blocked
```

## The three commands

| Command | What it does | What it never does |
|---|---|---|
| `/plan <goal>` | Asks the model for a bounded plan and shows it to you as a numbered document. Nothing runs. | It cannot call a tool, and the goal is capped at 400 characters. |
| `/approve` | Approves **this session's** design and starts it. | It grants no tool permission. Every tool inside still meets the risk tier and the approval gate it met before. |
| `/cancel` | Stops it. The workflow becomes `blocked` and cannot be resumed. | It does not undo completed steps; use the undo journal for file actions. |

`/plan` with no argument prints the help, and `/plan` while a design is open
repeats it rather than starting a second one.

## What a plan is, exactly

The plan is **data**, stored in `data/workflows.json`, not a model whisper in the
conversation. It has four fields and every one of them is bounded:

| Field | Bound | Why |
|---|---|---|
| `goal` | 400 characters | A goal you cannot read in one line is not reviewable. |
| `scope` | 12 entries, 120 chars each | Says where the work is allowed to happen. |
| `steps` | 8 steps, 240 chars each | Eight is the number of rounds one turn already gets. |
| `successChecks` | at least 1, at most 6, 200 chars each | A plan with no check has no definition of done. |

Anything outside those bounds is **refused**, not truncated: a silently shortened
plan is a plan you approved without seeing the part that was dropped. The refusal
names the limit and the workflow becomes `blocked`.

Exactly **one** clarification is allowed. If the request genuinely cannot be
planned, the model asks one short question and you answer it with
`/plan <answer>`; a second question fails closed.

## Why approving a design is not approving an action

Two separate gates, and they are separate on purpose:

- **Design approval** says: *this is the work I want.* It is single-use, bound to
  the session that requested it, carries a hash of the exact plan it approved,
  and expires after 10 minutes. A plan swapped after approval cannot ride on it.
- **Tool approval** says: *this specific action, right now, with these arguments.*
  It is untouched by this feature, and `src/risk.js` still decides which actions
  need it.

So `/approve` on a plan whose third step runs a shell command still raises an
approval prompt for that command. Deny it and the plan stops, is recorded as
`blocked`, and says which step was refused.

## Restart and cancellation never resume

A running workflow holds a lease stamped with the process that owns it. If the
process dies, or the lease expires, the next read marks the workflow `blocked`:

> interrupted: the run stopped before this step finished (restart, crash or an
> expired lease). Nothing was resumed.

Nothing auto-continues, because guessing where we were is how an assistant repeats
a step that already happened. Start again with `/plan` and approve a fresh design.

## What is deliberately not here

- **No autonomous background execution.** A scheduled run cannot start a
  workflow at all: approving a design needs a person who is present.
- **No self-approval.** The model cannot approve its own plan, and a plan cannot
  approve a tool.
- **No hidden chain-of-thought.** Only the four plan fields are stored; the model's
  reasoning is not, so nothing invisible can be treated as an instruction later.

## Proof, not promise

`test/agent-workflow.test.js` runs the whole thing against a loopback fake model
and asserts, among others: a design waits for approval and runs nothing; approval
from another session is refused; an approved plan still raises the tool approval
and a denial stops it; malformed and oversized designs fail closed with the limit
named; a greeting never reaches the design prompt; a cancel cannot be revived by a
later `/approve`; and a stale lease after a restart blocks rather than resumes.

```bash
node --test test/agent-workflow.test.js test/agent.test.js
```
