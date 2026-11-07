/**
 * talk-shape.js — decide whether this utterance needs tools at all.
 *
 * Prefill on a local 7B is dominated by the tool schema (~2k tokens) plus a
 * long system prompt. Greetings already skip that (`isSocialTurn`). Everyday
 * questions — "what is X", "why does Y" — paid the same tax and waited a
 * second for a model that was never going to call `shell`.
 *
 * Asymmetry is the same as the fast path: a false *talk* (skipping tools when
 * the person asked for an action) is the expensive mistake. Anything that
 * smells like memory, files, reminders, search-of-mine, or a compound request
 * stays on the full agent. A miss costs one ordinary tool-capable turn.
 */
import { isSocialTurn } from "../prompt.js";

export const KINDS = Object.freeze(["social", "talk", "act"]);

const MAX_TALK_CHARS = 280;
const MAX_TALK_WORDS = 40;

/** Verbs/nouns that mean "do something on this machine". */
const ACT_RE =
  /\b(remember|remind|reminder|task|todo|delete|remove|trash|move|rename|write|save|create|mkdir|touch|run|exec|shell|install|commit|push|pull|grep|open|send|email|slack|discord|whatsapp|telegram|clipboard|screenshot|schedule|calendar|search my|look in|list dir|read file|edit|refactor|implement|kill switch|approve)\b/i;

/** Closed question/explanation shapes. Not "what files" — that has ACT_RE. */
const TALK_RE =
  /^(?:please\s+)?(?:what(?:'s| is| are| was| were| do| does| did)|why(?: do| does| is| are)?|who(?:'s| is| was| are)|where(?:'s| is| are)(?! my)|when(?: is| was| did)(?! my)|how(?:'s| is| are| do| does| did| come)|explain|tell me(?: about)?|define|meaning of|difference between|compare|opinion on|joke|story about)\b/i;

function tooBig(text) {
  if (text.length > MAX_TALK_CHARS) return true;
  return text.split(/\s+/).length > MAX_TALK_WORDS;
}

/**
 * @returns {{ kind: "social"|"talk"|"act", reason: string }}
 */
export function classifyTalk(text, attachments = []) {
  if (attachments?.length) return { kind: "act", reason: "attachment" };
  const raw = String(text ?? "").trim();
  if (!raw) return { kind: "act", reason: "empty" };
  if (isSocialTurn(raw, attachments)) return { kind: "social", reason: "greeting" };
  if (raw.startsWith("/")) return { kind: "act", reason: "command" };
  if (/[\n\r]/.test(raw) || /;|\band then\b|\balso\b/i.test(raw)) return { kind: "act", reason: "multi" };
  if (ACT_RE.test(raw)) return { kind: "act", reason: "action-verb" };
  if (tooBig(raw)) return { kind: "act", reason: "long" };
  if (TALK_RE.test(raw)) return { kind: "talk", reason: "question" };
  return { kind: "act", reason: "default" };
}

export function isTalkOnly(text, attachments) {
  const kind = classifyTalk(text, attachments).kind;
  return kind === "social" || kind === "talk";
}
