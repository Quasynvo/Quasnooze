/**
 * workflow.js — the design is a document, not a mood.
 *
 * Issue #108. `runAgent` inspects and acts inside one turn; that is the right
 * shape for a question and the wrong shape for a piece of work that takes ten
 * tool calls, because nothing in it is reviewable before it happens. This module
 * adds the missing half: a deterministic state machine whose states are data on
 * disk, whose plan is a bounded object a person can read, and whose transitions
 * cannot be talked into skipping a step by anything a model says.
 *
 *   inspect → design → awaiting-design-approval → planned → executing → verifying → done
 *                     ↘──────────────────────────────────────────────────────↗ blocked
 *
 * Three rules are load-bearing, and every one of them exists because the
 * alternative is an assistant that acts on a plan nobody agreed to:
 *
 *  1. **A design approval is not a tool approval.** It authorises *starting the
 *     plan* and nothing else. Every tool inside still meets `src/risk.js` and the
 *     approval gate in `src/agent.js`, unchanged.
 *  2. **Approval is single-use, session-bound and expiring.** It is created for
 *     one session, carries the hash of the plan it approved so a swapped plan
 *     cannot ride on it, is spent when execution starts, and dies with a TTL.
 *  3. **A restart never resumes.** A workflow that was `executing` when the
 *     process died carries a lease stamped with the owner epoch; a different
 *     epoch, or an expired lease, blocks it. Guessing where we were is how an
 *     assistant repeats a step that already happened.
 *
 * The plan itself is bounded data — a goal, a scope, at most eight steps and six
 * success checks — so "malformed or oversized" is a refusal with a sentence a
 * person can act on, not a silent truncation.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "../config.js";

/** Deterministic states. Order is the happy path; `blocked` is the exit on every branch. */
export const STATES = Object.freeze([
  "inspect",
  "design",
  "awaiting-design-approval",
  "planned",
  "executing",
  "verifying",
  "done",
  "blocked",
]);

const TRANSITIONS = Object.freeze({
  // `design` may loop to itself: one clarification question, then a plan.
  inspect: ["design", "blocked"],
  design: ["design", "awaiting-design-approval", "blocked"],
  // Only `approveDesign` may enter `planned`, and only it may write the approval.
  "awaiting-design-approval": ["planned", "blocked"],
  planned: ["executing", "blocked"],
  executing: ["verifying", "blocked", "done"],
  verifying: ["done", "blocked"],
  done: [],
  blocked: [],
});

/** Bounds. A plan bigger than this is a plan nobody will check before approving. */
export const LIMITS = Object.freeze({
  goalChars: 400,
  scopeItems: 12,
  scopeChars: 120,
  steps: 8,
  stepChars: 240,
  checks: 6,
  checkChars: 200,
  clarificationChars: 300,
  /** Model output is untrusted input; parse a bounded amount of it. */
  rawChars: 20_000,
  /** How many workflows the local store keeps. */
  stored: 20,
});

export const APPROVAL_TTL_MS = 10 * 60 * 1000;
export const LEASE_TTL_MS = 10 * 60 * 1000;

/**
 * This process's identity. A workflow written by another epoch is a workflow
 * whose execution state we do not know, so it is blocked rather than resumed.
 */
const EPOCH = randomUUID();

export class WorkflowStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowStoreError";
  }
}

/* ───────────────────────────────── store ───────────────────────────────── */

export function workflowStorePath() {
  return join(config.dataDir, "workflows.json");
}

function readDoc() {
  const path = workflowStorePath();
  if (!existsSync(path)) return { version: 1, workflows: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new WorkflowStoreError(
      `The workflow store at ${path} is unreadable (${err.message}). Nothing was executed and nothing was resumed. ` +
        "Move or delete that file to start clean; pending designs are not recoverable from a corrupt store.",
    );
  }
  if (!parsed || !Array.isArray(parsed.workflows)) {
    throw new WorkflowStoreError(
      `The workflow store at ${path} is not in the expected shape. Nothing was executed. ` +
        "Move or delete it to start clean.",
    );
  }
  return parsed;
}

function writeDoc(doc) {
  const path = workflowStorePath();
  mkdirSync(config.dataDir, { recursive: true });
  const bounded = {
    version: 1,
    workflows: [...doc.workflows]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, LIMITS.stored),
  };
  // tmp + rename, like src/store.js: a crash mid-write must not corrupt state.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(bounded, null, 2), "utf8");
  renameSync(tmp, path);
  return bounded;
}

function save(workflow) {
  const doc = readDoc();
  const index = doc.workflows.findIndex((w) => w.id === workflow.id);
  workflow.updatedAt = Date.now();
  if (index === -1) doc.workflows.unshift(workflow);
  else doc.workflows[index] = workflow;
  writeDoc(doc);
  return workflow;
}

/**
 * A workflow whose execution this process cannot vouch for becomes `blocked`.
 * The block is written back, because a state that only exists in memory would
 * resume on the next read — which is exactly the bug this prevents.
 */
function reconcile(stored) {
  const lease = stored.lease;
  const stale =
    ["planned", "executing", "verifying"].includes(stored.state) &&
    (!lease || lease.epoch !== EPOCH || !(lease.expiresAt > Date.now()));
  if (!stale) return stored;
  const blocked = {
    ...stored,
    state: "blocked",
    blockedReason:
      "interrupted: the run stopped before this step finished (restart, crash or an expired lease). " +
      "Nothing was resumed. Start again with /plan and approve a fresh design.",
  };
  delete blocked.lease;
  return blocked;
}

export function loadWorkflow(id) {
  const stored = readDoc().workflows.find((w) => w.id === id);
  if (!stored) return null;
  const reconciled = reconcile(stored);
  if (reconciled.state !== stored.state) return save(reconciled);
  return stored;
}

export function listWorkflows() {
  const doc = readDoc();
  let changed = false;
  const workflows = doc.workflows.map((w) => {
    const reconciled = reconcile(w);
    if (reconciled.state !== w.state) changed = true;
    return reconciled;
  });
  if (changed) writeDoc({ version: 1, workflows });
  return workflows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

const TERMINAL = new Set(["done", "blocked"]);

/** The newest workflow this session can still act on. */
export function activeWorkflowFor(sessionId) {
  return listWorkflows().find((w) => w.sessionId === sessionId && !TERMINAL.has(w.state)) || null;
}

/* ────────────────────────────── state machine ──────────────────────────── */

function move(workflow, next, patch = {}) {
  if (!TRANSITIONS[workflow.state]?.includes(next)) {
    throw new Error(`illegal transition ${workflow.state} → ${next}`);
  }
  return { ...workflow, ...patch, state: next, previousState: workflow.state };
}

function block(workflow, reason, patch = {}) {
  return { ...workflow, ...patch, state: "blocked", blockedReason: reason };
}

export function createWorkflow({ sessionId, goal, channel = "web" }) {
  const request = String(goal ?? "").trim();
  if (!sessionId) throw new Error("a workflow belongs to one session; none was given");
  const created = {
    id: `wf_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    sessionId,
    channel,
    request: request.slice(0, LIMITS.goalChars),
    state: "inspect",
    plan: null,
    approval: null,
    clarifications: 0,
    stepsAttempted: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return save(created);
}

/**
 * Parse the model's design output into bounded data.
 *
 * Tolerant about fences and prose around the object, intolerant about anything
 * that could not be checked by the person approving it: too many steps, a step
 * that is a paragraph, a missing success check.
 */
export function parsePlan(raw) {
  const text = String(raw ?? "");
  if (text.length > LIMITS.rawChars) {
    return { ok: false, error: `the design was longer than ${LIMITS.rawChars} characters` };
  }
  // Fences are a formatting habit, not a reason to refuse.
  const unfenced = text.replace(/```(?:json)?/gi, "").trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, error: "the design did not contain a JSON object" };
  }
  let parsed;
  try {
    parsed = JSON.parse(unfenced.slice(start, end + 1));
  } catch (err) {
    return { ok: false, error: `the design was not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "the design was not a JSON object" };
  }

  if (parsed.clarify !== undefined) {
    const question = typeof parsed.clarify === "string" ? parsed.clarify.trim() : "";
    if (!question) return { ok: false, error: "the clarification was empty" };
    if (question.length > LIMITS.clarificationChars) {
      return { ok: false, error: `the clarification was longer than ${LIMITS.clarificationChars} characters` };
    }
    return { ok: true, clarify: question };
  }

  const stepsIn = Array.isArray(parsed.steps) ? parsed.steps : null;
  if (!stepsIn || stepsIn.length === 0) {
    return { ok: false, error: "the design had no steps" };
  }
  if (stepsIn.length > LIMITS.steps) {
    return {
      ok: false,
      error: `the design had ${stepsIn.length} steps and the limit is ${LIMITS.steps}`,
    };
  }

  const steps = [];
  for (const [i, step] of stepsIn.entries()) {
    const action = typeof step === "string" ? step : step?.action;
    const text = String(action ?? "").trim();
    if (!text) return { ok: false, error: `step ${i + 1} had no action` };
    if (text.length > LIMITS.stepChars) {
      return {
        ok: false,
        error: `step ${i + 1} was ${text.length} characters and the limit is ${LIMITS.stepChars}`,
      };
    }
    const check = String((typeof step === "object" && step?.check) || "").trim();
    if (check.length > LIMITS.checkChars) {
      return {
        ok: false,
        error: `the check on step ${i + 1} was ${check.length} characters and the limit is ${LIMITS.checkChars}`,
      };
    }
    steps.push({ n: i + 1, action: text, ...(check ? { check } : {}) });
  }

  const checksIn = Array.isArray(parsed.successChecks) ? parsed.successChecks : [];
  if (checksIn.length > LIMITS.checks) {
    return {
      ok: false,
      error: `the design had ${checksIn.length} success checks and the limit is ${LIMITS.checks}`,
    };
  }
  const successChecks = [];
  for (const check of checksIn) {
    const text = String(check ?? "").trim();
    if (!text) continue;
    if (text.length > LIMITS.checkChars) {
      return {
        ok: false,
        error: `a success check was ${text.length} characters and the limit is ${LIMITS.checkChars}`,
      };
    }
    successChecks.push(text);
  }
  if (!successChecks.length) {
    return { ok: false, error: "the design had no success checks, so nobody could tell whether it worked" };
  }

  const scope = (Array.isArray(parsed.scope) ? parsed.scope : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  if (scope.length > LIMITS.scopeItems) {
    return { ok: false, error: `the scope had ${scope.length} entries and the limit is ${LIMITS.scopeItems}` };
  }
  const tooLongScope = scope.find((item) => item.length > LIMITS.scopeChars);
  if (tooLongScope) {
    return { ok: false, error: `a scope entry was longer than ${LIMITS.scopeChars} characters` };
  }

  const goal = String(parsed.goal ?? "").trim().slice(0, LIMITS.goalChars);
  return {
    ok: true,
    plan: {
      goal: goal || "the approved request",
      scope,
      steps,
      successChecks,
    },
  };
}

/**
 * Accept a design. Malformed or oversized output blocks the workflow — it never
 * becomes a partial plan, because a partial plan is one somebody approves without
 * reading the part that was dropped.
 */
export function submitDesign(workflowOrId, raw) {
  const workflow = typeof workflowOrId === "string" ? loadWorkflow(workflowOrId) : workflowOrId;
  if (!workflow) return { ok: false, error: "no such workflow" };
  if (!["inspect", "design"].includes(workflow.state)) {
    return { ok: false, error: `this workflow is ${workflow.state}; a design can no longer be submitted` };
  }

  const parsed = parsePlan(raw);
  if (!parsed.ok) {
    const blocked = block(workflow, `design rejected: ${parsed.error}`, { clarifications: workflow.clarifications });
    save(blocked);
    return {
      ok: false,
      error:
        `The design was not accepted and nothing was executed: ${parsed.error}. ` +
        `Ask again with at most ${LIMITS.steps} steps, each under ${LIMITS.stepChars} characters, ` +
        `and at least one success check.`,
      workflow: blocked,
    };
  }

  if (parsed.clarify) {
    if (workflow.clarifications >= 1) {
      const blocked = block(workflow, "second clarification requested", { clarifications: workflow.clarifications });
      save(blocked);
      return {
        ok: false,
        error:
          "The design asked for a second clarification and this workflow allows exactly one. " +
          "Nothing was executed. Answer the first question and start again with /plan.",
        workflow: blocked,
      };
    }
    const asked = move(workflow, "design", { clarifications: workflow.clarifications + 1, question: parsed.clarify });
    save(asked);
    return { ok: true, clarify: parsed.clarify, workflow: asked };
  }

  // Inspect → design → awaiting, in two steps: the machine records that a design
  // was produced rather than teleporting past the state that says so.
  const designedFrom = workflow.state === "inspect" ? move(workflow, "design") : workflow;
  const designed = move(designedFrom, "awaiting-design-approval", { plan: parsed.plan, question: null });
  save(designed);
  return { ok: true, plan: designed.plan, workflow: designed };
}

/** Record that the one permitted clarification was used (tests and the agent share this). */
export function noteClarification(id) {
  const workflow = loadWorkflow(id);
  if (!workflow) return null;
  return save({ ...workflow, clarifications: Math.max(1, workflow.clarifications) });
}

function hashPlan(plan) {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex").slice(0, 32);
}

/**
 * Approve a design. This writes an approval record and moves to `planned`; it
 * does not run anything, and it grants no tool permission of any kind.
 */
export function approveDesign({ id, sessionId, now = Date.now() }) {
  const workflow = loadWorkflow(id);
  if (!workflow) return { ok: false, reason: "no such workflow" };
  if (workflow.sessionId !== sessionId) {
    return {
      ok: false,
      reason: "a design can only be approved in the session that requested it",
    };
  }
  if (workflow.state !== "awaiting-design-approval") {
    return { ok: false, reason: `this workflow is ${workflow.state}, not awaiting approval` };
  }
  if (!workflow.plan) return { ok: false, reason: "there is no plan to approve" };

  const approval = {
    token: randomUUID(),
    sessionId,
    planHash: hashPlan(workflow.plan),
    createdAt: now,
    expiresAt: now + APPROVAL_TTL_MS,
    usedAt: null,
  };
  const planned = move(workflow, "planned", {
    approval,
    lease: { epoch: EPOCH, pid: process.pid, expiresAt: now + LEASE_TTL_MS },
  });
  save(planned);
  return { ok: true, workflow: planned };
}

/**
 * Start executing an approved plan. The approval is verified — session, plan
 * hash, expiry, single use — and spent here, before any tool runs.
 */
export function beginExecution({ id, sessionId, now = Date.now() }) {
  const workflow = loadWorkflow(id);
  if (!workflow) return { ok: false, reason: "no such workflow" };
  if (workflow.state !== "planned") {
    return { ok: false, reason: `this workflow is ${workflow.state}, not planned` };
  }
  const approval = workflow.approval;
  if (!approval || approval.sessionId !== sessionId) {
    return { ok: false, reason: "this workflow has no approval for this session" };
  }
  if (approval.usedAt) return { ok: false, reason: "the design approval was already used" };
  if (!(approval.expiresAt > now)) {
    const expired = block(workflow, "the design approval expired before execution started", { lease: undefined });
    save(expired);
    return { ok: false, reason: "the design approval expired; approve the design again" };
  }
  if (hashPlan(workflow.plan) !== approval.planHash) {
    const swapped = block(workflow, "the plan changed after it was approved");
    save(swapped);
    return { ok: false, reason: "the plan changed after approval; nothing was executed" };
  }

  const executing = move(workflow, "executing", {
    approval: { ...approval, usedAt: now },
    lease: { epoch: EPOCH, pid: process.pid, expiresAt: now + LEASE_TTL_MS },
  });
  save(executing);
  return { ok: true, workflow: executing, plan: executing.plan };
}

/** Move through `verifying` to a terminal state. */
export function finishExecution({ id, ok, detail = "" }) {
  const workflow = loadWorkflow(id);
  if (!workflow) return { ok: false, reason: "no such workflow" };
  if (!["executing", "verifying"].includes(workflow.state)) {
    return { ok: false, reason: `this workflow is ${workflow.state}, so it is not running` };
  }
  let next = workflow.state === "executing" ? move(workflow, "verifying") : workflow;
  next = ok
    ? { ...next, state: "done", detail, outcome: "done" }
    : block(next, detail || "the run did not complete", { outcome: "blocked" });
  delete next.lease;
  return { ok: true, state: next.state, workflow: save(next) };
}

export function cancelWorkflow({ id, sessionId, reason = "cancelled by the owner" }) {
  const workflow = loadWorkflow(id);
  if (!workflow) return { ok: false, reason: "no such workflow" };
  if (workflow.sessionId !== sessionId) {
    return { ok: false, reason: "only the session that started a workflow can cancel it" };
  }
  if (TERMINAL.has(workflow.state)) return { ok: false, reason: `this workflow is already ${workflow.state}` };
  const cancelled = block(workflow, reason, { cancelled: true });
  delete cancelled.lease;
  save(cancelled);
  return { ok: true, workflow: cancelled };
}

/* ────────────────────────────── presentation ───────────────────────────── */

/** The design as a person reads it: numbered, with the checks beside them. */
export function renderPlan(plan) {
  const lines = [`Goal: ${plan.goal}`];
  if (plan.scope?.length) lines.push(`Scope: ${plan.scope.join(", ")}`);
  lines.push("", "Steps:");
  for (const step of plan.steps) {
    lines.push(`  ${step.n}. ${step.action}${step.check ? `  → check: ${step.check}` : ""}`);
  }
  lines.push("", "Done when:");
  for (const check of plan.successChecks) lines.push(`  • ${check}`);
  return lines.join("\n");
}

/* ──────────────────────────── chat commands ────────────────────────────── */

/**
 * `/plan`, `/approve`, `/cancel` — the whole interface, deliberately three verbs.
 *
 * Returns null when workflow mode is off, so `/plan …` is ordinary text on a
 * machine where the owner has not opted in. A command the product does not
 * implement must not half-work.
 */
export function parseWorkflowCommand(text, { enabled = config.workflow } = {}) {
  if (!enabled) return null;
  const match = /^\/(plan|approve|cancel)\b\s*([\s\S]*)$/i.exec(String(text ?? "").trim());
  if (!match) return null;
  const verb = match[1].toLowerCase();
  const arg = match[2].trim();
  if (verb !== "plan" && arg) return { verb, arg, error: `/${verb} takes no arguments` };
  return { verb, arg };
}
