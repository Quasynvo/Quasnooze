/**
 * src/skills/drift.js — the world moved; stop, don't guess (F08).
 *
 * A compiled step is a statement about the world as it was: this file was
 * there, that task was open, this reminder was not yet set. Replay re-reads
 * the system of record *before* each step and asks whether the statement is
 * still true. When it is not, the run has drifted and exactly three things
 * may happen:
 *
 *   1. a bounded, owner-visible repair (re-resolve the target, re-ask the
 *      missing argument) — the owner picks from candidates this module
 *      derived deterministically, or supplies a value that must re-prove
 *      itself against the system of record;
 *   2. a step already satisfied (the task is done, the reminder exists) —
 *      the owner may accept that as the outcome and the run continues;
 *   3. a clean stop with the drift in the report. Nothing else.
 *
 * There is no fourth thing. A substitute target that the owner did not pick
 * is a misapplied run, and a misapplied run is a release-blocking bug — so
 * `validateRepair` refuses any value outside the candidate set (target
 * re-resolution) or one that fails its own precondition re-check (supplied
 * arguments), and a swapped-in symlink or directory is never repairable at
 * all. Unattended runs never reach this module's repair path: with nobody to
 * ask, drift stops the run.
 */
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadMemory, loadTasks, pendingReminders } from "../store.js";
import { resolveInWorkspace } from "../tools.js";

/** Drift kinds. `repair` says what, if anything, may be attempted. */
export const DRIFT_TARGET_MISSING = "target-missing";
export const DRIFT_TARGET_TYPE = "target-type-changed";
export const DRIFT_ALREADY_APPLIED = "already-applied";

export const REPAIR_RERESOLVE = "re-resolve-target";
export const REPAIR_SUPPLY = "supply-argument";
export const REPAIR_SATISFIED = "satisfied";

const MAX_CANDIDATES = 5;

const sameText = (a, b) => String(a ?? "").trim().slice(0, 500).toLowerCase() === String(b ?? "").trim().slice(0, 500).toLowerCase();

/** Deterministic rename candidates: regular files in the same directory
 *  whose name is the recorded name or shares its stem ("results.md" →
 *  "results-2026.md"). Never outside the recorded directory, never a
 *  symlink, capped and sorted so the owner sees the same list we do. */
function fileCandidates(pathArg) {
  const dir = dirname(pathArg);
  const base = basename(pathArg);
  const stem = base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
  let names = [];
  try {
    const absDir = resolveInWorkspace(join(pathArg, ".."));
    names = readdirSync(absDir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .filter((name) => name === base || (stem && name.startsWith(stem)))
      .sort();
  } catch {
    return [];
  }
  return names.slice(0, MAX_CANDIDATES).map((name) => join(dir, name));
}

function drift(kind, repair, { argument, expected, actual, candidates = [] }) {
  return { ok: false, kind, repair, argument, expected, actual, candidates };
}

const fine = { ok: true };

function checkFileTarget(tool, args) {
  const pathArg = String(args?.path ?? "");
  if (!pathArg) return fine;
  let abs;
  try {
    abs = resolveInWorkspace(pathArg);
  } catch {
    return fine; // outside the workspace is the tool's refusal, not drift
  }
  let stat = null;
  try {
    stat = lstatSync(abs);
  } catch (err) {
    if (err?.code !== "ENOENT") return fine;
    if (tool === "write_file") {
      // Creating the file is the step's job; the directory it lands in is not.
      try {
        const parent = lstatSync(join(abs, ".."));
        if (parent.isDirectory()) return fine;
        return drift(DRIFT_TARGET_TYPE, null, {
          argument: "path",
          expected: "a writable directory",
          actual: "the parent is not a directory",
        });
      } catch {
        return drift(DRIFT_TARGET_MISSING, REPAIR_RERESOLVE, {
          argument: "path",
          expected: pathArg,
          actual: "the parent directory is gone",
          candidates: [],
        });
      }
    }
    return drift(DRIFT_TARGET_MISSING, REPAIR_RERESOLVE, {
      argument: "path",
      expected: pathArg,
      actual: "no such file",
      candidates: fileCandidates(pathArg),
    });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return drift(DRIFT_TARGET_TYPE, null, {
      argument: "path",
      expected: "a regular file",
      actual: stat.isSymbolicLink() ? "a symbolic link" : "not a regular file",
    });
  }
  return fine;
}

function checkTaskTarget(args) {
  const title = String(args?.title ?? "");
  if (!title) return fine;
  const needle = title.toLowerCase();
  const tasks = loadTasks();
  const open = tasks.filter((t) => !t.done && String(t.title).toLowerCase().includes(needle));
  if (open.length) return fine;
  const done = tasks.filter((t) => t.done && String(t.title).toLowerCase().includes(needle));
  if (done.length) {
    return drift(DRIFT_ALREADY_APPLIED, REPAIR_SATISFIED, {
      argument: "title",
      expected: `an open task matching “${title}”`,
      actual: `the only match is already done: “${done[0].title}”`,
    });
  }
  return drift(DRIFT_TARGET_MISSING, REPAIR_SUPPLY, {
    argument: "title",
    expected: `an open task matching “${title}”`,
    actual: "no open task matches",
    candidates: tasks.filter((t) => !t.done).slice(0, MAX_CANDIDATES).map((t) => t.title),
  });
}

/** What the world must look like before `tool(args)` runs as compiled. */
export function checkPreconditions(tool, args) {
  switch (tool) {
    case "read_file":
    case "write_file":
      return checkFileTarget(tool, args);
    case "add_task": {
      const title = String(args?.title ?? "");
      const hit = title && loadTasks().find((t) => sameText(t.title, title));
      return hit
        ? drift(DRIFT_ALREADY_APPLIED, REPAIR_SATISFIED, {
            argument: "title",
            expected: "no task with this title yet",
            actual: `a task “${hit.title}” already exists`,
          })
        : fine;
    }
    case "complete_task":
      return checkTaskTarget(args);
    case "remind": {
      const text = String(args?.text ?? "");
      const hit = text && pendingReminders().find((r) => r.text === text);
      return hit
        ? drift(DRIFT_ALREADY_APPLIED, REPAIR_SATISFIED, {
            argument: "text",
            expected: "no pending reminder with this text",
            actual: "a pending reminder with this text already exists",
          })
        : fine;
    }
    case "remember": {
      const fact = String(args?.fact ?? "");
      const hit = fact && loadMemory().facts.find((e) => sameText(e.text, fact));
      return hit
        ? drift(DRIFT_ALREADY_APPLIED, REPAIR_SATISFIED, {
            argument: "fact",
            expected: "this fact not yet in memory",
            actual: "this fact is already in memory",
          })
        : fine;
    }
    default:
      return fine;
  }
}

/**
 * Turn an owner's answer into runnable args — or refuse.
 *
 * answers: { action: "stop" }
 *          { action: "satisfied" }        (already-applied drift only)
 *          { action: "use", value }       (value must prove itself: inside
 *                                          the candidate set for target
 *                                          re-resolution, or passing its own
 *                                          precondition re-check when the
 *                                          owner supplies a missing argument)
 */
export function validateRepair(precondition, answer, tool, args) {
  if (!precondition || precondition.ok) return { ok: true, args };
  if (!answer || answer.action === "stop") return { ok: false, reason: "stop" };
  if (answer.action === "satisfied") {
    return precondition.repair === REPAIR_SATISFIED
      ? { ok: true, satisfied: true }
      : { ok: false, reason: "this drift cannot be accepted as already satisfied" };
  }
  if (answer.action === "use") {
    const value = answer.value;
    if (precondition.repair === REPAIR_RERESOLVE) {
      if (!precondition.candidates.includes(value)) {
        return { ok: false, reason: "the owner's target is not one of the candidates — refusing a guessed path" };
      }
      return { ok: true, args: { ...args, [precondition.argument]: value } };
    }
    if (precondition.repair === REPAIR_SUPPLY) {
      const patched = { ...args, [precondition.argument]: value };
      const recheck = checkPreconditions(tool, patched);
      return recheck.ok
        ? { ok: true, args: patched }
        : { ok: false, reason: "the supplied value does not point at anything in the system of record" };
    }
  }
  return { ok: false, reason: "this drift is not repairable" };
}
