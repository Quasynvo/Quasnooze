/**
 * harness/events.js — deterministic in-process action lifecycle policy pipeline.
 *
 * Lifecycle stages:
 *   • beforeTool        — deterministic policy check (may "continue", "ask", or "deny")
 *   • beforeCommit      — structural commit gate (always at least "ask"; "deny" unattended)
 *   • afterTool         — bounded observational post-execution evidence only
 *   • beforeContextTrim — bounded observational pre-compaction count metadata only
 *
 * Security invariants:
 *   1. Built-in & in-process only: no shell hooks, network webhooks, or dynamic
 *      plugin file imports are accepted.
 *   2. One-way monotonic policy lattice (`continue` < `ask` < `deny`): handlers
 *      can restrict or request approval, never authorize, bypass `validateArgs`,
 *      override `BLOCKED` risk tiers, or suppress session user approval.
 *   3. Fail closed: policy handler exceptions, promise rejections, invalid
 *      return shapes, timeouts, and `AbortSignal` cancellations all resolve to
 *      `deny` so the tool never executes.
 *   4. Observational isolation: `afterTool` and `beforeContextTrim` listeners
 *      receive deep-frozen redacted metadata; return values and errors are
 *      discarded and cannot alter actions, tool outputs, or trimmed messages.
 *   5. Redacted & ephemeral by default: no credentials, raw prompts, file
 *      contents, commit messages, or raw tool outputs are carried or persisted.
 */

import { BLOCKED, detectCommitProposal } from "../risk.js";
import { DANGEROUS, TOOLS } from "../tools.js";

export const EVENT_TYPES = Object.freeze({
  BEFORE_TOOL: "beforeTool",
  AFTER_TOOL: "afterTool",
  BEFORE_COMMIT: "beforeCommit",
  BEFORE_CONTEXT_TRIM: "beforeContextTrim",
});

export const POLICY_DECISIONS = Object.freeze({
  CONTINUE: "continue",
  ASK: "ask",
  DENY: "deny",
});

export const HARNESS_LIMITS = Object.freeze({
  maxStringLength: 160,
  maxKeyLength: 64,
  maxArgKeys: 32,
  maxFlags: 16,
  maxEvents: 64,
  defaultTimeoutMs: 250,
  maxTimeoutMs: 2000,
});

export const BUILTIN_POLICY_RULES = Object.freeze({
  "screen-blocked-command": Object.freeze({
    id: "screen-blocked-command",
    stage: EVENT_TYPES.BEFORE_TOOL,
    defaultEnabled: true,
    description: "Denies shell commands flagged as blocked by the catastrophic command screen.",
  }),
  "commit-gate": Object.freeze({
    id: "commit-gate",
    stage: EVENT_TYPES.BEFORE_COMMIT,
    defaultEnabled: true,
    description: "Recognizes commit proposals structurally, requires interactive approval, and refuses unattended commits.",
  }),
  "strict-commit-verify": Object.freeze({
    id: "strict-commit-verify",
    stage: EVENT_TYPES.BEFORE_COMMIT,
    defaultEnabled: false,
    description: "Denies commit proposals that bypass repository verification hooks (--no-verify / -n).",
  }),
  "unattended-ask-guard": Object.freeze({
    id: "unattended-ask-guard",
    stage: EVENT_TYPES.BEFORE_TOOL,
    defaultEnabled: true,
    description: "Fails closed when an unattended turn hits any action requiring interactive approval.",
  }),
});

export class HarnessConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "HarnessConfigError";
  }
}

const BUILTIN_TOOL_NAMES = new Set(TOOLS.map((t) => t.name));
const PIPELINE_BRAND = new WeakSet();

const DECISION_RANK = Object.freeze({
  continue: 0,
  ask: 1,
  deny: 2,
});

const FORBIDDEN_HOOK_KEYS = new Set([
  "command",
  "commands",
  "shell",
  "script",
  "exec",
  "spawn",
  "url",
  "endpoint",
  "webhook",
  "http",
  "plugin",
  "plugins",
  "module",
  "file",
  "path",
  "allow",
  "autoApprove",
  "bypassApproval",
  "skipApproval",
]);

const ALLOWED_PIPELINE_OPTIONS = new Set([
  "enabled",
  "profile",
  "rules",
  "timeoutMs",
  "maxEvents",
  "policyChecks",
  "observers",
]);

const ALLOWED_DECLARATIVE_OPTIONS = new Set([
  "enabled",
  "profile",
  "rules",
  "timeoutMs",
  "maxEvents",
]);

const POLICY_STAGES = new Set([EVENT_TYPES.BEFORE_TOOL, EVENT_TYPES.BEFORE_COMMIT]);
const ALL_STAGES = new Set(Object.values(EVENT_TYPES));

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g;
const SECRET_KEY_RE =
  /(?:^|[_.-])(?:pass(?:word|phrase)?|secret|token|api[_.-]?key|auth(?:[_.-]?(?:key|token|header))?|authorization|bearer|cookie|session(?:[_.-]?(?:id|key|token))?|private[_.-]?key|client[_.-]?secret|webhook|access[_.-]?key|signing[_.-]?key|credentials?|pinch[_.-]?key|quasnooze[_.-]?key)(?:$|[_.-])/i;
const URL_USERINFO_RE = /([A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/)([^\s/@:]{1,128}:[^\s/@]{1,256})@/g;
const URL_QUERY_PARAM_RE = /([?&])([A-Za-z0-9_.-]{1,64})=([^&#\s"']{1,512})/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)([ \t]+)([^\s,;"']+)/gi;
const KEY_ASSIGN_RE =
  /(?<![A-Za-z0-9_.-])(--?[A-Za-z0-9_.-]{1,80}|[A-Za-z_][A-Za-z0-9_.-]{0,79})([ \t]*[=:][ \t]*)(?:"[^"\r\n]{0,512}"|'[^'\r\n]{0,512}'|[^\s,;&"']{1,512})/g;
const CLI_SECRET_FLAG_RE =
  /(?<![A-Za-z0-9_-])(--?[A-Za-z0-9][A-Za-z0-9_-]{0,79})([ \t]+)(?:"[^"\r\n]{0,512}"|'[^'\r\n]{0,512}'|[^\s,;&"'-][^\s,;&"']{0,511})/g;
const KNOWN_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return value;
}

export function collectHarnessSecrets({ env = process.env, extraSecrets = [] } = {}) {
  const out = new Set();
  const add = (val) => {
    if (typeof val !== "string") return;
    const trimmed = val.trim();
    if (trimmed.length >= 4) out.add(trimmed);
  };
  for (const s of extraSecrets) add(s);
  if (env && typeof env === "object") {
    for (const [key, val] of Object.entries(env)) {
      if (SECRET_KEY_RE.test(key)) add(val);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Bound and redact metadata strings so secrets and control characters never
 * enter lifecycle events.
 */
export function redactHarnessText(
  value,
  {
    secrets = [],
    maxLength = HARNESS_LIMITS.maxStringLength,
  } = {},
) {
  let text = String(value ?? "").slice(0, 4096).replace(CONTROL_CHAR_RE, " ").replace(/\s+/g, " ").trim();

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    if (text.includes(secret)) text = text.split(secret).join("[REDACTED]");
    const encoded = encodeURIComponent(secret);
    if (encoded.length >= 4 && encoded !== secret && text.includes(encoded)) {
      text = text.split(encoded).join("[REDACTED]");
    }
  }

  text = text
    .replace(URL_USERINFO_RE, "$1[REDACTED]@")
    .replace(URL_QUERY_PARAM_RE, (whole, sepChar, key) =>
      SECRET_KEY_RE.test(key) ? `${sepChar}${key}=[REDACTED]` : whole,
    )
    .replace(AUTH_SCHEME_RE, "$1$2[REDACTED]")
    .replace(KEY_ASSIGN_RE, (whole, key, sepText) => {
      const bare = key.replace(/^--?/, "");
      return SECRET_KEY_RE.test(bare) ? `${key}${sepText}[REDACTED]` : whole;
    })
    .replace(CLI_SECRET_FLAG_RE, (whole, flag, space) => {
      const bare = flag.replace(/^--?/, "");
      return SECRET_KEY_RE.test(bare) ? `${flag}${space}[REDACTED]` : whole;
    })
    .replace(KNOWN_TOKEN_RE, "[REDACTED]");

  if (Number.isFinite(maxLength) && maxLength > 1 && text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1)}…`;
  }
  return text;
}

function classifyToolSource(tool) {
  if (!tool || typeof tool.name !== "string") return "unknown";
  if (tool.mcp || tool.name.startsWith("mcp__")) return "mcp";
  if (BUILTIN_TOOL_NAMES.has(tool.name)) return "builtin";
  return "external";
}

function extractShellProgram(command) {
  const trimmed = String(command || "").trim();
  if (!trimmed) return "empty";
  const first = trimmed.split(/\s+/)[0] || "";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return "env-assignment";
  const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
  const base = (slash >= 0 ? first.slice(slash + 1) : first).replace(/[^A-Za-z0-9._+-]/g, "");
  return base ? base.slice(0, 48) : "command";
}

/**
 * Summarize tool call arguments into bounded, redacted structural metadata
 * without copying raw prompts, file contents, commit messages, or secret values.
 */
export function summarizeToolArgs(toolName, rawArgs, { secrets = [] } = {}) {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
  const allKeys = Object.keys(args);
  const keys = allKeys
    .slice(0, HARNESS_LIMITS.maxArgKeys)
    .map((k) => redactHarnessText(k, { secrets, maxLength: HARNESS_LIMITS.maxKeyLength }));

  let target = "withheld";
  let contentBytes = null;

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "list_dir":
    case "grep":
    case "scan_project":
    case "search_documents":
    case "screenshot":
      target =
        typeof args.path === "string" && args.path.trim()
          ? redactHarnessText(args.path, { secrets })
          : "default";
      if (toolName === "write_file") {
        contentBytes = Buffer.byteLength(String(args.content ?? ""), "utf8");
      }
      break;
    case "shell": {
      const prog = extractShellProgram(args.command);
      const cwd =
        typeof args.cwd === "string" && args.cwd.trim()
          ? redactHarnessText(args.cwd, { secrets, maxLength: 80 })
          : "workspace";
      target = `${prog}@${cwd}`;
      break;
    }
    case "open_url":
      try {
        const parsed = new URL(String(args.url || ""));
        target = redactHarnessText(`${parsed.origin}${parsed.pathname}`, { secrets });
      } catch {
        target = "invalid-url";
      }
      break;
    case "system_control":
      target = args.action === "lock" || args.action === "sleep" ? args.action : "unknown";
      break;
    default:
      target = "withheld";
      break;
  }

  return deepFreeze({
    keys,
    count: allKeys.length,
    target,
    contentBytes,
    redacted: true,
  });
}

function normalizeCheckList(entries, stage, kind) {
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) {
    throw new HarnessConfigError(`${kind}.${stage} must be an array of in-process functions`);
  }
  return entries.map((item, index) => {
    if (typeof item === "function") {
      return { id: `${kind}-${stage}-${index + 1}`, fn: item };
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      for (const k of Object.keys(item)) {
        if (FORBIDDEN_HOOK_KEYS.has(k)) {
          throw new HarnessConfigError(`External hook key "${k}" is forbidden in ${kind}.${stage}`);
        }
      }
      const fn = kind === "policyChecks" ? item.check : item.observe;
      if (typeof fn === "function") {
        const id =
          typeof item.id === "string" && item.id.trim()
            ? item.id.trim().slice(0, 64)
            : `${kind}-${stage}-${index + 1}`;
        return { id, fn };
      }
    }
    throw new HarnessConfigError(
      `${kind}.${stage}[${index}] must be an in-process function, not an external command or value`,
    );
  });
}

function normalizePolicyResult(raw, { secrets = [] } = {}) {
  if (raw === undefined || raw === null) {
    return { decision: POLICY_DECISIONS.CONTINUE, reason: null, authorizationIgnored: false, invalid: false };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "continue") {
      return { decision: POLICY_DECISIONS.CONTINUE, reason: null, authorizationIgnored: false, invalid: false };
    }
    if (trimmed === "ask" || trimmed === "deny") {
      return { decision: trimmed, reason: null, authorizationIgnored: false, invalid: false };
    }
    if (trimmed === "allow" || trimmed === "grant" || trimmed === "approve") {
      return { decision: POLICY_DECISIONS.CONTINUE, reason: null, authorizationIgnored: true, invalid: false };
    }
    return {
      decision: POLICY_DECISIONS.DENY,
      reason: "invalid-policy-decision",
      authorizationIgnored: false,
      invalid: true,
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      decision: POLICY_DECISIONS.DENY,
      reason: "invalid-policy-decision",
      authorizationIgnored: false,
      invalid: true,
    };
  }

  let authorizationIgnored = false;
  if (
    raw.allow === true ||
    raw.grant === true ||
    raw.authorized === true ||
    raw.autoApprove === true ||
    raw.skipApproval === true ||
    raw.bypassApproval === true
  ) {
    authorizationIgnored = true;
  }

  const reason =
    typeof raw.reason === "string" && raw.reason.trim()
      ? redactHarnessText(raw.reason, { secrets })
      : null;

  if (raw.decision === undefined && authorizationIgnored) {
    return {
      decision: POLICY_DECISIONS.CONTINUE,
      reason: null,
      authorizationIgnored: true,
      invalid: false,
    };
  }

  const rawDecision = typeof raw.decision === "string" ? raw.decision.trim().toLowerCase() : "";
  if (rawDecision === "continue") {
    return { decision: POLICY_DECISIONS.CONTINUE, reason, authorizationIgnored, invalid: false };
  }
  if (rawDecision === "ask" || rawDecision === "deny") {
    return { decision: rawDecision, reason, authorizationIgnored, invalid: false };
  }
  if (rawDecision === "allow" || rawDecision === "grant" || rawDecision === "approve") {
    return { decision: POLICY_DECISIONS.CONTINUE, reason: null, authorizationIgnored: true, invalid: false };
  }

  return {
    decision: POLICY_DECISIONS.DENY,
    reason: "invalid-policy-decision",
    authorizationIgnored,
    invalid: true,
  };
}

async function runBoundedCallback(fn, event, { timeoutMs, signal }) {
  if (signal?.aborted) {
    return { status: "cancelled", value: null };
  }

  let timer = null;
  let onAbort = null;
  try {
    const work = Promise.resolve().then(() => fn(event, { signal }));
    const guards = [
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout", value: null }), timeoutMs);
        timer.unref?.();
      }),
    ];
    if (signal) {
      guards.push(
        new Promise((resolve) => {
          onAbort = () => resolve({ status: "cancelled", value: null });
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      );
    }

    const raced = await Promise.race([
      work.then(
        (value) => ({ status: "ok", value }),
        () => ({ status: "error", value: null }),
      ),
      ...guards,
    ]);
    // Silence late unhandled rejections if a timed-out/cancelled check rejects later.
    work.catch(() => {});
    return raced;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (signal && onAbort) {
      try {
        signal.removeEventListener("abort", onAbort);
      } catch {}
    }
  }
}

export function isHarnessPipeline(value) {
  return Boolean(value && typeof value === "object" && PIPELINE_BRAND.has(value));
}

/**
 * Create an in-process deterministic action lifecycle pipeline.
 */
export function createHarnessPipeline(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new HarnessConfigError("Harness pipeline options must be a plain object");
  }
  for (const key of Object.keys(options)) {
    if (FORBIDDEN_HOOK_KEYS.has(key)) {
      throw new HarnessConfigError(`External shell, network, or plugin hook option "${key}" is forbidden`);
    }
    if (!ALLOWED_PIPELINE_OPTIONS.has(key)) {
      throw new HarnessConfigError(`Unknown harness pipeline option "${key}"`);
    }
  }

  const profile = options.profile ?? "standard";
  if (!["off", "standard", "strict"].includes(profile)) {
    throw new HarnessConfigError(`Invalid harness profile "${String(profile)}" (expected off, standard, or strict)`);
  }

  const enabled = options.enabled !== undefined ? Boolean(options.enabled) && profile !== "off" : profile !== "off";

  const ruleSet = new Set();
  if (options.rules !== undefined) {
    if (!Array.isArray(options.rules)) {
      throw new HarnessConfigError("Harness rules must be an array of built-in rule identifiers");
    }
    for (const ruleId of options.rules) {
      if (typeof ruleId !== "string" || !Object.hasOwn(BUILTIN_POLICY_RULES, ruleId)) {
        throw new HarnessConfigError(`Unknown harness policy rule "${String(ruleId)}"`);
      }
      ruleSet.add(ruleId);
    }
  } else {
    for (const [id, spec] of Object.entries(BUILTIN_POLICY_RULES)) {
      if (spec.defaultEnabled || (profile === "strict" && id === "strict-commit-verify")) {
        ruleSet.add(id);
      }
    }
  }
  // Core safety invariants cannot be turned off when the pipeline is enabled.
  if (enabled) {
    ruleSet.add("screen-blocked-command");
    ruleSet.add("commit-gate");
    ruleSet.add("unattended-ask-guard");
  }

  const rawTimeout = options.timeoutMs ?? HARNESS_LIMITS.defaultTimeoutMs;
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new HarnessConfigError("timeoutMs must be a positive number");
  }
  const timeoutMs = Math.min(Math.max(1, Math.floor(rawTimeout)), HARNESS_LIMITS.maxTimeoutMs);

  const rawMaxEvents = options.maxEvents ?? HARNESS_LIMITS.maxEvents;
  if (!Number.isFinite(rawMaxEvents) || rawMaxEvents < 0) {
    throw new HarnessConfigError("maxEvents must be a non-negative number");
  }
  const maxEvents = Math.min(Math.floor(rawMaxEvents), 256);

  const rawPolicyChecks = options.policyChecks ?? {};
  if (!rawPolicyChecks || typeof rawPolicyChecks !== "object" || Array.isArray(rawPolicyChecks)) {
    throw new HarnessConfigError("policyChecks must be a plain object");
  }
  for (const stage of Object.keys(rawPolicyChecks)) {
    if (!POLICY_STAGES.has(stage)) {
      throw new HarnessConfigError(
        `Policy checks are only supported on beforeTool and beforeCommit (got "${stage}")`,
      );
    }
  }
  const policyChecks = {
    [EVENT_TYPES.BEFORE_TOOL]: normalizeCheckList(
      rawPolicyChecks[EVENT_TYPES.BEFORE_TOOL],
      EVENT_TYPES.BEFORE_TOOL,
      "policyChecks",
    ),
    [EVENT_TYPES.BEFORE_COMMIT]: normalizeCheckList(
      rawPolicyChecks[EVENT_TYPES.BEFORE_COMMIT],
      EVENT_TYPES.BEFORE_COMMIT,
      "policyChecks",
    ),
  };

  const rawObservers = options.observers ?? {};
  if (!rawObservers || typeof rawObservers !== "object" || Array.isArray(rawObservers)) {
    throw new HarnessConfigError("observers must be a plain object");
  }
  for (const stage of Object.keys(rawObservers)) {
    if (!ALL_STAGES.has(stage)) {
      throw new HarnessConfigError(`Unknown observer lifecycle stage "${stage}"`);
    }
  }
  const observers = {
    [EVENT_TYPES.BEFORE_TOOL]: normalizeCheckList(
      rawObservers[EVENT_TYPES.BEFORE_TOOL],
      EVENT_TYPES.BEFORE_TOOL,
      "observers",
    ),
    [EVENT_TYPES.BEFORE_COMMIT]: normalizeCheckList(
      rawObservers[EVENT_TYPES.BEFORE_COMMIT],
      EVENT_TYPES.BEFORE_COMMIT,
      "observers",
    ),
    [EVENT_TYPES.AFTER_TOOL]: normalizeCheckList(
      rawObservers[EVENT_TYPES.AFTER_TOOL],
      EVENT_TYPES.AFTER_TOOL,
      "observers",
    ),
    [EVENT_TYPES.BEFORE_CONTEXT_TRIM]: normalizeCheckList(
      rawObservers[EVENT_TYPES.BEFORE_CONTEXT_TRIM],
      EVENT_TYPES.BEFORE_CONTEXT_TRIM,
      "observers",
    ),
  };

  const ledger = [];
  let seq = 0;

  function recordEvent(event) {
    if (maxEvents === 0) return;
    if (ledger.length >= maxEvents) ledger.shift();
    ledger.push(event);
  }

  async function notifyObservers(stage, event) {
    let observerErrors = 0;
    for (const obs of observers[stage]) {
      const outcome = await runBoundedCallback(obs.fn, event, { timeoutMs, signal: undefined });
      if (outcome.status !== "ok") observerErrors += 1;
    }
    return observerErrors;
  }

  async function evaluatePolicyChecks(stage, event, initial, { signal, secrets }) {
    let decision = initial.decision;
    let reason = initial.reason;
    let cancelled = false;
    let timedOut = false;
    let failedClosed = false;
    let unattendedRefused = initial.reason === "unattended-commit-refused";
    let authorizationAttemptIgnored = false;

    if (signal?.aborted) {
      return {
        decision: POLICY_DECISIONS.DENY,
        reason: "cancelled",
        cancelled: true,
        timedOut: false,
        failedClosed: true,
        unattendedRefused: false,
        authorizationAttemptIgnored: false,
      };
    }

    const escalate = (nextDecision, nextReason) => {
      if (DECISION_RANK[nextDecision] > DECISION_RANK[decision]) {
        decision = nextDecision;
        reason = nextReason || reason;
      } else if (nextDecision === decision && !reason && nextReason) {
        reason = nextReason;
      }
    };

    for (const check of policyChecks[stage]) {
      const res = await runBoundedCallback(check.fn, event, { timeoutMs, signal });
      if (res.status === "cancelled") {
        cancelled = true;
        failedClosed = true;
        escalate(POLICY_DECISIONS.DENY, "cancelled");
        break;
      }
      if (res.status === "timeout") {
        timedOut = true;
        failedClosed = true;
        escalate(POLICY_DECISIONS.DENY, `policy-timeout:${check.id}`);
        break;
      }
      if (res.status === "error") {
        failedClosed = true;
        escalate(POLICY_DECISIONS.DENY, `policy-error:${check.id}`);
        break;
      }

      const normalized = normalizePolicyResult(res.value, { secrets });
      if (normalized.authorizationIgnored) authorizationAttemptIgnored = true;
      if (normalized.invalid) failedClosed = true;
      escalate(normalized.decision, normalized.reason);
      if (decision === POLICY_DECISIONS.DENY) break;
    }

    if (event.autonomy === "unattended" && decision === POLICY_DECISIONS.ASK && ruleSet.has("unattended-ask-guard")) {
      decision = POLICY_DECISIONS.DENY;
      reason = reason || "unattended-approval-unavailable";
      unattendedRefused = true;
    }

    return {
      decision,
      reason,
      cancelled,
      timedOut,
      failedClosed,
      unattendedRefused,
      authorizationAttemptIgnored,
    };
  }

  const pipeline = Object.freeze({
    enabled,
    profile,
    rules: Object.freeze([...ruleSet]),
    timeoutMs,

    async beforeTool(input = {}, { signal, secrets: extraSecrets = [] } = {}) {
      const secrets = collectHarnessSecrets({ extraSecrets });
      const tool = input.tool || { name: String(input.toolName || "unknown") };
      const toolName = redactHarnessText(tool.name || "unknown", { secrets, maxLength: 64 });
      const dangerous = Boolean(DANGEROUS.has(tool.name) || tool.dangerous);
      const commit =
        input.commitProposal ||
        detectCommitProposal(tool.name, input.args, { tool });
      const riskTier = input.risk?.tier || (dangerous ? "act" : "read");
      const riskWhy = input.risk?.why
        ? redactHarnessText(input.risk.why, { secrets })
        : dangerous
          ? "tool requires approval policy evaluation"
          : "non-dangerous tool";

      seq += 1;
      const event = deepFreeze({
        schemaVersion: 1,
        eventId: `hev_${seq}`,
        type: EVENT_TYPES.BEFORE_TOOL,
        timestamp: Date.now(),
        sessionId: redactHarnessText(input.sessionId || "default", { secrets, maxLength: 80 }),
        channel: redactHarnessText(input.channel || "web", { secrets, maxLength: 32 }),
        autonomy: input.autonomy === "unattended" ? "unattended" : "interactive",
        round: Number.isInteger(input.round) && input.round > 0 ? input.round : 1,
        tool: {
          name: toolName,
          dangerous,
          source: classifyToolSource(tool),
        },
        args: summarizeToolArgs(tool.name, input.args, { secrets }),
        risk: {
          tier: riskTier,
          why: riskWhy,
        },
        isCommit: Boolean(commit?.isCommit),
      });

      if (!enabled) {
        return deepFreeze({
          decision: POLICY_DECISIONS.CONTINUE,
          reason: null,
          cancelled: false,
          timedOut: false,
          failedClosed: false,
          authorizationAttemptIgnored: false,
          observerErrors: 0,
          event,
        });
      }

      let initial = { decision: POLICY_DECISIONS.CONTINUE, reason: null };
      if (ruleSet.has("screen-blocked-command") && input.risk?.tier === BLOCKED) {
        initial = { decision: POLICY_DECISIONS.DENY, reason: "blocked-by-command-screen" };
      }

      const evaluated = await evaluatePolicyChecks(EVENT_TYPES.BEFORE_TOOL, event, initial, {
        signal,
        secrets,
      });
      recordEvent(event);
      const observerErrors = await notifyObservers(EVENT_TYPES.BEFORE_TOOL, event);

      return deepFreeze({
        ...evaluated,
        observerErrors,
        event,
      });
    },

    async beforeCommit(input = {}, { signal, secrets: extraSecrets = [] } = {}) {
      const secrets = collectHarnessSecrets({ extraSecrets });
      const tool = input.tool || { name: String(input.toolName || "unknown") };
      const toolName = redactHarnessText(tool.name || "unknown", { secrets, maxLength: 64 });
      const dangerous = Boolean(DANGEROUS.has(tool.name) || tool.dangerous);
      const commit =
        input.commitProposal ||
        detectCommitProposal(tool.name, input.args, { tool });
      const autonomy = input.autonomy === "unattended" ? "unattended" : "interactive";

      seq += 1;
      const event = deepFreeze({
        schemaVersion: 1,
        eventId: `hev_${seq}`,
        type: EVENT_TYPES.BEFORE_COMMIT,
        timestamp: Date.now(),
        sessionId: redactHarnessText(input.sessionId || "default", { secrets, maxLength: 80 }),
        channel: redactHarnessText(input.channel || "web", { secrets, maxLength: 32 }),
        autonomy,
        round: Number.isInteger(input.round) && input.round > 0 ? input.round : 1,
        tool: {
          name: toolName,
          dangerous,
          source: classifyToolSource(tool),
        },
        commit: {
          kind: commit?.kind || "tool-commit",
          vcs: redactHarnessText(commit?.vcs || "vcs", { secrets, maxLength: 24 }),
          subcommand: redactHarnessText(commit?.subcommand || "commit", { secrets, maxLength: 32 }),
          flags: (Array.isArray(commit?.flags) ? commit.flags : [])
            .slice(0, HARNESS_LIMITS.maxFlags)
            .map((f) => redactHarnessText(f, { secrets, maxLength: 32 })),
          bypassesHooks: Boolean(commit?.bypassesHooks),
          amendsHistory: Boolean(commit?.amendsHistory),
        },
        redacted: true,
      });

      // Structural commit proposals are ALWAYS gated: minimum is "ask" interactively, "deny" unattended.
      let initial =
        autonomy === "unattended"
          ? { decision: POLICY_DECISIONS.DENY, reason: "unattended-commit-refused" }
          : { decision: POLICY_DECISIONS.ASK, reason: "commit-proposal-requires-approval" };

      if (ruleSet.has("strict-commit-verify") && commit?.bypassesHooks) {
        initial = { decision: POLICY_DECISIONS.DENY, reason: "commit-hook-bypass-denied" };
      }

      if (!enabled) {
        return deepFreeze({
          decision: initial.decision,
          reason: initial.reason,
          cancelled: false,
          timedOut: false,
          failedClosed: false,
          authorizationAttemptIgnored: false,
          observerErrors: 0,
          event,
        });
      }

      const evaluated = await evaluatePolicyChecks(EVENT_TYPES.BEFORE_COMMIT, event, initial, {
        signal,
        secrets,
      });
      recordEvent(event);
      const observerErrors = await notifyObservers(EVENT_TYPES.BEFORE_COMMIT, event);

      return deepFreeze({
        ...evaluated,
        observerErrors,
        event,
      });
    },

    async afterTool(input = {}, { secrets: extraSecrets = [] } = {}) {
      const secrets = collectHarnessSecrets({ extraSecrets });
      const tool = input.tool || { name: String(input.toolName || "unknown") };
      const toolName = redactHarnessText(tool.name || "unknown", { secrets, maxLength: 64 });
      const dangerous = Boolean(DANGEROUS.has(tool.name) || tool.dangerous);

      seq += 1;
      const event = deepFreeze({
        schemaVersion: 1,
        eventId: `hev_${seq}`,
        type: EVENT_TYPES.AFTER_TOOL,
        timestamp: Date.now(),
        sessionId: redactHarnessText(input.sessionId || "default", { secrets, maxLength: 80 }),
        channel: redactHarnessText(input.channel || "web", { secrets, maxLength: 32 }),
        autonomy: input.autonomy === "unattended" ? "unattended" : "interactive",
        round: Number.isInteger(input.round) && input.round > 0 ? input.round : 1,
        tool: {
          name: toolName,
          dangerous,
          source: classifyToolSource(tool),
        },
        ok: Boolean(input.ok),
        denied: Boolean(input.denied),
        cancelled: Boolean(input.cancelled),
        status: redactHarnessText(input.status || (input.ok ? "ok" : "error"), { secrets, maxLength: 32 }),
        durationMs: Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs) : 0,
        outputBytes: Number.isFinite(input.outputBytes) && input.outputBytes >= 0 ? Math.round(input.outputBytes) : 0,
        verificationStatus:
          typeof input.verificationStatus === "string"
            ? redactHarnessText(input.verificationStatus, { secrets, maxLength: 32 })
            : null,
        outputWithheld: true,
        redacted: true,
      });

      if (!enabled) return deepFreeze({ event, observerErrors: 0 });
      recordEvent(event);
      const observerErrors = await notifyObservers(EVENT_TYPES.AFTER_TOOL, event);
      return deepFreeze({ event, observerErrors });
    },

    async beforeContextTrim(input = {}, { secrets: extraSecrets = [] } = {}) {
      const secrets = collectHarnessSecrets({ extraSecrets });
      seq += 1;
      const clampCount = (n) => (Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
      const event = deepFreeze({
        schemaVersion: 1,
        eventId: `hev_${seq}`,
        type: EVENT_TYPES.BEFORE_CONTEXT_TRIM,
        timestamp: Date.now(),
        sessionId: redactHarnessText(input.sessionId || "default", { secrets, maxLength: 80 }),
        channel: redactHarnessText(input.channel || "web", { secrets, maxLength: 32 }),
        autonomy: input.autonomy === "unattended" ? "unattended" : "interactive",
        round: Number.isInteger(input.round) && input.round > 0 ? input.round : 1,
        totalMessages: clampCount(input.totalMessages),
        keptMessages: clampCount(input.keptMessages),
        droppedMessages: clampCount(input.droppedMessages),
        estimatedTokens: clampCount(input.estimatedTokens),
        numCtx: clampCount(input.numCtx),
        numPredict: clampCount(input.numPredict),
        promptsWithheld: true,
        redacted: true,
      });

      if (!enabled) return deepFreeze({ event, observerErrors: 0 });
      recordEvent(event);
      const observerErrors = await notifyObservers(EVENT_TYPES.BEFORE_CONTEXT_TRIM, event);
      return deepFreeze({ event, observerErrors });
    },

    events() {
      return Object.freeze([...ledger]);
    },

    clearEvents() {
      ledger.length = 0;
    },
  });

  PIPELINE_BRAND.add(pipeline);
  return pipeline;
}

/**
 * Resolve the active harness pipeline for an agent turn.
 *
 * Returns `null` when disabled (preserving legacy unconfigured turn behavior).
 * Rejects arbitrary unbranded callback objects or external hook specs.
 */
export function resolveHarnessPipeline(harnessOption, configMode = "off") {
  if (harnessOption === false || harnessOption === null) return null;

  if (harnessOption !== undefined) {
    if (harnessOption === true) {
      return createHarnessPipeline({ enabled: true, profile: "standard" });
    }
    if (isHarnessPipeline(harnessOption)) {
      return harnessOption.enabled ? harnessOption : null;
    }
    if (typeof harnessOption === "object" && !Array.isArray(harnessOption)) {
      for (const key of Object.keys(harnessOption)) {
        if (!ALLOWED_DECLARATIVE_OPTIONS.has(key)) {
          throw new HarnessConfigError(
            `Arbitrary callback or external hook property "${key}" is not accepted on runAgent; use createHarnessPipeline with built-in rules`,
          );
        }
      }
      const built = createHarnessPipeline(harnessOption);
      return built.enabled ? built : null;
    }
    throw new HarnessConfigError("Invalid harness configuration passed to runAgent");
  }

  const mode = String(configMode || "off").trim().toLowerCase();
  if (!mode || mode === "off" || mode === "false" || mode === "0" || mode === "no") {
    return null;
  }
  if (mode === "on" || mode === "true" || mode === "1" || mode === "yes" || mode === "standard") {
    return createHarnessPipeline({ enabled: true, profile: "standard" });
  }
  if (mode === "strict") {
    return createHarnessPipeline({ enabled: true, profile: "strict" });
  }
  throw new HarnessConfigError(`Invalid QUASNOOZE_HARNESS_EVENTS mode "${mode}" (expected off, standard, or strict)`);
}
