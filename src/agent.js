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
import { classifyCommand, describeTier, READ as TIER_READ, BLOCKED as TIER_BLOCKED } from "./risk.js";
import { TOOL_MAP, DANGEROUS, toolSchemas, SafePathError, screenCommand } from "./tools.js";
import { loadSession, appendMessage, loadMemory } from "./store.js";
import { auditReply, renderGuardNote } from "./guard.js";
import { addressFor } from "./outbound.js";
import { renderForPrompt } from "./attachments.js";
import { record } from "./telemetry.js";
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
}) {
  if (autonomy === "unattended" && /^\/persona(?:\s|$)/i.test(String(text).trim())) {
    return {text:"Persona commands require an interactive user; no persona settings were changed.",sessionId,trace:[],guard:[],sources:[],ms:0,firstTextMs:null,error:null};
  }
  const command = attachments.length ? null : personaCommand(text, sessionId);
  if (command !== null) return {text:command,sessionId,trace:[],guard:[],sources:[],ms:0,firstTextMs:null,error:null};
  const activeModel = brain.active; // Pin provider/model for the entire tool loop.
  const startedAt = Date.now();
  const unattended = autonomy === "unattended";
  const simpleTurn = (reply) => ({
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
  if (config.fastPath && !unattended && !social && !attachments.length && !workflowRun) {
    const fast = matchFastIntent(text);
    const tool = fast ? TOOL_MAP.get(fast.name) : null;
    if (tool && FAST_TOOLS.has(fast.name) && !DANGEROUS.has(fast.name) && !validateArgs(tool, fast.args)) {
      let fastResult;
      try {
        fastResult = await tool.run(fast.args, {
          channel,
          target: addressFor(channel, target),
          sessionId,
          sources: createSources(),
        });
      } catch (err) {
        fastResult = { ok: false, output: err instanceof SafePathError ? err.message : `Tool ${fast.name} threw: ${err.message}` };
      }
      const fastVerification = await verifyAction(fast.name, fast.args, { sessionId, channel }, fastResult);
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
        record({
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
        });
        onEvent({ type: "tool_done", name: fast.name, ok: true, preview: String(fastResult.output).slice(0, 300) });
        return { text: reply, firstTextMs: fastMs, error: null, trace: fastTrace, sessionId, guard: fastGuard.flags, sources: [], ms: fastMs };
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
  const ctx = { channel, target: addressFor(channel, target), sessionId, sources };

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    onEvent({ type: "status", message: round === 0 ? "thinking" : "thinking again" });

    let out;
    let streamed = "";
    try {
      // Stream the model's words straight to whoever is waiting. Tool rounds
      // usually produce no text, so this costs nothing when it does not apply.
      out = await brain.chat(messages, {
        selection: activeModel,
        tools: social ? [] : toolSchemas(),
        ...(social ? {maxTokens:128,think:false} : {}),
        onDelta: (chunk) => {
          if (firstTextMs === null) firstTextMs = Date.now() - startedAt;
          streamed += chunk;
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

      // A call the model malformed is not the human's decision to make, so it
      // is answered before the approval gate — and before the tool runs.
      const invalid = call.parseError
        ? `Your arguments were not valid JSON (${call.parseError}). Re-emit ${call.name} with valid JSON.`
        : validateArgs(tool, call.arguments);
      if (invalid) {
        messages.push({ role: "tool", name: call.name, toolCallId: call.id, content: invalid });
        trace.push({ tool: tool.name, args: call.arguments, ok: false, invalid: true });
        onEvent({ type: "tool_done", name: tool.name, ok: false, preview: invalid.slice(0, 200) });
        continue;
      }

      // A scheduled run has no human to ask, so the approval gate cannot apply.
      // The tool is refused — not auto-approved, which would make a schedule a
      // way to launder an approval, and not queued for later, which would make
      // it a way to ambush the user with a prompt they never saw raised.
      if (unattended && (DANGEROUS.has(tool.name) || (tool.name === "schedule" && !allowSchedule))) {
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

      // Risk tiers. A shell command proven read-only, inside the workspace, does
      // not cost a human's attention — these are things read_file, list_dir and
      // grep already do unprompted. Everything else asks, exactly as before.
      // Unattended turns never reach here: they refuse all of DANGEROUS above.
      let tier = null;
      if (config.riskTiers && !config.autoApprove && tool.name === "shell" && !unattended) {
        tier = classifyCommand(call.arguments?.command, {
          workspaceRoots: config.workspaceRoots,
          cwd: call.arguments?.cwd,
        });

        if (tier.tier === TIER_BLOCKED) {
          messages.push({
            role: "tool", name: call.name, toolCallId: call.id,
            content: `Refused: ${tier.why}. This command is not runnable at all, with or without approval.`,
          });
          trace.push({ tool: tool.name, args: call.arguments, ok: false, denied: true, reason: "screen", tier: "blocked" });
          onEvent({ type: "tool_done", name: tool.name, ok: false, preview: `refused: ${tier.why}` });
          continue;
        }

        if (tier.tier === TIER_READ) {
          autoRan += 1;
          onEvent({ type: "auto", name: tool.name, why: describeTier(tier) });
        }
      }

      const mustAsk = DANGEROUS.has(tool.name) && !config.autoApprove && tier?.tier !== TIER_READ;
      if (mustAsk) {
        const secrets = [...previewSecrets(), config.authKey, config.llm.openaiKey, config.telegram.token, config.discord.token, config.slack.token];
        const preview = buildActionPreview(tool.name, call.arguments, { risk: tier, secrets });
        const description = approvalDescription(label, secrets);
        const { id, promise } = createApproval({ channel, sessionId, description, preview });
        onEvent({ type: "approval", id, description, preview });
        const allowed = await promise;
        if (!allowed) {
          messages.push({
            role: "tool", name: call.name, toolCallId: call.id,
            content: "The user denied permission for this action. Do not retry it; ask what they would prefer.",
          });
          trace.push({ tool: tool.name, args: call.arguments, denied: true });
          continue;
        }
      }

      onEvent({ type: "tool", name: tool.name, label });
      let result;
      try {
        // Let evidence-producing tools avoid registering passages the model
        // cannot see because the remaining tool-output budget is exhausted.
        ctx.toolOutputLimit = Math.min(12_000, Math.max(0, toolBudget));
        result = await tool.run(call.arguments || {}, ctx);
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
      const room = Math.max(0, toolBudget);
      const kept = raw.slice(0, Math.min(12_000, room));
      toolBudget -= kept.length;
      const content = kept.length < raw.length
        ? `${kept}\n\n[output truncated — ${raw.length - kept.length} characters not shown; the per-turn tool output budget is ${TOOL_OUTPUT_BUDGET} characters]`
        : kept;

      toolOutputs.push(kept);
      trace.push({
        tool: tool.name,
        args: call.arguments,
        ok: result.ok,
        output: kept.slice(0, 400),
        ...(verification ? { verification } : {}),
        ...(tier?.tier === TIER_READ ? { tier: "read", auto: true } : {}),
      });
      onEvent({ type: "tool_done", name: tool.name, ok: result.ok, preview: kept.slice(0, 300) });

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

  appendMessage(sessionId, { role: "assistant", content: finalText, trace, guard: guard.flags, ...((brainFailed || modelOutputFailed) ? { error: brainFailed ? "brain-unreachable" : "model-output-invalid" } : {}) });

  const ms = Date.now() - startedAt;
  record({
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
    tools: trace.length,
    auto: autoRan,
    guardFlags: guard.flags.length,
    error: brainFailed ? "brain-unreachable" : modelOutputFailed ? "model-output-invalid" : null,
  });

  return {
    text: finalText,
    firstTextMs,
    error: brainFailed ? "brain-unreachable" : modelOutputFailed ? "model-output-invalid" : null,
    trace,
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

