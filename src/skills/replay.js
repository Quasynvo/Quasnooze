/**
 * src/skills/replay.js — run a compiled skill with zero model calls.
 *
 * The whole point of compiling a conversation is that the thousandth run
 * costs what the first one cost: no model round-trip, no re-planning, no
 * arguments re-invented. Replay passes the recorded arguments byte-for-byte
 * (JSON.stringify of the executed args equals JSON.stringify of the compiled
 * args) and checks everything that must be re-checked:
 *
 *   1. the owner approved *this content* (registry approval, digest-bound);
 *   2. every step is re-classified against *current* policy — the recorded
 *      tier is not trusted, because policy moves. A step that is blocked or
 *      no longer exists refuses the whole replay, cleanly;
 *   3. dangerous steps go through the approval gate again (a plan is not
 *      authority), and fresh-consent steps (type_text) cannot be waved
 *      through by any blanket approval;
 *   4. every step's preconditions are re-read from the system of record
 *      first (F08, drift.js): if the world moved — the file is gone, the
 *      task is closed, the reminder already exists — the replay repairs
 *      with the owner's explicit choice or stops cleanly. It never guesses
 *      a substitute target, and unattended runs stop on drift;
 *   5. every applied step is verified by independent read-back (skill-02):
 *      a contradiction stops the replay and is reported as a contradiction,
 *      never as success.
 *
 * Stopping is the default repair strategy (F08's "stop, don't guess"): when
 * anything is off — policy, precondition, result, verification — the replay
 * halts with the steps it actually ran and the exact reason it stopped.
 * Nothing is skipped silently, nothing is guessed, nothing is reported done
 * that was not verified. Every drift is recorded in the run ledger
 * (src/agent/ledger.js) with its before/after state.
 */
import { TOOL_MAP } from "../tools.js";
import { classifyCommand, classifyToolAction, BLOCKED, ACT } from "../risk.js";
import { verifyAction } from "../verify.js";
import { config } from "../config.js";
import { SkillError } from "./manifest.js";
import { checkPreconditions, validateRepair } from "./drift.js";
import { recordLedgerEvent } from "../agent/ledger.js";

/**
 * Re-check one step against the policy of *today*.
 *
 * @returns {{allowed: boolean, tier: string, needsApproval: boolean, freshApproval: boolean, reason: string}}
 */
export function checkStepPolicy(toolName, args = {}) {
  const tool = TOOL_MAP.get(toolName);
  if (!tool) {
    return {
      allowed: false,
      tier: BLOCKED,
      needsApproval: false,
      freshApproval: false,
      reason: `no such tool in the current registry: ${toolName}`,
    };
  }
  if (toolName === "shell") {
    // The command is re-screened from scratch: a command recorded when it was
    // allowed must not run if the screen refuses it now.
    const verdict = classifyCommand(String(args?.command ?? ""), { workspaceRoots: config.workspaceRoots });
    return {
      allowed: verdict.tier !== BLOCKED,
      tier: verdict.tier,
      needsApproval: verdict.tier === ACT,
      freshApproval: false,
      reason: verdict.why,
    };
  }
  const action = classifyToolAction(toolName);
  return {
    allowed: true,
    tier: action.tier,
    needsApproval: Boolean(tool.dangerous) || action.freshApproval,
    freshApproval: action.freshApproval,
    reason: action.why,
  };
}

function stepRecord(step, patch = {}) {
  return Object.freeze({
    tool: step.tool,
    argsJson: JSON.stringify(step.args),
    ok: false,
    applied: false,
    verification: null,
    ...patch,
  });
}

/**
 * Replay a loaded skill.
 *
 * @param {object} loaded the `{manifest, digest, approval}` shape from loadSkill
 * @param {object} options
 * @param {(tool: string, args: object) => Promise<{ok: boolean, output?: string}>|{ok: boolean}} options.execute
 *   how running a tool is performed — the caller decides (the real tool
 *   registry in the CLI, fakes in tests). Replay never touches the model.
 * @param {(step: object) => boolean|Promise<boolean>} [options.approve]
 *   the approval gate for dangerous steps. Without it, dangerous steps stop
 *   the replay cleanly.
 * @param {boolean} [options.freshConsent] required before fresh-consent steps
 *   (type_text) may be considered at all — a blanket approval cannot bypass
 *   fresh consent (src/risk.js).
 * @param {(name, args, ctx, result) => Promise<object|null>} [options.verify]
 *   independent read-back; defaults to the shipped skill-02 verifier.
 * @param {object} [options.ctx] tool/verifier context (session, channel, …)
 * @param {boolean} [options.unattended] nobody is present: drift stops the
 *   run and no repair is ever attempted.
 * @param {(drift) => Promise<object>|object} [options.repair] the owner gate
 *   for drift (candidates, before/after). Answers: `{action:"stop"}`,
 *   `{action:"satisfied"}` (already-applied drift), or `{action:"use", value}`
 *   where the value must prove itself (see drift.js). Absent ⇒ stop on drift.
 * @returns {Promise<object>} a frozen replay report
 */
export async function replaySkill(loaded, { execute, approve = null, freshConsent = false, verify = verifyAction, ctx = {}, unattended = false, repair = null } = {}) {
  if (!loaded || typeof loaded !== "object" || !loaded.manifest) {
    throw new SkillError("replay needs a skill loaded through the registry (loadSkill) — a raw manifest has no approval state");
  }
  if (typeof execute !== "function") {
    throw new SkillError("replay needs an execute(tool, args) function — what running a tool means is the caller's decision");
  }
  const { manifest, approval } = loaded;
  const steps = [];
  const driftEvents = [];
  const started = Date.now();
  const report = (status, reason = null) =>
    Object.freeze({
      kind: "quasnooze-skill-replay",
      name: manifest.name,
      status,
      reason,
      steps: steps.map((s) => Object.freeze(s)),
      completed: steps.filter((s) => s.applied).length,
      total: manifest.steps.length,
      drift: driftEvents.map((e) => Object.freeze({ ...e })),
      repaired: driftEvents.filter((e) => e.repaired).length,
      notRun: steps.filter((s) => s.notRun).length,
      ms: Date.now() - started,
    });

  if (!approval || approval.approved !== true) {
    return report("refused", approval?.stale
      ? "the skill's content changed after the owner approved it — review and approve again"
      : "this skill is not owner-approved — `quasnooze skills approve` first");
  }

  for (const step of manifest.steps) {
    const policy = checkStepPolicy(step.tool, step.args);
    if (!policy.allowed) {
      steps.push(stepRecord(step, { notRun: true, policy }));
      return report("stopped", `policy refused step ${steps.length} (${step.tool}): ${policy.reason}`);
    }
    if (policy.freshApproval && !freshConsent) {
      steps.push(stepRecord(step, { notRun: true, policy }));
      return report("stopped", `step ${steps.length} (${step.tool}) needs fresh consent — no blanket approval may bypass it`);
    }
    if (policy.needsApproval) {
      const yes = typeof approve === "function" ? await approve({ tool: step.tool, argsJson: JSON.stringify(step.args), tier: policy.tier, freshApproval: policy.freshApproval, reason: policy.reason }) : false;
      if (yes !== true) {
        steps.push(stepRecord(step, { notRun: true, policy }));
        return report("stopped", `step ${steps.length} (${step.tool}) needs approval and was not approved`);
      }
    }

    // Drift (F08): the compiled step is a statement about the world — this
    // file was there, that task was open, this reminder was not yet set.
    // Re-read the system of record *before* the step; on drift, repair with
    // the owner's explicit choice or stop cleanly. Never guess.
    const precondition = checkPreconditions(step.tool, step.args);
    let execArgs = step.args;
    if (!precondition.ok) {
      const event = {
        step: steps.length + 1,
        tool: step.tool,
        kind: precondition.kind,
        expected: precondition.expected,
        actual: precondition.actual,
        before: JSON.stringify(step.args),
      };
      driftEvents.push(event);
      recordLedgerEvent({
        kind: "drift",
        skill: manifest.name,
        driftKind: precondition.kind,
        step: event.step,
        tool: event.tool,
        expected: event.expected,
        actual: event.actual,
        before: event.before,
      });
      let answer = { action: "stop" };
      if (!unattended && typeof repair === "function") {
        try {
          answer = (await repair({ ...event, repair: precondition.repair, candidates: precondition.candidates })) ?? { action: "stop" };
        } catch {
          answer = { action: "stop" };
        }
      }
      const verdict = validateRepair(precondition, answer, step.tool, step.args);
      if (verdict.satisfied) {
        event.outcome = "accepted as already satisfied — not run";
        recordLedgerEvent({ kind: "drift-satisfied", skill: manifest.name, driftKind: precondition.kind, step: event.step, tool: event.tool, before: event.before });
        steps.push(stepRecord(step, { notRun: true, satisfied: true, drift: event }));
        continue;
      }
      if (verdict.ok) {
        execArgs = verdict.args;
        event.repaired = { before: JSON.stringify(step.args), after: JSON.stringify(verdict.args) };
        event.outcome = `repaired (${precondition.repair})`;
        recordLedgerEvent({ kind: "repair", skill: manifest.name, driftKind: precondition.kind, step: event.step, tool: event.tool, before: event.repaired.before, after: event.repaired.after });
      } else {
        event.outcome = "not run";
        recordLedgerEvent({ kind: "drift-stop", skill: manifest.name, driftKind: precondition.kind, step: event.step, tool: event.tool, before: event.before });
        steps.push(stepRecord(step, { notRun: true, drift: event }));
        return report("stopped", verdict.reason === "stop"
          ? `drift at step ${steps.length} (${step.tool}): ${precondition.kind} — stopping, not guessing`
          : `drift at step ${steps.length} (${step.tool}): ${precondition.kind} — ${verdict.reason}`);
      }
    }

    // Byte-identity: the executor receives an exact JSON copy of the compiled
    // arguments — same bytes in, same bytes out. A repaired step's bytes are
    // the owner's, recorded as such in the step and drift records.
    const args = JSON.parse(JSON.stringify(execArgs));
    let result;
    try {
      result = await execute(step.tool, args);
    } catch (err) {
      steps.push(stepRecord(step, { policy, error: String(err?.message ?? err) }));
      return report("stopped", `step ${steps.length} (${step.tool}) threw: ${String(err?.message ?? err)}`);
    }
    const ok = Boolean(result?.ok);
    const verification = ok ? await verify(step.tool, args, ctx, result) : null;
    // "applied" follows the receipts model: a contradicted read-back means the
    // operation counts as not applied, whatever the tool claimed.
    const applied = ok && verification?.status !== "contradicted";
    steps.push(stepRecord(step, {
      ok,
      applied,
      policy,
      verification: verification ? { status: verification.status, detail: verification.detail } : null,
      ...(execArgs !== step.args ? { repairedArgsJson: JSON.stringify(execArgs) } : {}),
    }));
    if (!ok) {
      return report("stopped", `step ${steps.length} (${step.tool}) failed — stopping rather than guessing (details in the step record)`);
    }
    if (verification?.status === "contradicted") {
      return report("stopped", `step ${steps.length} (${step.tool}) was contradicted by its read-back — stopping, not reporting success`);
    }
  }
  return report("completed");
}
