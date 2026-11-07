/**
 * agent.js — the loop that makes Pinch an agent instead of a chat toy.
 *
 *   user message → model → (tool call → permission? → run → observe) → … → answer
 *
 * Hard rules:
 *  • max 8 tool rounds per turn, so a confused model cannot spin forever;
 *  • a dangerous tool never runs without either explicit approval or
 *    PINCH_AUTO_APPROVE=true;
 *  • every tool failure is fed back to the model as text, never swallowed.
 */
import { buildActionPreview, previewSecrets, approvalDescription, sanitizeActionPreview } from "./action-preview.js";
import { config } from "./config.js";
import { personaCommand } from "./personas.js";
import { brain } from "./brain.js";
import { QuasError, classify } from "./failure.js";
import { assistantText } from "./assistant-text.js";
import { buildSystemPrompt, buildConversationPrompt, isSocialTurn, buildPersonaMessage,
  buildWorkflowDesignMessages, buildWorkflowPlanMessage } from "./prompt.js";
import { createSources, addSource, listSources } from "./sources.js";
import { validateCitations, renderSourceBlock } from "./citations.js";
import { classifyCommand, classifySystemControl, classifyToolAction, describeTier, detectCommitProposal, READ as TIER_READ, BLOCKED as TIER_BLOCKED } from "./risk.js";
import { POLICY_DECISIONS, resolveHarnessPipeline } from "./harness/events.js";
import { TOOL_MAP, DANGEROUS, toolSchemas, SafePathError, screenCommand, isClipboardEnabled, isTrackerEnabled, TRACKER_TOOL_NAMES } from "./tools.js";
import { mintWriteApproval } from "./tracker/adapter.js";
import { loadSession, appendMessage, loadMemory } from "./store.js";
import { auditReply, renderGuardNote, sanitizeTraceEntry } from "./guard.js";
import { addressFor } from "./outbound.js";
import { renderForPrompt } from "./attachments.js";
import { normalizeStages, record } from "./telemetry.js";
import { matchFastIntent, composeFastReply, FAST_TOOLS } from "./fast-path.js";
import { parseWorkflowCommand, createWorkflow, submitDesign, approveDesign, beginExecution, finishExecution,
  cancelWorkflow, activeWorkflowFor, loadWorkflow, renderPlan, WorkflowStoreError, LIMITS as WORKFLOW_LIMITS } from "./agent/workflow.js";
import { verifyAction, describeVerification, CONTRADICTED as VERIFY_CONTRADICTED } from "./verify.js";

const MAX_ROUNDS = 8;
/** Characters of tool output one turn may carry into the context, in total. */
const TOOL_OUTPUT_BUDGET = 24_000;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/* ───────────────────────────── approvals ───────────────────────────────── */

const approvals = new Map(); // id -> { resolve, timer, channel, description, createdAt }

/**
 * Session-scoped approval grants: sessionId -> Set of grant keys.
 *
 * Only risk.js may nominate a grant key (today: the reversible volume/media
 * subset of system_control). A grant is recorded solely when a human answers
 * an approval prompt that disclosed the session scope, lives in memory only,
 * and dies with the process — it is never persisted or shared across sessions.
 */
const sessionGrants = new Map();

function hasSessionGrant(sessionId, grantKey) {
  return Boolean(grantKey && sessionGrants.get(sessionId)?.has(grantKey));
}

function recordSessionGrant(sessionId, grantKey) {
  if (!grantKey) return;
  if (!sessionGrants.has(sessionId)) sessionGrants.set(sessionId, new Set());
  sessionGrants.get(sessionId).add(grantKey);
}

/**
 * Create a permission prompt. Returns { id, promise } so the blocking
 * caller and the channel that draws the buttons share the same id.
 */
export function createApproval({ channel, sessionId = "", description, preview }) {
  const secrets = [...previewSecrets(), config.authKey, config.llm.openaiKey, config.telegram.token, config.discord.token, config.slack.token];
  description = approvalDescription(description, secrets);
  preview = preview ? sanitizeActionPreview(preview, secrets) : undefined;
  const id = `ap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  let entry;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    // A prompt nobody answers must not be the only reason the process is alive.
    timer.unref?.();
    entry = { resolve, timer, channel, sessionId, description, preview, createdAt: Date.now() };
    approvals.set(id, entry);
  });
  return { id, promise };
}

/** Called by any channel/handler when the user says yes/no or taps a button. */
export function answerApproval(id, allowed) {
  const entry = approvals.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  approvals.delete(id);
  entry.resolve(Boolean(allowed));
  return true;
}

/**
 * "yes" / "no" typed in chat.
 *
 * Matches on session first: two conversations on one channel (two Telegram
 * chats behind one bot, two browser tabs) both looked like "telegram", so a
 * yes in one could approve a command raised in the other. Falls back to the
 * channel when the caller has no session to offer.
 */
export function answerApprovalFor({ sessionId, channel }, allowed) {
  if (sessionId) {
    const entries = [...approvals.entries()]
      .filter(([, v]) => v.sessionId === sessionId)
      .sort((a, b) => b[1].createdAt - a[1].createdAt);
    if (entries.length) return answerApproval(entries[0][0], allowed);
  }
  return answerApprovalByChannel(channel, allowed);
}

/** @deprecated prefer answerApprovalFor — a channel is not an identity. */
export function answerApprovalByChannel(channel, allowed) {
  const entries = [...approvals.entries()]
    .filter(([, v]) => v.channel === channel)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  if (!entries.length) return false;
  return answerApproval(entries[0][0], allowed);
}

export function pendingApprovals(channel) {
  return [...approvals.entries()]
    .filter(([, v]) => !channel || v.channel === channel)
    .map(([id, v]) => ({ id, channel: v.channel, sessionId: v.sessionId, description: v.description, ...(v.preview ? { preview: v.preview } : {}) }));
}

/** Pending prompts for one conversation — what the panel and router ask for. */
export function pendingApprovalsFor(sessionId) {
  return [...approvals.entries()]
    .filter(([, v]) => v.sessionId === sessionId)
    .map(([id, v]) => ({ id, channel: v.channel, sessionId: v.sessionId, description: v.description, ...(v.preview ? { preview: v.preview } : {}) }));
}

async function awaitApprovalWithSignal({ id, promise }, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    answerApproval(id, false);
    return false;
  }
  const onAbort = () => {
    answerApproval(id, false);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await promise;
  } finally {
    try {
      signal.removeEventListener("abort", onAbort);
    } catch {}
  }
}

/* ─────────────────────────── tool argument contract ────────────────────── */

/**
 * Check a call against the tool's own JSON Schema before anything runs.
 *
 * The schema was documentation: the model was trusted to fill required fields
 * and not invent others, and `write_file` with `path: undefined` reached the
 * filesystem as `.`. A missing argument is now a sentence the model can act
 * on, which measurably improves small-model tool use — and an unknown one is
 * usually a hallucinated parameter name, which is worth saying out loud.
 *
 * @returns {string|null} a message for the model, or null if the call is fine
 */
export function validateArgs(tool, args) {
  const schema = tool.parameters || {};
  const required = schema.required || [];
  const allowed = Object.keys(schema.properties || {});
  const given = Object.keys(args || {});

  const missing = required.filter((k) => args?.[k] === undefined || args?.[k] === null);
  if (missing.length) {
    return `Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}. Call ${tool.name} again with ${missing.join(", ")}.`;
  }
  if (allowed.length) {
    const unknown = given.filter((k) => !allowed.includes(k));
    if (unknown.length) {
      return `Unknown argument${unknown.length === 1 ? "" : "s"} for ${tool.name}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}.`;
    }
  }
  return null;
}

/* ──────────────────────────────── agent ────────────────────────────────── */

/**
 * One line a human can actually judge.
 *
 * This used to fall back to `name(key, key, key)` for everything except shell
 * and write_file — so the prompt for the tool that takes a filename said
 * "screenshot(path)" and showed the word "path". The human gate is the
 * load-bearing control here; a gate that withholds the argument is theatre.
 * Values are shown, truncated, with shell metacharacters called out.
 */
export function describeCall(name, args) {
  const a = args || {};
  if (name === "shell") {
    const screen = screenCommand(a.command || "");
    // Surface paths outside the workspace in the prompt itself: the human
    // decision is the real control, so give them the one detail that matters.
    const outside = screen.escapes?.length ? `  ⚠ outside workspace: ${screen.escapes.join(", ")}` : "";
    return `run: ${a.command}${a.cwd ? `  (in ${a.cwd})` : ""}${outside}`;
  }
  if (name === "write_file") return `write ${a.path} (${Buffer.byteLength(a.content || "", "utf8")} bytes)`;
  // File actions are batches: the human gate has to see every operation in
  // the plan, not "operations=[object Object]".
  if (name === "move_path" || name === "rename_path" || name === "trash_path") {
    const ops = Array.isArray(a.operations) ? a.operations : [];
    const parts = ops.slice(0, 6).map((op) => {
      const raw =
        name === "move_path" ? `${op?.from} → ${op?.to}`
        : name === "rename_path" ? `${op?.path} → ${op?.new_name}`
        : String(op?.path);
      const flat = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw;
      const risky = /[$`(){}|;&<>]/.test(flat) ? "  ⚠ shell metacharacters" : "";
      return flat + risky;
    });
    const more = ops.length > parts.length ? ` (+${ops.length - parts.length} more)` : "";
    return `${name}(${ops.length} operation${ops.length === 1 ? "" : "s"}): ${parts.join("; ")}${more}`;
  }
  if (name === "tracker_list_tickets") return `tracker_list_tickets (${a.repo ? `in ${String(a.repo).slice(0, 80)}` : "local tickets"})`;
  if (name === "tracker_read_ticket") return `tracker_read_ticket: ${String(a.id ?? "?").slice(0, 64)}`;
  if (name === "tracker_draft_ticket") {
    const labels = Array.isArray(a.labels) ? a.labels.slice(0, 10) : [];
    const title = String(a.title ?? "").slice(0, 160);
    return `draft ticket "${title}"${labels.length ? `  [${labels.join(", ")}]` : ""} (${Buffer.byteLength(String(a.body ?? ""), "utf8")} byte body)`;
  }
  if (name === "undo_last") return "undo_last — reverse the most recent file-action batch from the journal";
  if (name === "list_recent_changes") return `list_recent_changes(limit=${a.limit ?? 10})`;
  if (name === "read_clipboard") {
    return "read_clipboard — read current system clipboard (this read only; bounded to 4,096 bytes)";
  }
  if (name === "write_clipboard") {
    const raw = typeof a.text === "string" ? a.text : "";
    return `write_clipboard (${Buffer.byteLength(raw, "utf8")} bytes): ${JSON.stringify(raw)}`;
  }

  const shown = Object.entries(a)
    .map(([key, value]) => {
      const flat = String(value).replace(/\s+/g, " ");
      const clipped = flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
      const risky = /[$`(){}|;&<>]/.test(flat) ? "  ⚠ shell metacharacters" : "";
      return `${key}=${clipped}${risky}`;
    })
    .join(", ");
  return `${name}(${shown})`;
}

/**
 * Run one turn.
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.text
 * @param {string} opts.channel
 * @param {(event: object) => void} [opts.onEvent] live progress for the UI
 */
/**
 * A failed turn, said precisely.
 *
 * Everything used to come out as "unreachable … use ollama serve", including a rate limit and a
 * rejected key, which sent people to restart a service that was running fine. The code says what
 * kind of failure it was, the trail says what else was tried, and the hint is the one from the
 * taxonomy rather than a guess made here.
 */
export function explainBrainFailure(err, model) {
  const failure = err instanceof QuasError ? err : classify(err, { provider: model?.provider });
  const attempts = failure.attempts || [];
  const trail = attempts.length > 1
    ? `\nTried: ${attempts.map((a) => (a.ok ? `${a.backend} ✔` : `${a.backend} → ${a.code}`)).join(" → ")}.`
    : "";
  const where = `${model?.provider || failure.provider || "the model"} / ${model?.model || "unknown"}`;
  return (
    `∿ Model unavailable: ${failure.message}\n\n` +
    `${failure.code} on ${where}.${trail}\n` +
    failure.hint
  );
}

/* ──────────────────────── design workflow commands ────────────────────── */

const WORKFLOW_HELP =
  "Design workflow (opt-in):\n" +
  "  /plan <goal>   draft a bounded plan — nothing runs\n" +
  "  /approve       approve this session's design and start it\n" +
  "  /cancel        stop it; a cancelled design cannot be resumed\n" +
  "Approving a design authorises starting the plan and nothing else: every tool inside still asks the way it always did.";

/**
 * Handle `/plan`, `/approve`, `/cancel`.
 *
 * Returns `{ reply }` for a turn that ends here, or `{ execute }` for `/approve`,
 * which hands control back to the ordinary tool loop. Nothing in this function
 * runs a tool, and nothing in it can approve one.
 */
async function handleWorkflowCommand({ command, sessionId, channel, onEvent, activeModel }) {
  const active = activeWorkflowFor(sessionId);
  const emit = (workflow) => onEvent({ type: "workflow", id: workflow.id, state: workflow.state });

  if (command.verb === "cancel") {
    if (!active) return { reply: "There is no workflow to cancel in this session." };
    const cancelled = cancelWorkflow({ id: active.id, sessionId });
    if (!cancelled.ok) return { reply: `Nothing was cancelled: ${cancelled.reason}.` };
    emit(cancelled.workflow);
    return {
      reply: `Cancelled ${active.id}. It is blocked and cannot be resumed; nothing further will run. Start a new design with /plan <goal>.`,
    };
  }

  // A design that is waiting for the one permitted clarification takes the next
  // `/plan <answer>` as its answer rather than starting a second workflow.
  const answering = active && active.state === "design" && active.clarifications >= 1 ? active : null;
  const continuing = active && ["awaiting-design-approval", "planned", "executing"].includes(active.state) ? active : null;

  if (command.verb === "plan") {
    if (continuing) {
      return {
        reply:
          `This session already has an open design (${continuing.id}, ${continuing.state}).\n` +
          `Run it with /approve, drop it with /cancel, or read it again with /plan.`,
      };
    }
    if (!command.arg && !answering) return { reply: WORKFLOW_HELP };

    let workflow = active;
    if (!answering) {
      if (!String(command.arg).trim()) return { reply: WORKFLOW_HELP };
      workflow = createWorkflow({ sessionId, goal: command.arg, channel });
      onEvent({ type: "workflow", id: workflow.id, state: workflow.state });
    }

    const design = await brain
      .chat(
        buildWorkflowDesignMessages({
          request: workflow.request,
          ...(answering ? { clarification: answering.question, answer: command.arg } : {}),
        }),
        { selection: activeModel, tools: [], maxTokens: 900, think: false },
      )
      .then((out) => ({ content: out?.content ?? "" }))
      .catch((err) => ({ error: err }));

    if (design.error) {
      // No design exists, so there is nothing to approve and nothing to run.
      // Block the workflow so a later /approve cannot resurrect a half-turn.
      submitDesign(workflow, "");
      return {
        reply: `∿ Could not draft a design, so nothing was executed.\n\n${explainBrainFailure(design.error, activeModel)}`,
      };
    }

    const submitted = submitDesign(loadWorkflow(workflow.id) || workflow, design.content);
    const stored = submitted.workflow || loadWorkflow(workflow.id);
    if (stored) emit(stored);

    if (!submitted.ok) return { reply: submitted.error };
    if (submitted.clarify) {
      return {
        reply: `${submitted.clarify}\n\nAnswer with /plan <answer> and I will draft the plan. One question only.`,
      };
    }
    return {
      reply:
        `Design ${workflow.id} — nothing has run yet.\n\n${renderPlan(submitted.plan)}\n\n` +
        `Approve it with /approve, or drop it with /cancel. Approving authorises starting the plan; ` +
        `each tool inside still asks for permission exactly as it does today. ` +
        `Limits: ${WORKFLOW_LIMITS.steps} steps, ${WORKFLOW_LIMITS.stepChars} characters per step.`,
    };
  }

  // verb === "approve"
  if (!active) {
    return { reply: "No design is waiting for approval in this session. Start one with /plan <goal>." };
  }
  if (active.state !== "awaiting-design-approval") {
    return {
      reply: `This session's workflow is ${active.state}, so there is nothing to approve. Start one with /plan <goal>.`,
    };
  }

  const approved = approveDesign({ id: active.id, sessionId });
  if (!approved.ok) return { reply: `Not approved: ${approved.reason}. Nothing was executed.` };
  emit(approved.workflow);

  const began = beginExecution({ id: active.id, sessionId });
  if (!began.ok) return { reply: `Not started: ${began.reason}. Nothing was executed.` };
  emit(began.workflow);

  return { execute: { id: active.id, plan: began.plan } };
}

export async function runAgent({
  sessionId,
  text,
  attachments = [],
  channel = "web",
  target = "",
  onEvent = () => {},
  // "interactive" is a human in the loop. "unattended" is a scheduled run with
  // nobody to ask — every dangerous tool is refused instead of prompted, and
  // nothing can create another schedule, because a schedule that can spawn
  // schedules is a fork bomb with a calendar.
  autonomy = "interactive",
  allowSchedule = true,
  harness,
  signal,
  // Latency marks, owned by whoever can see the clock they are measured against.
  // `stages` is mutated in place by the caller (the HTTP layer marks the first
  // delta it writes); this function fills the mark it owns and normalises the
  // object on the way to disk.
  stages = null,
  stageAnchor = null,
}) {
  const activeHarness = resolveHarnessPipeline(harness, config.harnessEvents);
  const turnSecrets = () => [
    ...previewSecrets(),
    config.authKey,
    config.llm.openaiKey,
    config.telegram.token,
    config.discord.token,
    config.slack.token,
  ];
  if (autonomy === "unattended" && /^\/persona(?:\s|$)/i.test(String(text).trim())) {
    return {text:"Persona commands require an interactive user; no persona settings were changed.",sessionId,trace:[],guard:[],sources:[],ms:0,firstTextMs:null,error:null};
  }
  const command = attachments.length ? null : personaCommand(text, sessionId);
  if (command !== null) return {text:command,sessionId,trace:[],guard:[],sources:[],ms:0,firstTextMs:null,error:null};
  const activeModel = brain.active; // Pin provider/model for the entire tool loop.
  const startedAt = Date.now();
  // The server passes the instant the request arrived; a channel, the CLI or a
  // test has no such instant and anchors on this turn's start instead. Either
  // way a stage is a duration from a real clock, never a guess.
  const stageAnchorAt = Number.isFinite(stageAnchor) ? stageAnchor : startedAt;
  const markFirstToken = () => {
    if (stages && stages.firstTokenMs === null) stages.firstTokenMs = Math.max(0, Date.now() - stageAnchorAt);
  };
  const withStages = (event) => (stages ? { ...event, stages: normalizeStages(stages) } : event);
  const unattended = autonomy === "unattended";
  const simpleTurn = (reply) => (markFirstToken(), {
    text: reply,
    firstTextMs: Date.now() - startedAt,
    error: null,
    trace: [],
    sessionId,
    guard: [],
    sources: [],
    ms: Date.now() - startedAt,
  });

  // ── the opt-in design workflow (issue #108) ─────────────────────────────
  // Intercepted here, before the loop, so `/plan` costs one model call and runs
  // nothing. `/approve` does not return: it starts the plan and then falls
  // through into the loop below, unchanged, which is the point — the design
  // approval is a separate gate, not a bypass of the tool gates.
  const wfCommand = attachments.length ? null : parseWorkflowCommand(text, { enabled: config.workflow });
  let workflowRun = null;
  if (wfCommand) {
    if (unattended) {
      return simpleTurn("A scheduled run cannot start a design workflow: approving a plan needs a person who is here. Nothing was designed and nothing ran.");
    }
    if (wfCommand.error) return simpleTurn(wfCommand.error);
    let outcome;
    try {
      outcome = await handleWorkflowCommand({ command: wfCommand, sessionId, channel, onEvent, activeModel });
    } catch (err) {
      // A corrupt store, a refused transition, a model that vanished: all of them
      // end the turn with a sentence, never with a half-started plan.
      const why = err instanceof WorkflowStoreError ? err.message : `the workflow could not continue (${err.message})`;
      return simpleTurn(`∿ Nothing was executed. ${why}`);
    }
    if (outcome.reply !== undefined) return simpleTurn(outcome.reply);
    workflowRun = outcome.execute || null;
  }

  const social = workflowRun ? false : isSocialTurn(text, attachments);
  const session = loadSession(sessionId);
  // A transport failure is UI/runtime evidence, not the assistant's persona.
  // Do not prime a recovered model to keep claiming it is offline.
  const recent = session.messages.filter((m) =>
    (m.role === "user" || m.role === "assistant") &&
    !(m.role === "assistant" && (["brain-unreachable", "model-output-invalid"].includes(m.error) || /^(?:∿ Model unavailable|\u{1F99E} My brain is unreachable)/u.test(m.content)))
  ).slice(social ? -6 : -24);
  // Only the last attachment-bearing message keeps its excerpt; older ones keep
  // the one-line "you attached X" note, which is enough to answer follow-ups
  // without carrying 2 KB of document per turn.
  const lastAttached = recent.map((m) => Boolean(m.attachments?.length)).lastIndexOf(true);
  const history = recent.map((m, i) => {
    if (!m.attachments?.length) return { role: m.role, content: m.role === "assistant" ? assistantText(m.content).text : m.content };
    const names = m.attachments.map((a) => `${a.name} (${a.kind})`).join(", ");
    const note = `[attached: ${names}]`;
    return { role: m.role, content: i === lastAttached && m.excerpt ? `${m.content}\n\n${note}\n${m.excerpt}` : `${m.content}\n\n${note}` };
  });

  // The document itself lives for one turn (it is in memory, not on disk), but
  // the *fact* that it was attached has to outlive it: "and what was the total
  // on page 2?" was unanswerable because the next turn saw only the typed text.
  // A bounded excerpt, not the whole file, so history stays history-sized.
  const attached = attachments.map((a) => ({
    name: a.name,
    kind: a.kind,
    bytes: a.bytes,
    chars: (a.text || "").length,
    images: (a.images || []).length,
  }));
  appendMessage(sessionId, {
    role: "user",
    content: text,
    // Plain extracted text, never the <untrusted-document> wrapper: a stale
    // wrapper replayed into history would look like a live attachment and would
    // still be carrying its "this is data" preamble three turns later.
    ...(attached.length
      ? { attachments: attached, excerpt: attachments.map((a) => a.text || "").join("\n").slice(0, 2000) }
      : {}),
  });

  // ── deterministic turns ────────────────────────────────────────────────
  // "What time is it" has one correct reading and one correct tool. Sending it
  // through a model costs a prefill and a decode, and occasionally invents the
  // time. The matcher is narrow on purpose: a miss is one ordinary model turn,
  // while a false match is an action nobody asked for — so ambiguity falls
  // through unchanged, and a tool that fails falls through too, because the
  // model can ask a better question than an error string.
  if (config.fastPath && !unattended && !social && !attachments.length && !workflowRun && !signal?.aborted) {
    const fast = matchFastIntent(text);
    const tool = fast ? TOOL_MAP.get(fast.name) : null;
    if (tool && FAST_TOOLS.has(fast.name) && !DANGEROUS.has(fast.name) && !validateArgs(tool, fast.args)) {
      let fastBlocked = false;
      if (activeHarness) {
        const secrets = turnSecrets();
        const fastPolicy = await activeHarness.beforeTool(
          {
            sessionId,
            channel,
            autonomy,
            round: 1,
            tool,
            args: fast.args,
            risk: null,
            commitProposal: detectCommitProposal(fast.name, fast.args, { tool }),
          },
          { signal, secrets },
        );
        if (fastPolicy.decision === POLICY_DECISIONS.DENY) {
          const reason = fastPolicy.cancelled ? "cancelled" : fastPolicy.reason || "policy";
          const reply = fastPolicy.cancelled
            ? "Turn cancelled before action execution."
            : `Refused by policy (${reason}): no action was executed.`;
          const deniedTrace = [{
            tool: fast.name,
            args: fast.args,
            ok: false,
            denied: true,
            ...(fastPolicy.cancelled ? { cancelled: true } : {}),
            ...(fastPolicy.failedClosed ? { failedClosed: true } : {}),
            reason,
          }];
          appendMessage(sessionId, { role: "assistant", content: reply, trace: deniedTrace, guard: [] });
          onEvent({ type: "tool_done", name: fast.name, ok: false, preview: reply.slice(0, 200) });
          const fastMs = Date.now() - startedAt;
          return { text: reply, firstTextMs: fastMs, error: null, trace: deniedTrace, sessionId, guard: [], sources: [], ms: fastMs };
        }
        if (fastPolicy.decision === POLICY_DECISIONS.ASK) {
          const preview = buildActionPreview(fast.name, fast.args, { risk: null, secrets });
          const description = approvalDescription(describeCall(fast.name, fast.args), secrets);
          const approval = createApproval({ channel, sessionId, description, preview });
          onEvent({ type: "approval", id: approval.id, description, preview });
          const allowed = await awaitApprovalWithSignal(approval, signal);
          if (signal?.aborted || !allowed) {
            const cancelled = Boolean(signal?.aborted);
            const reply = cancelled
              ? "Turn cancelled before action execution."
              : "Permission denied; no action was executed.";
            const deniedTrace = [{
              tool: fast.name,
              args: fast.args,
              ok: false,
              denied: true,
              ...(cancelled ? { cancelled: true, reason: "cancelled" } : {}),
            }];
            appendMessage(sessionId, { role: "assistant", content: reply, trace: deniedTrace, guard: [] });
            return { text: reply, firstTextMs: Date.now() - startedAt, error: null, trace: deniedTrace, sessionId, guard: [], sources: [], ms: Date.now() - startedAt };
          }
        }
      }
      if (signal?.aborted) fastBlocked = true;
      if (!fastBlocked) {
        const fastToolStart = Date.now();
        let fastResult;
        try {
          fastResult = await tool.run(fast.args, {
            channel,
            target: addressFor(channel, target),
            sessionId,
            sources: createSources(),
            userText: text,
            clipboardTouched: false,
            clipboardReads: [],
          });
        } catch (err) {
          fastResult = { ok: false, output: err instanceof SafePathError ? err.message : `Tool ${fast.name} threw: ${err.message}` };
        }
        const fastVerification = await verifyAction(fast.name, fast.args, { sessionId, channel }, fastResult);
        if (activeHarness) {
          const fastRaw = String(fastResult?.output ?? "");
          await activeHarness.afterTool(
            {
              sessionId,
              channel,
              autonomy,
              round: 1,
              tool,
              ok: Boolean(fastResult?.ok),
              denied: false,
              cancelled: false,
              status: fastResult?.ok ? "ok" : "error",
              durationMs: Date.now() - fastToolStart,
              outputBytes: Buffer.byteLength(fastRaw, "utf8"),
              verificationStatus: fastVerification?.status ?? null,
            },
            { secrets: turnSecrets() },
          );
        }
        // A deterministic answer that cannot be confirmed is not an answer: hand
        // the turn to the model rather than return a claim nobody checked.
        if (fastResult?.ok && fastVerification?.status !== VERIFY_CONTRADICTED) {
          let reply = composeFastReply(fast, fastResult.output);
          const fastTrace = [{
            tool: fast.name,
            args: fast.args,
            ok: true,
            output: String(fastResult.output).slice(0, 400),
            ...(fastVerification ? { verification: fastVerification } : {}),
          }];
          let fastGuard = { flags: [], clean: true };
          if (!config.disableGuard) {
            fastGuard = auditReply({
              reply,
              trace: fastTrace,
              sources: [],
              citedIds: [],
              memoryFacts: loadMemory().facts,
              userText: text,
              toolOutput: String(fastResult.output ?? ""),
            });
            if (!fastGuard.clean) reply += renderGuardNote(fastGuard.flags);
          }
          appendMessage(sessionId, { role: "assistant", content: reply, trace: fastTrace, guard: fastGuard.flags });
          const fastMs = Date.now() - startedAt;
          markFirstToken();
          record(withStages({
            kind: "turn",
            sessionId,
            channel,
            autonomy,
            provider: activeModel.provider,
            model: activeModel.model,
            ms: fastMs,
            firstTextMs: fastMs,
            mode: "fast",
            rounds: 0,
            tokens: 0,
            tools: 1,
            auto: 0,
            guardFlags: fastGuard.flags.length,
            error: null,
          }));
          onEvent({ type: "tool_done", name: fast.name, ok: true, preview: String(fastResult.output).slice(0, 300) });
          return { text: reply, firstTextMs: fastMs, error: null, trace: fastTrace, sessionId, guard: fastGuard.flags, sources: [], ms: fastMs };
        }
      }
    }
  }

  // Attached files become a labelled block ahead of the question, and images
  // travel with the message itself for a vision-capable model. The wrapper is
  // the mitigation against a document that contains instructions; see
  // docs/AUDIT.md for why it is a mitigation and not a promise.
  const attachmentBlock = renderForPrompt(attachments);
  const userTurn = { role: "user", content: attachmentBlock.text ? `${attachmentBlock.text}\n\n---\n\n${text}` : text };
  if (attachmentBlock.images.length) userTurn.images = attachmentBlock.images;

  const persona = buildPersonaMessage(sessionId);
  let messages = [
    { role: "system", content: social ? buildConversationPrompt({ channel }) : buildSystemPrompt({ channel }) },
    ...history,
    ...(persona ? [persona] : []),
    ...(workflowRun ? [buildWorkflowPlanMessage(workflowRun)] : []),
    userTurn,
  ];

  const trace = [];
  const toolOutputs = [];
  let finalText = "";
  let brainFailed = false, modelOutputFailed = false, firstTextMs = null;
  let rounds = 0;
  let tokens = 0;
  let toolBudget = TOOL_OUTPUT_BUDGET;
  let autoRan = 0;
  // What this turn actually retrieved. Only these can be cited; see sources.js.
  const sources = createSources();
  for (const a of attachments) {
    addSource(sources, { kind: "attachment", title: a.name, ref: a.name, snippet: (a.text || "").slice(0, 160) });
  }
  // One id for this turn, so anything it mutates (the file-action journal)
  // can be traced back to the conversation that asked for it.
  const turnId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ctx = {
    channel,
    target: addressFor(channel, target),
    sessionId,
    turnId,
    sources,
    userText: text,
    clipboardTouched: false,
    clipboardReads: [],
  };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) {
      finalText = "Turn cancelled before action execution.";
      break;
    }
    rounds = round + 1;
    onEvent({ type: "status", message: round === 0 ? "thinking" : "thinking again" });

    let out;
    try {
      // Stream the model's words straight to whoever is waiting. Tool rounds
      // usually produce no text, so this costs nothing when it does not apply.
      out = await brain.chat(messages, {
        selection: activeModel,
        tools: social ? [] : toolSchemas(),
        ...(social ? {maxTokens:128,think:false} : {}),
        ...(activeHarness
          ? {
              onBeforeContextTrim: (trimInfo) =>
                activeHarness.beforeContextTrim(
                  { ...trimInfo, sessionId, channel, autonomy, round },
                  { secrets: turnSecrets() },
                ),
            }
          : {}),
        onDelta: (chunk) => {
          if (firstTextMs === null) { firstTextMs = Date.now() - startedAt; markFirstToken(); }
          onEvent({ type: "delta", text: chunk });
        },
      });
    } catch (err) {
      brainFailed = true;
      finalText = explainBrainFailure(err, activeModel);
      break;
    }

    tokens += out.tokens || 0;

    if (social && out.toolCalls?.length) {
      modelOutputFailed = true;
      finalText = "The model tried to call a tool during a greeting. No action was taken; please state your request.";
      break;
    }
    if (!out.toolCalls?.length) {
      modelOutputFailed = Boolean(out.reasoningFiltered && !out.content?.trim());
      finalText = (out.content || "").trim() || (modelOutputFailed ? "The model returned internal reasoning without a final answer. Check its non-thinking mode or select a conversational model." : "(The model returned an empty reply.)");
      break;
    }

    messages.push({ role: "assistant", content: out.content || "", toolCalls: out.toolCalls });

    for (const call of out.toolCalls) {
      const tool = TOOL_MAP.get(call.name);
      const label = describeCall(call.name, call.arguments);

      if (!tool) {
        messages.push({
          role: "tool", name: call.name, toolCallId: call.id,
          content: `No such tool: ${call.name}. Available: ${[...TOOL_MAP.keys()].join(", ")}`,
        });
        continue;
      }

      // 1. Validate arguments first — before policy checks, approval, or execution.
      const invalid = call.parseError
        ? `Your arguments were not valid JSON (${call.parseError}). Re-emit ${call.name} with valid JSON.`
        : validateArgs(tool, call.arguments);
      if (invalid) {
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: invalid });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, invalid: true });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: invalid.slice(0, 200) });
        continue;
      }

      if (signal?.aborted) {
        const why = "Cancelled: this action was aborted before execution.";
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: why });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, cancelled: true, reason: "cancelled" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: why });
        continue;
      }

      // Ticket tracking is opt-in and default-off. The schemas are already
      // hidden, but a model that remembered the name from an earlier session
      // must get a refusal, not a filesystem read.
      if (TRACKER_TOOL_NAMES.includes(tool.name) && !isTrackerEnabled()) {
        const msg = "Ticket tracking is off (QUASNOOZE_TRACKER=off). Nothing was read or written. " +
          "The owner can enable it with QUASNOOZE_TRACKER=on and run tracker setup.";
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: msg });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason: "disabled" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: msg });
        continue;
      }

      if ((tool.name === "read_clipboard" || tool.name === "write_clipboard") && !isClipboardEnabled()) {
        const msg = `Clipboard access is disabled (QUASNOOZE_CLIPBOARD=off). Nothing was ${tool.name === "read_clipboard" ? "read" : "written"}.`;
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: msg });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason: "disabled" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: msg });
        continue;
      }

      // Side-effect-free preparation can capture the real target for a dry-run
      // approval. Its result is trusted tool state, never model-writable args.
      let actionPreparation;
      if (typeof tool.prepare === "function") {
        try {
          actionPreparation = await tool.prepare(call.arguments || {}, { ...ctx, signal });
        } catch (err) {
          const why = String(err?.message || err).slice(0, 600);
          messages.push({ role: "tool", name: tool.name, toolCallId: call.id, content: why });
          trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason: err?.code || "preview-failed" });
          onEvent({ type: "tool_done", name: tool.name, ok: false, preview: why.slice(0, 200) });
          continue;
        }
      }

      const classifiedShell =
        tool.name === "shell" && (config.riskTiers || activeHarness)
          ? classifyCommand(call.arguments?.command, {
              workspaceRoots: config.workspaceRoots,
              cwd: call.arguments?.cwd,
            })
          : null;
      const tier =
        config.riskTiers && !config.autoApprove && tool.name === "shell" && !unattended
          ? classifiedShell
          : null;
      const commitProposal = detectCommitProposal(tool.name, call.arguments, { tool });
      // Volume/media system_control actions are `act` but non-destructive:
      // one disclosed approval may cover the rest of the session. Unattended
      // runs never consult grants — the unattended gate below still refuses.
      const sysControl = tool.name === "system_control" ? classifySystemControl(call.arguments?.action) : null;
      const grantKey = sysControl?.sessionGrantable && !unattended ? sysControl.grantKey : null;
      const sessionGranted = hasSessionGrant(sessionId, grantKey);

      // 2. Deterministic policy checks (beforeTool, plus beforeCommit on commit proposals).
      // Handlers may restrict ("ask" / "deny") or fail closed; they can never authorize.
      let policyDecision = POLICY_DECISIONS.CONTINUE;
      let policyReason = null;
      let policyCancelled = false;
      let policyFailedClosed = false;
      let policyUnattendedRefused = false;

      if (activeHarness) {
        const secrets = turnSecrets();
        const beforeOut = await activeHarness.beforeTool(
          {
            sessionId,
            channel,
            autonomy,
            round,
            tool,
            args: call.arguments,
            risk: classifiedShell,
            commitProposal,
          },
          { signal, secrets },
        );
        policyDecision = beforeOut.decision;
        policyReason = beforeOut.reason;
        policyCancelled = Boolean(beforeOut.cancelled);
        policyFailedClosed = Boolean(beforeOut.failedClosed);
        policyUnattendedRefused = Boolean(beforeOut.unattendedRefused);

        if (policyDecision !== POLICY_DECISIONS.DENY && commitProposal.isCommit) {
          const commitOut = await activeHarness.beforeCommit(
            {
              sessionId,
              channel,
              autonomy,
              round,
              tool,
              args: call.arguments,
              commitProposal,
            },
            { signal, secrets },
          );
          policyDecision =
            commitOut.decision === POLICY_DECISIONS.DENY
              ? POLICY_DECISIONS.DENY
              : POLICY_DECISIONS.ASK;
          policyReason = commitOut.reason || policyReason;
          if (commitOut.cancelled) policyCancelled = true;
          if (commitOut.failedClosed) policyFailedClosed = true;
          if (commitOut.unattendedRefused) policyUnattendedRefused = true;
        }
      }

      if (policyCancelled || signal?.aborted) {
        const why = "Cancelled: this action was aborted before execution.";
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: why });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, cancelled: true, reason: "cancelled" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: why });
        continue;
      }

      if (policyFailedClosed) {
        const reason = policyReason || "policy-error";
        const msg = `Refused: policy check failed closed (${reason}). No action was executed.`;
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: msg });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, failedClosed: true, reason });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: msg.slice(0, 200) });
        continue;
      }

      if (
        policyDecision === POLICY_DECISIONS.DENY &&
        !policyUnattendedRefused &&
        policyReason !== "blocked-by-command-screen"
      ) {
        const reason = policyReason || "policy";
        const msg = `Refused by policy (${reason}): this action is not permitted.`;
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: msg });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: msg.slice(0, 200) });
        continue;
      }

      // 3. Existing unattended, catastrophic-screen, and session user-approval gates.
      // Policy "continue" (or ignored "allow") never suppresses any baseline gate.
      if (
        unattended &&
        (DANGEROUS.has(tool.name) ||
          commitProposal.isCommit ||
          (tool.name === "schedule" && !allowSchedule) ||
          policyDecision !== POLICY_DECISIONS.CONTINUE)
      ) {
        const why = tool.name === "schedule"
          ? "a scheduled run cannot create another schedule"
          : `${tool.name} needs a human's approval and nobody is here`;
        messages.push({
          role: "tool", name: call.name, toolCallId: call.id,
          content: `Refused: ${why}. Do the part you can do without it, and say plainly in your answer what you could not do and why.`,
        });
        trace.push({ tool: tool.name, args: call.arguments, denied: true, reason: "unattended" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: `refused (unattended): ${why}` });
        continue;
      }

      const blockedRisk =
        tier?.tier === TIER_BLOCKED
          ? tier
          : activeHarness && classifiedShell?.tier === TIER_BLOCKED
            ? classifiedShell
            : null;
      if (blockedRisk) {
        messages.push({
          role: "tool", name: call.name, toolCallId: call.id,
          content: `Refused: ${blockedRisk.why}. This command is not runnable at all, with or without approval.`,
        });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason: "screen", tier: "blocked" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: `refused: ${blockedRisk.why}` });
        continue;
      }

      const toolRisk = classifyToolAction(tool.name);
      const baselineMustAsk = DANGEROUS.has(tool.name) && !config.autoApprove && tier?.tier !== TIER_READ && !sessionGranted;
      const policyMustAsk = toolRisk.freshApproval ||
        policyDecision === POLICY_DECISIONS.ASK ||
        (commitProposal.isCommit && (!config.autoApprove || Boolean(activeHarness)));

      if (tier?.tier === TIER_READ && !policyMustAsk) {
        autoRan += 1;
        onEvent({ type: "auto", name: tool.name, why: describeTier(tier) });
      }
      if (sessionGranted && !policyMustAsk && DANGEROUS.has(tool.name) && !config.autoApprove) {
        // Surface the skipped prompt instead of hiding it: the transcript must
        // show this ran under an earlier session approval, not silently.
        onEvent({ type: "auto", name: tool.name, why: "volume/media control approved earlier this session" });
      }

      const mustAsk = baselineMustAsk || policyMustAsk;
      // Set only by the branch below, after a human answered yes to *this*
      // call. It is per-iteration state, so it cannot leak to the next tool.
      let trackerWriteApproval = null;
      if (mustAsk) {
        const secrets = turnSecrets();
        const preview = buildActionPreview(tool.name, call.arguments, { risk: tier || classifiedShell || toolRisk, preparation: actionPreparation, secrets });
        // The scope of a yes is part of the question: a session-grantable
        // approval says so in the prompt itself, never retroactively.
        const description = approvalDescription(
          grantKey
            ? `${label}\nApproving also allows further volume/media control in this session without asking again. Lock and sleep always ask.`
            : label,
          secrets,
        );
        const approval = createApproval({ channel, sessionId, description, preview });
        onEvent({ type: "approval", id: approval.id, description, preview });
        const allowed = await awaitApprovalWithSignal(approval, signal);
        if (signal?.aborted) {
          const why = "Cancelled: this action was aborted while awaiting approval.";
          messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: why });
          trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, cancelled: true, reason: "cancelled" });
          onEvent({ type: "tool_done", name: tool.name, ok: false, preview: why });
          continue;
        }
        if (!allowed) {
          messages.push({
            role: "tool", name: call.name, toolCallId: call.id,
            content: "The user denied permission for this action. Do not retry it; ask what they would prefer.",
          });
          trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true });
          onEvent({ type: "tool_done", name: tool.name, ok: false, denied: true, preview: `denied: ${label}`.slice(0, 200) });
          continue;
        }
        // A disclosed session-grantable approval was answered yes: remember it
        // for this session only, so the next volume press does not re-prompt.
        recordSessionGrant(sessionId, grantKey);
        // The ticket-drafting adapter refuses writes without this token, and
        // only this line can mint it: the model cannot approve its own write,
        // because tool arguments are JSON and this is object identity.
        if (mustAsk) trackerWriteApproval = mintWriteApproval({ tool: tool.name, sessionId, turnId });
      }

      if (signal?.aborted) {
        const why = "Cancelled: this action was aborted before execution.";
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: why });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, cancelled: true, reason: "cancelled" });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: why });
        continue;
      }

      // 4. Execute tool.
      onEvent({ type: "tool", name: tool.name, label });
      const toolStartedAt = Date.now();
      let result;
      try {
        // Let evidence-producing tools avoid registering passages the model
        // cannot see because the remaining tool-output budget is exhausted.
        ctx.toolOutputLimit = Math.min(12_000, Math.max(0, toolBudget));
        result = await tool.run(call.arguments || {}, {
          ...ctx,
          signal,
          ...(actionPreparation !== undefined ? { actionPreparation } : {}),
          ...(trackerWriteApproval ? { trackerApproval: trackerWriteApproval } : {}),
        });
      } catch (err) {
        result = {
          ok: false,
          output:
            err instanceof SafePathError
              ? err.message
              : `Tool ${tool.name} threw: ${err.message}`,
        };
      }

      // A tool's return value is a claim, not proof. Read the world back before
      // the model is allowed to describe what happened; a contradiction goes
      // into the tool message so the model must correct itself rather than
      // reporting an action that did not take effect.
      const verification = await verifyAction(tool.name, call.arguments || {}, ctx, result);
      if (verification) {
        onEvent({ type: "verification", name: tool.name, status: verification.status, detail: verification.detail });
      }

      // Per call it was already capped at 12 000 chars; eight rounds of eight
      // calls could still push ~750 KB into one context. The budget is per
      // turn, and when it runs out the model is told why rather than fed a
      // silently truncated wall of text.
      const raw = String(result.output ?? "");

      // 5. Bounded observational after-event (no raw output, cannot alter result).
      if (activeHarness) {
        await activeHarness.afterTool(
          {
            sessionId,
            channel,
            autonomy,
            round,
            tool,
            ok: Boolean(result?.ok),
            denied: false,
            cancelled: false,
            status: result?.ok ? "ok" : "error",
            durationMs: Date.now() - toolStartedAt,
            outputBytes: Buffer.byteLength(raw, "utf8"),
            verificationStatus: verification?.status ?? null,
          },
          { secrets: turnSecrets() },
        );
      }

      const room = Math.max(0, toolBudget);
      const kept = raw.slice(0, Math.min(12_000, room));
      toolBudget -= kept.length;
      const content = kept.length < raw.length
        ? `${kept}\n\n[output truncated — ${raw.length - kept.length} characters not shown; the per-turn tool output budget is ${TOOL_OUTPUT_BUDGET} characters]`
        : kept;

      const effectiveOk = Boolean(result.ok) && verification?.status !== VERIFY_CONTRADICTED;
      toolOutputs.push(kept);
      const safePreview = typeof result.traceSummary === "string" ? result.traceSummary : kept;
      trace.push(
        sanitizeTraceEntry({
          tool: tool.name,
          args: call.arguments,
          ok: result.ok,
          output: kept.slice(0, 400),
          traceSummary: result.traceSummary,
          ...(verification ? { verification } : {}),
          ...(tier?.tier === TIER_READ && !policyMustAsk ? { tier: "read", auto: true } : {}),
          ...(sessionGranted ? { sessionGrant: true } : {}),
        }),
      );
      onEvent({
        type: "tool_done",
        name: tool.name,
        ok: effectiveOk,
        verification: verification ? { status: verification.status, detail: verification.detail } : null,
        preview:
          verification?.status === VERIFY_CONTRADICTED
            ? `contradicted — ${verification.detail}`.slice(0, 300)
            : safePreview.slice(0, 300),
      });

      // A contradicted action is not allowed to be described as done: the note
      // travels with the tool output, so the next model turn cannot miss it.
      const proof = verification?.status === VERIFY_CONTRADICTED
        ? `\n\n[verification: contradicted — ${verification.detail}. Do not describe this action as done; state what is actually true and what you will try instead.]`
        : "";
      messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: content + proof });
    }
  }

  if (!finalText) {
    finalText =
      "∿ I hit my tool limit for one turn (8 rounds) without landing an answer. " +
      "Ask me to continue and I'll pick up from here.";
  }

  // Post-hoc honesty check: does the reply match what actually happened?
  // Citation validation runs on the model's own words, before the source block
  // is appended — otherwise the footer's URLs would look like invented links.
  const citations = validateCitations({ text: finalText, sources: listSources(sources) });

  let guard = { flags: [], clean: true };
  if (!config.disableGuard && !brainFailed && !modelOutputFailed) {
    guard = auditReply({
      reply: finalText,
      trace,
      sources: listSources(sources),
      citedIds: citations.cited,
      memoryFacts: loadMemory().facts,
      // A document the user attached IS evidence. Passing only `text` meant a
      // reply that quoted an invoice's sender was flagged as inventing an
      // address — a false positive on correct behaviour, which is how an
      // honesty check gets switched off and stops catching the real thing.
      userText: attachmentBlock.text ? `${text}\n${attachmentBlock.text}` : text,
      toolOutput: toolOutputs.join("\n"),
    });
    if (!guard.clean) {
      finalText += renderGuardNote(guard.flags);
      onEvent({ type: "guard", flags: guard.flags });
    }
  }

  // If an action was contradicted, the user is told by the transcript itself.
  // The model was already handed the contradiction; this is the half that does
  // not depend on the model repeating it.
  const contradicted = trace.filter((t) => t.verification?.status === "contradicted");
  if (contradicted.length) {
    finalText +=
      `\n\n⚠︎ ${contradicted.length === 1 ? "One action" : `${contradicted.length} actions`} could not be ` +
      `confirmed by an independent read-back: ${contradicted.map((t) => describeVerification(t.verification)).join("; ")}`;
  }

  // The footer is evidence, so it appears only when the reply cites something.
  // An answer from memory must not wear a "Sources" heading: the heading itself
  // implies research, and a heading with nothing under it is a small lie.
  // A plan that met a denial or a contradiction did not finish, and the state on
  // disk says so — otherwise the next turn would believe the work was done.
  if (workflowRun) {
    const stoppedBy = trace.filter((t) => t.denied || t.verification?.status === VERIFY_CONTRADICTED);
    const finished = finishExecution({
      id: workflowRun.id,
      ok: !brainFailed && !modelOutputFailed && stoppedBy.length === 0,
      detail: brainFailed
        ? "the model became unavailable while the plan was running"
        : modelOutputFailed
          ? "the model returned no usable answer while the plan was running"
          : stoppedBy.length
            ? `${stoppedBy.length} step${stoppedBy.length === 1 ? " was" : "s were"} denied or contradicted`
            : "",
    });
    if (finished.ok) {
      onEvent({ type: "workflow", id: workflowRun.id, state: finished.state });
      finalText +=
        `\n\n⌁ Plan ${workflowRun.id}: ${finished.state === "done" ? "complete" : "stopped"}` +
        ` — ${trace.length} step${trace.length === 1 ? "" : "s"} attempted` +
        `${finished.state === "done" ? ", nothing contradicted." : `; ${finished.workflow.blockedReason}.`}`;
    }
  }

  const sourceBlock = renderSourceBlock(citations);
  if (sourceBlock) finalText += sourceBlock;

  if (sources.items.length) {
    onEvent({
      type: "sources",
      items: sources.items.map((s) => ({ ...s, cited: citations.cited.includes(s.id) })),
    });
  }

  const storedTrace = trace.map(sanitizeTraceEntry);
  appendMessage(sessionId, { role: "assistant", content: finalText, trace: storedTrace, guard: guard.flags, ...((brainFailed || modelOutputFailed) ? { error: brainFailed ? "brain-unreachable" : "model-output-invalid" } : {}) });

  const ms = Date.now() - startedAt;
  markFirstToken();
  record(withStages({
    kind: "turn",
    sessionId,
    channel,
    autonomy,
    provider: activeModel.provider,
    // Which model, not just which vendor: a price table keys on the model, and
    // "we spent tokens on openai" is not a number anyone can act on.
    model: activeModel.model,
    ms,
    firstTextMs,
    mode: social ? "conversation" : "agent",
    rounds,
    tokens,
    tools: storedTrace.length,
    auto: autoRan,
    guardFlags: guard.flags.length,
    error: brainFailed ? "brain-unreachable" : modelOutputFailed ? "model-output-invalid" : null,
  }));

  return {
    text: finalText,
    firstTextMs,
    error: brainFailed ? "brain-unreachable" : modelOutputFailed ? "model-output-invalid" : null,
    trace: storedTrace,
    sessionId,
    guard: guard.flags,
    sources: sources.items.map((s) => ({ ...s, cited: citations.cited.includes(s.id) })),
    ms,
  };
}

/* ──────────────────────────── one-shot helper ──────────────────────────── */

export async function ask(text, { channel = "cli" } = {}) {
  const sessionId = `oneshot-${channel}`;
  const { text: answer } = await runAgent({ sessionId, text, channel });
  return answer;
}

