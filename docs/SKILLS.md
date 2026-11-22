# Skills — a conversation compiled into a verified program

> A skill is the executable memory of one successful turn: the tool calls that
> actually ran, with their exact arguments, their permission tier, and their
> independent read-backs — compiled into data and replayed with **zero model
> calls**. Replay p50 in the contract suite: **under 300 ms** (n=50, fake
> execution; measured 4 ms end-to-end through the real tool registry for a
> two-step skill on the CLI).

This is the `skill-01` moat (issue [#207](https://github.com/Quasynvo/Quasnooze/issues/207), roadmap F07): nobody else compiles a *conversation* into a
verified, replayable, permission-scoped program on a machine that both listens
and acts. Neighbours do pieces of it — OpenAdapt records verified programs but
by hand, outside a conversation; OpenClaw "skills" are prose a model re-reads
every run; voice stacks converse with no memory of how work was done.

## The rules, in order of how much they matter

1. **A skill is data, not authority.** The manifest schema is closed — `kind`,
   `schema_version`, `name`, `description`, `compiled_from`, `steps`, and
   nothing else. A `grants`, `permissions`, `allow` or `approved` field is
   refused *by name* at parse time. A file that can grant itself power is a
   file an attacker can write.
2. **The owner approves content, not filenames.** Approval is recorded against
   the manifest's sha256. Edit the skill after approval and the approval goes
   stale: the loader says so and replay refuses until the owner reviews again.
3. **Replay re-checks everything that moves.** Every step is re-classified
   against *current* policy (`src/risk.js`) — the recorded tier is not
   trusted. A tool that no longer exists, or a command the screen now refuses,
   stops the replay cleanly. Dangerous steps re-enter the approval gate
   (`shell`, `write_file`, …); `type_text` needs fresh consent that no blanket
   approval can wave through.
4. **Arguments are byte-identical.** The executor receives an exact JSON copy
   of the recorded arguments — nothing is re-invented, nothing is paraphrased.
5. **Every applied step is verified** by the shipped skill-02 read-back
   (`src/verify.js`): `verified`, `contradicted`, or `unverified` — said out
   loud, never collapsed into "done". A contradiction stops the replay and is
   reported as a contradiction.
6. **Stopping is the repair strategy.** Policy moved, a step failed, a
   read-back disagreed: the replay halts with the steps it actually ran and
   the exact reason. Nothing is skipped, nothing is guessed (F08 "stop, don't
   guess" is this behaviour, measured).
7. **Drift is repaired by the owner or not at all** (`src/skills/drift.js`).
   Before each step the replay re-reads the system of record — the file is
   still a regular file, the task is still open, the reminder is not already
   set. On drift: the owner picks from candidates or supplies a value that
   must point at something real, or the run stops cleanly. A swapped-in
   symlink is never repairable; unattended runs stop on drift without asking.
   Every drift lands in the run ledger (`src/agent/ledger.js`) with its
   before/after state.
8. **Simple chat never loads skills.** `src/agent.js`, `src/brain.js`,
   `src/fast-path.js` and `src/tools.js` cannot reach into `src/skills/` —
   proven by a static test, not by good intentions.

## Using it

```bash
# 1. Record a turn as a JSON file: the user's request and the tool outcomes.
#    (Coming from a live session: the turn's receipt ledger is this shape.)
cat > turn.json <<'EOF'
{
  "utterance": "write the status note and read it back",
  "calls": [
    {"tool": "write_file", "args": {"path": "status.txt", "content": "all green\n"},
     "result": {"ok": true}, "verification": {"status": "verified"}},
    {"tool": "read_file", "args": {"path": "status.txt"},
     "result": {"ok": true}, "verification": {"status": "verified"}}
  ]
}
EOF

# 2. Compile it. Only successful turns compile: every call applied, nothing
#    denied, nothing contradicted. Blocked commands are refused at compile time.
quasnooze skills compile status-note --from turn.json

# 3. Review, then approve the content (digest-bound).
quasnooze skills show status-note
quasnooze skills approve status-note

# 4. Replay. Zero model calls. --yes approves dangerous steps for this run
#    and counts as fresh consent for typed input — because you typed it.
quasnooze skills replay status-note --yes
```

`list`, `revoke` (keeps the file) and `delete` round out the registry. State
lives in `<data>/skills/` under `PINCH_DATA`, mode 0600, like every other
piece of local state.

## What is measured, and what is not

Measured in `test/skill-compiler.test.js` (25 tests): compile refusals
(single call, failed/denied/contradicted steps, invented tools, blocked
commands, missing arguments), schema refusals of authority fields, prototype
hygiene, approval staleness and re-approval, policy re-check at replay
(including "a plan is not authority": today's screen beats yesterday's
recording), fresh-consent integrity, contradiction/failed-step stop
behaviour, honest `unverified` records, byte-identical arguments, zero-model
imports (static), chat/skill separation (static), and replay p50 < 300 ms
over n=50.

**Not measured, not claimed:** real-user phrasing, parameterised skills
(replay is byte-identical by design — a `{{date}}` slot is future work),
skill sharing or any marketplace (refused by policy, not by omission),
behaviour of local plugins or MCP tools inside skills (the CLI replays the
built-in registry only), and physical-microphone "tidy my downloads" turns —
the compile-from-conversation path runs through the same turn record, but the
hands-free loop is voice-engine work tracked in F03.

## Files

| File | What it is |
|---|---|
| `src/skills/manifest.js` | the closed schema, canonical JSON, content digest |
| `src/skills/compiler.js` | successful turn → frozen manifest, with refusals |
| `src/skills/registry.js` | storage + digest-bound owner approval |
| `src/skills/replay.js` | zero-model replay: policy re-check, gate, verify, stop |
| `test/skill-compiler.test.js` | the contract suite (25 tests) |
| `src/cli.js` (`skills …`) | the owner-facing surface |
