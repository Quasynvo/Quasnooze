/**
 * guard.js — honesty checks that run *in code*, after the model has spoken.
 *
 * Borrowed idea, taken seriously: a small local model will sometimes claim it
 * did something it did not do ("I've sent the email", "I remember you work at
 * X"), or invent an address that nobody mentioned. Prompting alone does not
 * stop that. This module audits the final reply against the evidence of the
 * turn — the tool calls that actually ran, their real output, and the facts in
 * memory — and returns flags the caller must show the user.
 *
 * It never rewrites the model's words. It appends a check line, because a
 * silent correction is just another way of lying to the user about what
 * happened.
 */

import { citedIds as extractCitedIds } from "./citations.js";

/** Verbs that assert a completed action, split by what kind of evidence they need. */
const ACTION_CLAIMS = [
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:sent|emailed|posted|submitted)\b/i, needs: ["shell"], allowMcp: true },
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:opened|launched|started)\b/i, needs: ["shell", "open_url", "launch_app"] },
  { re: /\b(?:i(?:'ve| have)?\s+)?copied\b[^.?!\n]{0,50}\bclipboard\b/i, needs: ["write_clipboard", "shell"] },
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:created|added|wrote|written|saved|edited|updated|deleted|removed|renamed|moved|trashed|restored)\b/i, needs: ["shell", "write_file", "add_task", "complete_task", "move_path", "rename_path", "trash_path", "undo_last"], clipboardWriteVerbs: /^(?:i(?:'ve| have)?\s+)?(?:wrote|written|updated)$/i },
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:ran|executed|installed|built|tested|deployed|committed|pushed)\b/i, needs: ["shell"] },
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:scheduled|set(?: up)? (?:a )?(?:reminder|timer))\b/i, needs: ["remind"] },
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:screenshot|screenshot taken|locked|slept)\b/i, needs: ["screenshot", "system_control"] },
  { re: /\b(?:i(?:'ve| have)?\s+)?(?:muted|unmuted|turned (?:up|down) the volume|set the volume)\b/i, needs: ["system_control"] },
];

/** Operational metadata fields permitted in telemetry.ndjson — never clipboard, prompt, reply or tool text. */
const TELEMETRY_ALLOWED_KEYS = new Set([
  "at",
  "kind",
  "sessionId",
  "channel",
  "autonomy",
  "provider",
  "model",
  "ms",
  "firstTextMs",
  "mode",
  "rounds",
  "tokens",
  "tools",
  "auto",
  "guardFlags",
  "error",
  "stages",
]);

/**
 * True only when the user's own request explicitly asks to store something in
 * durable memory, and does not negate it ("don't remember", "never remember").
 */
export function userAskedToRemember(userText = "") {
  const text = String(userText ?? "");
  if (!text.trim()) return false;
  if (
    /\b(?:do\s+not|don'?t|never|without)\s+(?:remember(?:ing)?|memori[sz](?:e|ing)|sav(?:e|ing)\s+(?:it\s+|this\s+|that\s+)?(?:to|in|into)\s+(?:your\s+)?memory|stor(?:e|ing)\s+(?:it\s+|this\s+|that\s+)?(?:to|in|into)\s+(?:your\s+)?memory)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  return /\b(?:remember\b|memori[sz]e\b|don'?t\s+forget\b|(?:save|store|keep|add|record)\b[^.?!\n]{0,60}\b(?:to|in|into)\s+(?:your\s+)?memory\b)/i.test(
    text,
  );
}

/**
 * Enforce that clipboard content is never stored as durable memory unless the
 * user explicitly asked to remember it.
 */
export function guardClipboardMemory({ fact = "", userText = "", clipboardTouched = false, clipboardTexts = [] } = {}) {
  if (userAskedToRemember(userText)) return { allowed: true, reason: null };
  if (clipboardTouched) {
    return {
      allowed: false,
      reason: "Clipboard content is never stored as memory unless you explicitly ask to remember it.",
    };
  }
  const cleanFact = String(fact ?? "").trim().toLowerCase();
  if (!cleanFact || !Array.isArray(clipboardTexts) || !clipboardTexts.length) {
    return { allowed: true, reason: null };
  }
  const factToks = tokens(cleanFact);
  for (const rawClip of clipboardTexts) {
    const cleanClip = String(rawClip ?? "").trim().toLowerCase();
    if (!cleanClip) continue;
    if (
      (cleanFact.length >= 8 && cleanClip.includes(cleanFact)) ||
      (cleanClip.length >= 8 && cleanFact.includes(cleanClip)) ||
      (factToks.size >= 2 && overlap(factToks, tokens(cleanClip)) >= 2)
    ) {
      return {
        allowed: false,
        reason: "Clipboard content is never stored as memory unless you explicitly ask to remember it.",
      };
    }
  }
  return { allowed: true, reason: null };
}

/**
 * Strip any clipboard, prompt, tool-argument, tool-output or unknown payload
 * fields before an event reaches telemetry.ndjson or the in-memory ring.
 */
export function sanitizeTelemetryEvent(event = {}) {
  const src = event && typeof event === "object" && !Array.isArray(event) ? event : {};
  const out = {};
  for (const key of Object.keys(src)) {
    if (TELEMETRY_ALLOWED_KEYS.has(key)) out[key] = src[key];
  }
  return out;
}

/**
 * Scrub persisted session trace entries so raw clipboard reads and
 * write_clipboard payloads do not accumulate in data/sessions/*.json traces.
 */
export function sanitizeTraceEntry(entry = {}) {
  if (!entry || typeof entry !== "object") return entry;
  const copy = { ...entry };
  const summary = typeof copy.traceSummary === "string" ? copy.traceSummary : null;
  delete copy.traceSummary;
  if (copy.tool === "read_clipboard") {
    if ("args" in copy) copy.args = {};
    if ("output" in copy) copy.output = summary || "[clipboard read; content omitted from trace]";
  } else if (copy.tool === "write_clipboard") {
    if ("args" in copy) {
      const bytes = typeof copy.args?.text === "string" ? Buffer.byteLength(copy.args.text, "utf8") : 0;
      copy.args = { bytes };
    }
    if ("output" in copy && summary) copy.output = summary;
  } else if (copy.tool === "remember" && summary === "[clipboard memory refused]") {
    if ("args" in copy) copy.args = { redacted: "clipboard-memory-refused" };
    if ("output" in copy) copy.output = summary;
  }
  return copy;
}

/** Phrases that assert knowledge of the user, which must exist in memory. */
const MEMORY_CLAIMS = /\b(i remember|you told me|you mentioned|as you said|you said earlier|per your profile|you prefer)\b/i;

const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/g;

const STOPWORDS = new Set(
  "the a an and or but if then that this these those i you your my me it is are was were be been to of in on at for with about from as by not no yes do does did have has had".split(
    " "
  )
);

function tokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  );
}

function overlap(a, b) {
  let n = 0;
  for (const token of a) if (b.has(token)) n++;
  return n;
}

/**
 * @param {object} input
 * @param {string} input.reply          what the model said
 * @param {Array}  input.trace          tool calls that actually ran this turn
 * @param {Array}  input.memoryFacts    [{text}] from store
 * @param {string} input.userText       what the user said
 * @param {string} [input.toolOutput]   concatenated tool output (evidence)
 * @param {Array}  [input.sources]      what this turn retrieved (sources.js)
 * @param {Array}  [input.citedIds]     citation numbers that resolved to a source
 * @returns {{flags: Array<{code: string, message: string}>, clean: boolean}}
 */
export function auditReply({ reply, trace = [], memoryFacts = [], userText = "", toolOutput = "", sources = [], citedIds = [] }) {
  const flags = [];
  const said = String(reply || "");
  if (!said.trim()) return { flags, clean: true };

  const succeeded = new Set(
    (trace || [])
      .filter((t) => t && t.ok && !t.denied && t.verification?.status !== "contradicted")
      .map((t) => t.tool)
  );
  const denied = (trace || []).filter((t) => t && t.denied);
  const contradicted = (trace || []).filter((t) => t && t.verification?.status === "contradicted");

  // 1) Claimed an action with no tool that could have performed it.
  for (const claim of ACTION_CLAIMS) {
    const match = claim.re.exec(said);
    if (!match) continue;
    const clipboardExcused =
      claim.clipboardWriteVerbs &&
      claim.clipboardWriteVerbs.test(match[0]) &&
      succeeded.has("write_clipboard") &&
      /\bclipboard\b/i.test(said);
    if (
      clipboardExcused ||
      claim.needs.some((tool) => succeeded.has(tool)) ||
      (claim.allowMcp && [...succeeded].some((tool) => String(tool).startsWith("mcp__")))
    ) {
      continue;
    }
    const verb = match[0].toLowerCase().replace(/^i\s+(have\s+|'ve\s+)?/, "");
    const blocked = denied.length
      ? " (you denied a permission prompt this turn)"
      : contradicted.length
        ? " (an independent read-back contradicted the tool's report)"
        : "";
    flags.push({
      code: "action-without-evidence",
      message: `the reply says "${verb}" but no tool ran that could have done it${blocked}`,
    });
    break; // one of these is enough noise for one turn
  }

  // 2) Email addresses nobody gave it.
  const evidence = `${userText}\n${toolOutput}`.toLowerCase();
  const inventedEmails = [...new Set(said.match(EMAIL_RE) || [])].filter(
    (addr) => !evidence.includes(addr.toLowerCase())
  );
  if (inventedEmails.length) {
    flags.push({
      code: "invented-email",
      message:
        inventedEmails.length === 1
          ? `an address appears that was never given to me: ${inventedEmails[0]}`
          : `addresses appear that were never given to me: ${inventedEmails.slice(0, 3).join(", ")}`,
    });
  }

  // 3) URLs nobody gave it and no tool fetched.
  const inventedUrls = [...new Set(said.match(URL_RE) || [])].filter((url) => {
    const withoutScheme = url.toLowerCase().replace(/^https?:\/\//, "");
    let end = withoutScheme.length;
    while (end > 0 && (withoutScheme[end - 1] === "." || withoutScheme[end - 1] === "," || withoutScheme[end - 1] === ")")) {
      end -= 1;
    }
    const bare = withoutScheme.slice(0, end);
    return !evidence.includes(bare) && !(toolOutput || "").toLowerCase().includes(bare);
  });
  if (inventedUrls.length) {
    flags.push({
      code: "unverified-link",
      message: `${inventedUrls.length === 1 ? "a link is" : "links are"} not backed by any tool output this turn`,
    });
  }

  // 4) Claims about the user that memory does not hold.
  if (MEMORY_CLAIMS.test(said)) {
    const replyTokens = tokens(said);
    const factTokens = new Set();
    for (const fact of memoryFacts || []) for (const t of tokens(fact.text)) factTokens.add(t);
    const grounded = memoryFacts?.length && overlap(replyTokens, factTokens) >= 2;
    if (!grounded) {
      flags.push({
        code: "memory-without-grounding",
        message:
          "the reply invokes my memory of you, but nothing in memory matches it" +
          (memoryFacts?.length ? "" : " (memory is empty)"),
      });
    }
  }

  // 5) A citation that names something this turn never retrieved.
  //
  // This is the failure mode citations are supposed to remove, so it is the one
  // place where a footnote makes an answer worse than none: "[3]" reads as
  // evidence and there is nothing behind it. Checked against the registry of
  // what was actually fetched, not against the reply's own list.
  const known = new Set((sources || []).map((s) => s.id));
  for (const n of extractCitedIds(said)) {
    if (!known.has(n)) {
      flags.push({
        code: "invented-citation",
        message: `the reply cites [${n}], but this turn retrieved ${known.size || "no"} source${known.size === 1 ? "" : "s"}`,
      });
      break;
    }
  }

  // 6) A denial that the reply quietly glossed over as success.
  if (denied.length && !/\b(denied|not allowed|cancell?ed|blocked|didn't|did not|refused)\b/i.test(said)) {
    flags.push({
      code: "denial-not-reported",
      message: "a permission prompt was denied, but the reply does not say so",
    });
  }

  // 7) Clipboard content stored in durable memory without the user asking.
  const clipboardRan = (trace || []).some(
    (t) => t && (t.tool === "read_clipboard" || t.tool === "write_clipboard") && t.ok && !t.denied,
  );
  if (clipboardRan && succeeded.has("remember") && !userAskedToRemember(userText)) {
    flags.push({
      code: "clipboard-memory-unrequested",
      message: "clipboard content was saved to memory even though you did not ask to remember it",
    });
  }

  return { flags, clean: flags.length === 0 };
}

/** One-line footer for the user. Deliberately calm — a flag is a nudge, not an alarm. */
export function renderGuardNote(flags) {
  if (!flags.length) return "";
  const lines = flags.map((f) => `  • ${f.message}`);
  return (
    `\n\n---\n🛡️ **Code check:** the reply above needs a second look.\n` +
    lines.join("\n") +
    `\n_Quasnooze checks claims against what actually ran — this one did not line up._`
  );
}
