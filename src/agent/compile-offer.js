/**
 * src/agent/compile-offer.js — the in-chat compile offer (issue #207, item 1).
 *
 * After a successful multi-step turn, the agent offers to save how it did the
 * work as a skill. The offer is one sentence and one data field — it is not
 * authority: nothing compiles until the owner types `/compile <name>`, and
 * what compiles is saved *unapproved* through the skills registry, to be
 * reviewed and approved like anything else. This module can compile and save.
 * It cannot approve a skill and it cannot run one — those doors are not open
 * from here.
 *
 * Everything is deterministic and zero-model: the offer is decided from the
 * turn's recorded tool outcomes, and `/compile` reads the recorded turn out of
 * the session store. Compilation goes through the same compiler as
 * `src/skills/compiler.js`: only successful, uncontradicted work compiles,
 * arguments are taken byte-for-byte from the recording, and the manifest
 * schema carries no permission fields.
 */
import { compileSkill } from "../skills/compiler.js";
import { saveSkill, loadSkill } from "../skills/registry.js";
import { NAME_PATTERN, SkillError } from "../skills/manifest.js";
import { loadSession } from "../store.js";

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "please", "then", "into", "from", "your", "my"]);

/** A deterministic, owner-editable suggestion: up to three words, dashed. */
export function suggestSkillName(utterance = "") {
  const words = String(utterance)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const name = words.slice(0, 3).join("-");
  return NAME_PATTERN.test(name) ? name : "saved-turn";
}

/** A recorded trace entry becomes the compiler's call shape. */
function toCall(entry) {
  return {
    tool: String(entry?.tool ?? ""),
    args: entry?.args ?? {},
    result: { ok: entry?.ok === true },
    ...(entry?.verification ? { verification: entry.verification } : {}),
    ...(entry?.denied ? { denied: true } : {}),
  };
}

/**
 * Decide whether this turn earns an offer. The rule is honest: only offer what
 * this same compiler would accept, by asking it first (it is pure — a dry run
 * builds and discards a manifest). Redacted arguments, failed or contradicted
 * steps, single calls — no offer.
 */
export function offerForTurn({ trace = [], utterance = "", autonomy = "interactive" } = {}) {
  if (autonomy !== "interactive") return null;
  const calls = trace.map(toCall);
  if (calls.length < 2) return null;
  try {
    compileSkill({ name: "compile-offer-check", utterance, calls });
  } catch {
    return null;
  }
  return { suggestedName: suggestSkillName(utterance), steps: calls.length };
}

/** The one sentence the owner sees. The offer never claims more than this. */
export function compileOfferLine(offer) {
  return (
    `\n\n✦ That took ${offer.steps} steps — say \`/compile ${offer.suggestedName}\` ` +
    `and I'll save how I did it as a skill for you to review and approve.`
  );
}

/**
 * `/compile [<name>]` → `{ name }` (name may be null = usage), or null when
 * the text is not this command.
 */
export function parseCompileCommand(text) {
  const m = /^\s*\/compile\b([\s\S]*)$/i.exec(String(text ?? ""));
  if (!m) return null;
  return { name: m[1].trim() || null };
}

function utteranceBefore(messages, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return String(messages[i].content ?? "");
  }
  return "";
}

/**
 * Compile the newest compilable multi-step turn in this session and save it
 * unapproved. Returns `{ ok, manifest, steps, used }` or `{ ok: false, reason }`.
 * The newest turn that cannot compile is not silently skipped past: if an
 * older turn is what compiles, the reply names it, so the owner knows exactly
 * what was saved.
 */
export function compileFromSession({ sessionId, name }) {
  if (!NAME_PATTERN.test(String(name ?? ""))) {
    return {
      ok: false,
      reason: `skill names match ${NAME_PATTERN} (lowercase letters, digits and dashes), found ${JSON.stringify(String(name ?? ""))}. Nothing was saved.`,
    };
  }
  let taken = true;
  try {
    loadSkill(name);
  } catch {
    taken = false;
  }
  if (taken) return { ok: false, reason: `a skill named ${JSON.stringify(name)} already exists — choose another name.` };

  const session = loadSession(sessionId);
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  let newestReason = "this session has no multi-step tool turn to compile — I only offer after work that ran and checked out.";

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant" || !Array.isArray(m.trace) || m.trace.length < 2) continue;
    const calls = m.trace.map(toCall);
    try {
      const manifest = compileSkill({
        name,
        description: `compiled from a ${calls.length}-step turn`,
        utterance: utteranceBefore(messages, i),
        calls,
      });
      saveSkill(manifest);
      return { ok: true, manifest, steps: calls.length, used: [...new Set(calls.map((c) => c.tool))] };
    } catch (err) {
      // Record why the newest turn does not compile; keep looking for an
      // older offered turn, but never save something the compiler refused.
      newestReason = err instanceof SkillError ? err.message : String(err?.message ?? err);
    }
  }
  return { ok: false, reason: newestReason };
}
