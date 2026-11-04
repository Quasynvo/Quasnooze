/**
 * fast-path.js — the turns that never needed a model.
 *
 * "What time is it", "remind me to call mom in 20 minutes", "add a task to
 * renew the passport": these have one correct reading and one correct tool.
 * Sending them through a language model costs a prefill and a decode — on a
 * local 7B that is the better part of a second, and on a bad day it is a
 * hallucinated time.
 *
 * The rule that makes this safe to leave on is asymmetry: a miss costs one
 * ordinary model turn, a false match performs an action the user did not ask
 * for. So the matcher only fires on a closed set of sentence shapes, refuses
 * anything it is not sure about, and every refusal falls through to the model
 * untouched rather than to an apology.
 *
 * What this is not: a second intent system with its own opinions about the
 * world. It returns `{ name, args }` for a tool that already exists, runs the
 * same permission classification as the model path, and composes its reply from
 * the tool's own output so nothing is paraphrased and nothing is invented.
 */

/** Tools this module is allowed to reach. Anything else is a bug, not a config. */
export const FAST_TOOLS = new Set([
  "time_now",
  "calculator",
  "remember",
  "add_task",
  "remind",
]);

/** A fast turn is one clause, not an essay. */
export const MAX_WORDS = 20;
export const MAX_CHARS = 160;

const normalize = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!]+$/, "")
    .trim();

/**
 * Why a candidate was rejected. Kept for telemetry and for the evaluation
 * script, which reports fall-through counts by reason rather than one number.
 */
export const REJECT = {
  EMPTY: "empty",
  TOO_LONG: "too long",
  MULTI_CLAUSE: "multi-clause",
  SLASH: "slash-command",
  NO_MATCH: "no pattern",
};

/**
 * Sentence-level disqualifiers. Each one is a shape where the model path is
 * genuinely better: a compound request, a quoted command, a follow-up that
 * needs the previous turn.
 */
function disqualify(text) {
  if (!text) return REJECT.EMPTY;
  if (text.length > MAX_CHARS) return REJECT.TOO_LONG;
  if (text.split(/\s+/).length > MAX_WORDS) return REJECT.TOO_LONG;
  if (/[\n\r]/.test(text)) return REJECT.MULTI_CLAUSE;
  // A second sentence means a second request; the model decides how they relate.
  if (/[.?!]\s+\S/.test(text)) return REJECT.MULTI_CLAUSE;
  // "X and then Y" is a plan. Plans are the agent's job, not a regex's.
  if (/\b(?:and then|then also|after that|also add|plus also)\b/i.test(text)) return REJECT.MULTI_CLAUSE;
  // Slash commands are handled before the model; never shadow them.
  if (text.startsWith("/")) return REJECT.SLASH;
  return null;
}

const TIME_FORMS = [
  /^what(?:'s| is)? the time(?: right now| now)?$/i,
  /^what time is it(?: right now)?$/i,
  /^what(?:'s| is)? the date(?: today)?$/i,
  /^what(?:'s| is)? today'?s date$/i,
  /^what day is it(?: today)?$/i,
  /^current (?:time|date)$/i,
];

const PERCENT_OF = /^(?:what(?:'s| is)\s+)?(\d+(?:\.\d+)?)\s*(?:%|percent)\s+of\s+(\d+(?:\.\d+)?)$/i;
const ARITHMETIC = /^(?:calculate|compute|what(?:'s| is)|how much is)\s+([\d(][\d\s+\-*/^%().]*)$/i;
const REMEMBER = /^(?:remember(?: that)?|note that|make a note that|keep in mind that)\s+(.{3,200})$/i;
const ADD_TASK = /^(?:add (?:a )?task(?: to)?|add to (?:my )?(?:task list|to-?do list)|new task)\s*[:,\-]?\s+(.{3,200})$/i;
const REMIND = /^remind me (?:to|about)\s+(.{2,140}?)\s+(in\s+\d+\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|tomorrow(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|tonight|today\s+at\s+\S+|on\s+\d{4}-\d{2}-\d{2}(?:\s+\S+)?)$/i;

/**
 * @param {string} text the user's message
 * @param {{attachments?: unknown[]}} [opts]
 * @returns {{name: string, args: object, why: string} | null}
 */
export function matchFastIntent(text, { attachments = [] } = {}) {
  // A message carrying a document is a request about the document.
  if (attachments.length) return null;
  const cleaned = normalize(text);
  if (disqualify(cleaned)) return null;

  for (const form of TIME_FORMS) {
    if (form.test(cleaned)) return { name: "time_now", args: {}, why: "clock" };
  }

  const percent = cleaned.match(PERCENT_OF);
  if (percent) {
    const [, part, whole] = percent;
    return { name: "calculator", args: { expression: `${part}/100*${whole}` }, why: "percentage" };
  }

  const arithmetic = cleaned.match(ARITHMETIC);
  if (arithmetic) {
    const expression = arithmetic[1].trim();
    // Require a real operator and a real operand: "what is 5" is a question
    // about the number five, not arithmetic.
    if (/\d/.test(expression) && /[+\-*/^%]/.test(expression)) {
      return { name: "calculator", args: { expression }, why: "arithmetic" };
    }
  }

  const remind = cleaned.match(REMIND);
  if (remind) {
    return { name: "remind", args: { text: remind[1].trim(), when: remind[2].trim() }, why: "reminder" };
  }

  const task = cleaned.match(ADD_TASK);
  if (task) return { name: "add_task", args: { title: task[1].trim() }, why: "task" };

  const remember = cleaned.match(REMEMBER);
  if (remember) {
    const fact = remember[1].trim();
    // "remember to buy milk" is a task or a reminder, and guessing which is how
    // an assistant ends up filing a to-do that nobody asked for.
    if (!/^to\s/i.test(fact)) return { name: "remember", args: { fact }, why: "memory" };
  }

  return null;
}

/**
 * Turn a tool's output into a reply without paraphrasing it. The only edit is
 * the clock, whose raw output carries an ISO line that is diagnostics rather
 * than an answer.
 */
export function composeFastReply(match, output) {
  const text = String(output ?? "").trim();
  if (match.name === "time_now") {
    const [first] = text.split("\n");
    return first ? `It is ${first}.` : text;
  }
  return text;
}
