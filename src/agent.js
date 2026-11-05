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
import { buildSystemPrompt, buildConversationPrompt, isSocialTurn, buildPersonaMessage } from "./prompt.js";
import { createSources, addSource, listSources } from "./sources.js";
import { validateCitations, renderSourceBlock } from "./citations.js";
import { classifyCommand, describeTier, detectCommitProposal, READ as TIER_READ, BLOCKED as TIER_BLOCKED } from "./risk.js";
import { POLICY_DECISIONS, resolveHarnessPipeline } from "./harness/events.js";
import { TOOL_MAP, DANGEROUS, toolSchemas, SafePathError, screenCommand } from "./tools.js";
import { loadSession, appendMessage, loadMemory } from "./store.js";
import { auditReply, renderGuardNote } from "./guard.js";
import { addressFor } from "./outbound.js";
import { renderForPrompt } from "./attachments.js";
import { record } from "./telemetry.js";
import { matchFastIntent, composeFastReply, FAST_TOOLS } from "./fast-path.js";
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
  const social = isSocialTurn(text, attachments);
  const activeModel = brain.active; // Pin provider/model for the entire tool loop.
  const unattended = autonomy === "unattended";
  const startedAt = Date.now();
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
  if (config.fastPath && !unattended && !social && !attachments.length && !signal?.aborted) {
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
    if (signal?.aborted) {
      finalText = "Turn cancelled before action execution.";
      break;
    }
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

      const baselineMustAsk = DANGEROUS.has(tool.name) && !config.autoApprove && tier?.tier !== TIER_READ;
      const policyMustAsk =
        policyDecision === POLICY_DECISIONS.ASK ||
        (commitProposal.isCommit && (!config.autoApprove || Boolean(activeHarness)));

      if (tier?.tier === TIER_READ && !policyMustAsk) {
        autoRan += 1;
        onEvent({ type: "auto", name: tool.name, why: describeTier(tier) });
      }

      const mustAsk = baselineMustAsk || policyMustAsk;
      if (mustAsk) {
        const secrets = turnSecrets();
        const preview = buildActionPreview(tool.name, call.arguments, { risk: tier || classifiedShell, secrets });
        const description = approvalDescription(label, secrets);
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
          trace.push({ tool: tool.name, args: call.arguments, denied: true });
          continue;
        }
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

      toolOutputs.push(kept);
      trace.push({
        tool: tool.name,
        args: call.arguments,
        ok: result.ok,
        output: kept.slice(0, 400),
        ...(verification ? { verification } : {}),
        ...(tier?.tier === TIER_READ && !policyMustAsk ? { tier: "read", auto: true } : {}),
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

