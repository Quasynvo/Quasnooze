/**
 * skill-drift.test.js — the F08 fault suite (issue #208).
 *
 * The contract under test: when the world moved under a compiled skill, the
 * replay recovers with the owner's explicit choice or stops cleanly — and a
 * misapplied run (a step landing on a substitute the owner never picked, or
 * reported done that was not run) is impossible. The acceptance bar is
 * ≥ 90% of drifted runs recovered-or-stopped and **zero** misapplied runs.
 *
 * The system of record is real here: files in a sandbox workspace, tasks,
 * reminders, and memory through src/store.js. Only the tool executor is
 * faked, so drift is injected by moving the world, not by mocking the check.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-drift-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-drift-data-"));
process.env.PINCH_AUTO_APPROVE = "false";
process.env.LLM_PROVIDER = "ollama";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // nothing listens; nothing may call it

const { replaySkill } = await import("../src/skills/replay.js");
const { checkPreconditions, validateRepair, DRIFT_ALREADY_APPLIED, DRIFT_TARGET_MISSING, DRIFT_TARGET_TYPE } = await import("../src/skills/drift.js");
const { ledgerEvents } = await import("../src/agent/ledger.js");
const { loadTasks, saveTask, addReminder, pendingReminders, remember, loadMemory } = await import("../src/store.js");
const { validateSkill, SKILL_KIND, SKILL_SCHEMA_VERSION } = await import("../src/skills/manifest.js");

const WS = process.env.PINCH_WORKSPACE;

/* ───────────────────────────── helpers ───────────────────────────────── */

function loaded(name, steps) {
  const manifest = {
    kind: SKILL_KIND,
    schema_version: SKILL_SCHEMA_VERSION,
    name,
    description: "drift fault suite",
    compiled_from: { utterance: "written by the test" },
    steps,
  };
  validateSkill(manifest); // the suite runs only manifests the registry would accept
  return {
    manifest,
    digest: `test-${name}`,
    approval: { approved: true, stale: false, approved_at: new Date().toISOString() },
  };
}

function recorder() {
  const calls = [];
  return {
    calls,
    execute: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, output: "done" };
    },
  };
}

const verified = async () => ({ status: "verified", detail: "read back matches" });
const stopAnswer = async () => ({ action: "stop" });

/** Every drifted run is classified exactly one way. */
const outcomes = [];
function record(name, outcome) {
  outcomes.push({ name, outcome });
}

/* ─────────────────────── the control: no drift ───────────────────────── */

test("control: a world that still matches replays byte-identically", async () => {
  writeFileSync(join(WS, "draft.txt"), "hello\n");
  const steps = [
    { tool: "write_file", args: { path: "draft.txt", content: "hello\n" } },
    { tool: "read_file", args: { path: "draft.txt" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("control-run", steps), { execute, verify: verified, approve: () => true });
  assert.equal(report.status, "completed");
  assert.equal(report.drift.length, 0);
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify(steps[0].args));
  assert.equal(JSON.stringify(calls[1].args), JSON.stringify(steps[1].args));
});

/* ─────────────── target-missing: re-resolve with the owner ───────────── */

test("a renamed file is re-resolved from candidates — with the owner, not by guessing", async () => {
  writeFileSync(join(WS, "notes-2026.md"), "kept\n");
  const steps = [
    { tool: "read_file", args: { path: "notes.md" } },
    { tool: "read_file", args: { path: "notes-2026.md" } },
  ];
  const { execute, calls } = recorder();
  const asked = [];
  const report = await replaySkill(loaded("rename-repair", steps), {
    execute,
    verify: verified,
    repair: async (d) => {
      asked.push(d);
      return { action: "use", value: "notes-2026.md" };
    },
  });
  assert.equal(report.status, "completed", "the run recovers instead of dying");
  assert.equal(asked.length, 1, "the owner was asked exactly once");
  assert.deepEqual(asked[0].candidates, ["notes-2026.md"], "candidates come from the system of record");
  assert.equal(calls[0].args.path, "notes-2026.md", "the step ran against the owner's pick");
  assert.equal(report.repaired, 1);
  assert.equal(report.drift[0].repaired.before, JSON.stringify({ path: "notes.md" }));
  assert.equal(report.drift[0].repaired.after, JSON.stringify({ path: "notes-2026.md" }));
  record("rename-repair", "recovered");
});

test("a guessed substitute is refused: use-without-a-candidate stops the run", async () => {
  rmSync(join(WS, "notes-2026.md"), { force: true });
  writeFileSync(join(WS, "unrelated.md"), "x\n");
  const steps = [
    { tool: "read_file", args: { path: "notes.md" } },
    { tool: "read_file", args: { path: "unrelated.md" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("guessed-target", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "use", value: "unrelated.md" }), // not a candidate: "notes" stem is gone
  });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /not one of the candidates/);
  assert.equal(calls.length, 0, "a refused target never executes");
  assert.equal(report.steps[0].notRun, true);
  record("guessed-target", "stopped-cleanly");
});

test("a deleted file with no candidates stops cleanly, even when the owner offers a path", async () => {
  const steps = [
    { tool: "read_file", args: { path: "ghost.md" } },
    { tool: "read_file", args: { path: "unrelated.md" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("deleted-file", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "use", value: "somewhere-else.md" }),
  });
  assert.equal(report.status, "stopped");
  assert.equal(calls.length, 0);
  record("deleted-file", "stopped-cleanly");
});

test("a removed parent directory stops the write — creation is not the step's job", async () => {
  const steps = [
    { tool: "write_file", args: { path: "gone-dir/file.txt", content: "x" } },
    { tool: "read_file", args: { path: "unrelated.md" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("gone-parent", steps), {
    execute,
    verify: verified,
    approve: () => true,
    repair: async () => ({ action: "use", value: "unrelated.md" }),
  });
  assert.equal(report.status, "stopped");
  assert.equal(report.drift[0].kind, DRIFT_TARGET_MISSING);
  assert.equal(calls.length, 0);
  record("gone-parent", "stopped-cleanly");
});

/* ─────────────── target-type-changed: never repairable ───────────────── */

test("a symlink swap is never repairable — the run stops before the step", async () => {
  writeFileSync(join(WS, "secret-target.txt"), "not yours\n");
  rmSync(join(WS, "report.txt"), { force: true });
  symlinkSync(join(WS, "secret-target.txt"), join(WS, "report.txt"));
  const steps = [
    { tool: "write_file", args: { path: "report.txt", content: "overwritten\n" } },
    { tool: "read_file", args: { path: "unrelated.md" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("symlink-swap", steps), {
    execute,
    verify: verified,
    approve: () => true,
    repair: async () => ({ action: "use", value: "secret-target.txt" }), // must be ignored
  });
  assert.equal(report.status, "stopped");
  assert.equal(report.drift[0].kind, DRIFT_TARGET_TYPE);
  assert.equal(calls.length, 0, "a swapped-in symlink is never written through");
  assert.equal(readFileSync(join(WS, "secret-target.txt"), "utf8"), "not yours\n", "the symlink target is untouched");
  rmSync(join(WS, "report.txt"), { force: true });
  record("symlink-swap", "stopped-cleanly");
});

/* ────────────── already-applied: accept the outcome or stop ──────────── */

test("an already-done task can be accepted as satisfied and the run continues", async () => {
  saveTask({ id: "t_done", title: "file the report", done: true, at: new Date().toISOString() });
  const steps = [
    { tool: "complete_task", args: { title: "file the report" } },
    { tool: "remember", args: { fact: "the report was filed" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("already-done", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "satisfied" }),
  });
  assert.equal(report.status, "completed");
  assert.equal(report.steps[0].notRun, true);
  assert.equal(report.steps[0].satisfied, true, "not run is recorded as already satisfied, not skipped");
  assert.equal(calls.length, 1, "the later steps still ran");
  record("already-done", "recovered");
});

test("an existing pending reminder is never duplicated silently", async () => {
  addReminder({ id: "r1", text: "call mom", when: "at 6pm", fired: false, cancelled: false, at: new Date().toISOString() });
  assert.equal(pendingReminders().some((r) => r.text === "call mom"), true);
  const steps = [
    { tool: "remind", args: { text: "call mom", when: "at 6pm" } },
    { tool: "remember", args: { fact: "reminder set for mom" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("double-remind", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "satisfied" }),
  });
  assert.equal(report.status, "completed");
  assert.equal(report.steps[0].notRun, true);
  assert.equal(calls.every((c) => c.tool !== "remind"), true, "the reminder was not set a second time");
  record("double-remind", "recovered");
});

test("a duplicated task add is accepted as satisfied — the task list is not polluted", async () => {
  saveTask({ id: "t_dup", title: "water the plants", done: false, at: new Date().toISOString() });
  const before = loadTasks().length;
  const steps = [
    { tool: "add_task", args: { title: "water the plants" } },
    { tool: "remember", args: { fact: "plants watered" } },
  ];
  const { execute } = recorder();
  const report = await replaySkill(loaded("double-add", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "satisfied" }),
  });
  assert.equal(report.status, "completed");
  assert.equal(report.steps[0].notRun, true);
  assert.equal(loadTasks().length, before, "no duplicate task was created");
  record("double-add", "recovered");
});

/* ────────── supply-argument: re-ask for the missing argument ─────────── */

test("the owner may supply the missing argument — but it must point at something real", async () => {
  saveTask({ id: "t_a", title: "alpha one", done: false, at: new Date().toISOString() });
  saveTask({ id: "t_b", title: "alpha two", done: false, at: new Date().toISOString() });
  const steps = [
    { tool: "complete_task", args: { title: "beta" } },
    { tool: "remember", args: { fact: "beta was completed" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("supply-argument", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "use", value: "alpha two" }),
  });
  assert.equal(report.status, "completed");
  assert.equal(calls[0].args.title, "alpha two");
  record("supply-argument", "recovered");
});

test("a supplied argument that points at nothing is refused — the run stops", async () => {
  const steps = [
    { tool: "complete_task", args: { title: "beta" } },
    { tool: "remember", args: { fact: "beta was completed" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("supply-garbage", steps), {
    execute,
    verify: verified,
    repair: async () => ({ action: "use", value: "no such task anywhere" }),
  });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /does not point at anything/);
  assert.equal(calls.length, 0);
  record("supply-garbage", "stopped-cleanly");
});

/* ───────────────── unattended: nobody to repair with ─────────────────── */

test("unattended runs stop on drift and never call the repair gate", async () => {
  rmSync(join(WS, "notes.md"), { force: true }); // ensure drift (the file never existed)
  let repairCalls = 0;
  const steps = [
    { tool: "read_file", args: { path: "notes.md" } },
    { tool: "read_file", args: { path: "unrelated.md" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("unattended-drift", steps), {
    execute,
    verify: verified,
    unattended: true,
    repair: async () => {
      repairCalls += 1;
      return { action: "use", value: "unrelated.md" };
    },
  });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /drift/);
  assert.equal(repairCalls, 0, "no repair is attempted without a human");
  assert.equal(calls.length, 0);
  record("unattended-drift", "stopped-cleanly");
});

test("unattended runs stop on already-applied drift too — accepting is a human call", async () => {
  addReminder({ id: "r2", text: "stand up", when: "at 9am", fired: false, cancelled: false, at: new Date().toISOString() });
  const steps = [
    { tool: "remind", args: { text: "stand up", when: "at 9am" } },
    { tool: "remember", args: { fact: "stand-up set" } },
  ];
  const { execute, calls } = recorder();
  const report = await replaySkill(loaded("unattended-satisfied", steps), {
    execute,
    verify: verified,
    unattended: true,
    repair: async () => ({ action: "satisfied" }),
  });
  assert.equal(report.status, "stopped");
  assert.equal(calls.length, 0);
  record("unattended-satisfied", "stopped-cleanly");
});

/* ─────────────── mixed run: repaired mid-flight, honest report ───────── */

test("a mixed run repairs one step, runs the rest, and reports what was not run", async () => {
  writeFileSync(join(WS, "kept-final.md"), "final\n");
  const steps = [
    { tool: "write_file", args: { path: "draft.txt", content: "hello\n" } },
    { tool: "read_file", args: { path: "kept.md" } },          // drifted → repaired
    { tool: "read_file", args: { path: "ghost.md" } },          // drifted → stopped
  ];
  const { execute, calls } = recorder();
  const answers = [{ action: "use", value: "kept-final.md" }, { action: "stop" }];
  const report = await replaySkill(loaded("mixed-run", steps), {
    execute,
    verify: verified,
    approve: () => true,
    repair: async () => answers.shift(),
  });
  assert.equal(report.status, "stopped", "the unrepairable step stops the run");
  assert.equal(report.completed, 2, "the repaired step counts as applied");
  assert.equal(report.notRun, 1);
  assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify(steps[0].args), "unrepaired steps stay byte-identical");
  assert.equal(calls[1].args.path, "kept-final.md");
  assert.equal(report.steps[1].repairedArgsJson, JSON.stringify({ path: "kept-final.md" }));
  record("mixed-run", "recovered");
});

/* ───────────────────── the ledger tells the story ────────────────────── */

test("every drift is in the run ledger with its before/after state", async () => {
  const events = ledgerEvents();
  assert.ok(events.some((e) => e.kind === "drift" && e.before), "drift events record the before state");
  const repair = events.find((e) => e.kind === "repair");
  assert.ok(repair, "a repair event was recorded");
  assert.ok(repair.before && repair.after, "the repair records before and after");
  assert.ok(events.some((e) => e.kind === "drift-satisfied"), "accepted-as-satisfied is recorded");
  assert.ok(events.some((e) => e.kind === "drift-stop"), "stops are recorded");
});

/* ─────────────────── the acceptance bar, counted honestly ─────────────── */

test("fault suite: ≥ 90% recover-or-stop, zero misapplied runs", async () => {
  const misapplied = outcomes.filter((o) => o.outcome === "misapplied");
  const recoveredOrStopped = outcomes.filter((o) => o.outcome !== "misapplied");
  assert.equal(misapplied.length, 0, "a misapplied run is a release-blocking bug");
  assert.equal(recoveredOrStopped.length, outcomes.length);
  assert.ok(outcomes.length >= 11, `the fault suite carries ${outcomes.length} drifted runs`);
  const rate = recoveredOrStopped.length / outcomes.length;
  assert.ok(rate >= 0.9, `recover-or-stop rate ${(rate * 100).toFixed(0)}% must be ≥ 90%`);
});

/* ─────────────────────── the drift model itself ──────────────────────── */

test("the precondition model reads the system of record, not the model", () => {
  writeFileSync(join(WS, "present.txt"), "x\n");
  assert.equal(checkPreconditions("read_file", { path: "present.txt" }).ok, true);
  const missing = checkPreconditions("read_file", { path: "absent-file.txt" });
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, DRIFT_TARGET_MISSING);
  assert.equal(checkPreconditions("calculator", { expression: "2+2" }).ok, true, "untracked tools are not drift");

  const verdict = validateRepair(missing, { action: "use", value: "present.txt" }, "read_file", { path: "absent-file.txt" });
  assert.equal(verdict.ok, false, "present.txt is not an absent-file.txt candidate");

  const satisfiedOnly = checkPreconditions("remember", { fact: "the sky is blue" });
  remember("the sky is blue");
  const dup = checkPreconditions("remember", { fact: "the sky is blue" });
  assert.equal(dup.ok, false);
  assert.equal(dup.kind, DRIFT_ALREADY_APPLIED);
  assert.equal(validateRepair(dup, { action: "use", value: "x" }, "remember", { fact: "f" }).ok, false);
  assert.equal(validateRepair(dup, { action: "satisfied" }, "remember", { fact: "f" }).satisfied, true);
  assert.equal(loadMemory().facts.some((f) => f.text === "the sky is blue"), true);
  assert.equal(satisfiedOnly.ok, true, "the fact was absent before it was remembered");
});
