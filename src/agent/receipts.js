/**
 * receipts.js — the turn answers from what it actually did.
 *
 * Issue #136 (`reason-01-plan-verify`). `src/agent.js` holds every tool result
 * of a turn in its hand and then lets the model describe the turn however it
 * likes. "Done — I moved all twelve files" after one successful move is not a
 * lie the model has to mean: it is an answer written from a half-read
 * transcript. The honesty guard in `src/guard.js` catches the *kind* of claim
 * ("sent", "moved") only when no tool could have done it at all, and says
 * nothing when a tool ran and did a fraction of the work.
 *
 * This module is the missing half, and it is deliberately small and dumb:
 *
 *   1. **A receipt is a record of a call, never an inference about one.** It is
 *      built from the result object a tool returned — including the
 *      machine-readable per-operation `receipt` the batch tools now carry — and
 *      an operation count is only ever read from that, not parsed out of prose.
 *      A tool with no count is one operation if it succeeded, zero if it did
 *      not: that is a fact about the call, not a guess about the world.
 *   2. **A plan is a description of intent.** It is derived from the tool calls
 *      the model has already asked for, so it costs no extra model round-trip
 *      and no latency, and it is shown to the person as a plan. It is not an
 *      approval, it grants nothing, and every call it lists still meets
 *      `src/risk.js` and the approval gate unchanged.
 *   3. **A claim is checked against receipts, and the check can only refuse.**
 *      It cannot approve anything, cannot run a tool, cannot add a receipt, and
 *      cannot invent a number. It can produce a flag and a correction sentence.
 *
 * The third rule is the one that matters for safety: nothing in this file can
 * execute, authorise or persist. It reads a list and answers a question.
 *
 * Nothing here is stored as memory. A plan is not a memory, a receipt is not a
 * memory, and neither is written to `data/memory.json`.
 */

/** How many tool calls a turn must ask for before a plan is worth showing. */
export const PLAN_MIN_STEPS = 3;
/** A plan longer than this is a wall, not a plan. Steps past it are folded. */
export const PLAN_MAX_STEPS = 12;
/** Bounded failure detail in a note: a receipt is a record, not a log dump. */
const MAX_LISTED_FAILURES = 6;
/** How many times a turn may be sent back to correct an unsupported claim. */
export const MAX_CLAIM_CORRECTIONS = 1;

const clip = (value, n = 120) => {
  const s = String(value ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/* ─────────────────────────────── receipts ─────────────────────────────── */

/**
 * The thing a call was aimed at, for a receipt a human can read.
 * Deliberately narrow: the first of the fields a tool's schema uses, clipped.
 */
export function receiptTarget(tool, args = {}) {
  const a = args || {};
  if (Array.isArray(a.operations)) {
    const count = a.operations.length;
    return `${count} operation${count === 1 ? "" : "s"}`;
  }
  const first = [a.path, a.from, a.to, a.command, a.query, a.url, a.text, a.title, a.name, a.repo, a.id].find(
    (value) => typeof value === "string" && value.trim(),
  );
  return first ? clip(first, 100) : "";
}

/**
 * Turn one tool outcome into a receipt.
 *
 * @param {object} input
 * @param {string} input.tool
 * @param {object} [input.args]
 * @param {{ok?: boolean, receipt?: object}|null} [input.result] what the tool returned
 * @param {boolean} [input.denied] the call was refused (denied, frozen, invalid, cancelled)
 * @param {object|null} [input.verification] the independent read-back, if one ran
 * @returns {object} a frozen receipt
 */
export function receiptFor({ tool, args = {}, result = null, denied = false, verification = null }) {
  const ok = Boolean(result?.ok) && !denied;
  const contradicted = verification?.status === "contradicted";
  const batch = result?.receipt && typeof result.receipt === "object" ? result.receipt : null;

  // Counting rule, in one place:
  //   batch tool  → the counts the tool itself recorded per operation
  //   other tool  → one operation, applied only if the call succeeded and no
  //                 independent read-back contradicted it
  //
  // A refused batch call still knows how much it was asked to do, from the
  // arguments — that is the number the person cares about, and reading it from
  // the call is a fact, not an inference.
  const askedOperations = Array.isArray(args?.operations) ? args.operations.length : 0;
  /**
   * A batch-shaped call that never reached the tool — a refused plan, a
   * validation error — still knows how much it was asked to do. Nothing among
   * those operations was attempted, so they are `notRun`, and the caller's
   * refused call is one more thing the turn has to be able to mention.
   */
  const refusedBatch = !batch && askedOperations > 1 && !ok;
  const counts = batch
    ? {
        requested: Math.max(0, Number(batch.requested) || 0),
        applied: Math.max(0, Number(batch.applied) || 0),
        failed: Math.max(0, Number(batch.failed) || 0),
        notRun: Math.max(0, Number(batch.notRun) || 0),
      }
    : refusedBatch
      ? { requested: askedOperations, applied: 0, failed: 0, notRun: askedOperations }
      : { requested: 1, applied: ok && !contradicted ? 1 : 0, failed: ok || denied ? 0 : 1, notRun: 0 };

  // A refused call reached nothing at all; it is a receipt that says so rather
  // than a missing receipt, because "we asked and were told no" is part of the
  // record and the answer has to be able to say it. Refused work was never
  // attempted, so it is "not run", not "failed" — the two deserve different
  // sentences and mean different things to the person reading them.
  if (denied && !batch) {
    counts.applied = 0;
    counts.failed = 0;
    counts.notRun = counts.requested;
  }

  // Invariant: every requested operation is exactly one of applied, failed or
  // not run. A receipt whose parts do not add up is a receipt nobody can check,
  // so the leftover is assigned rather than left for a reader to notice.
  const accounted = counts.applied + counts.failed + counts.notRun;
  if (accounted !== counts.requested) {
    counts.notRun = Math.max(0, counts.notRun + (counts.requested - accounted));
  }

  return Object.freeze({
    tool: String(tool || "unknown"),
    target: receiptTarget(tool, args),
    ok,
    denied: Boolean(denied),
    contradicted,
    kind: batch ? "batch" : "call",
    batchId: batch?.batchId ?? null,
    batchAction: batch?.action ?? null,
    requested: counts.requested,
    applied: counts.applied,
    failed: counts.failed,
    notRun: counts.notRun,
    undoable: Boolean(batch?.undoable),
    failedItems: Array.isArray(batch?.failedItems)
      ? batch.failedItems.slice(0, MAX_LISTED_FAILURES).map((item) => ({
          from: clip(item?.from, 120),
          to: clip(item?.to, 120),
          reason: clip(item?.reason, 160),
        }))
      : [],
  });
}

/**
 * The turn's ledger. Append-only for the life of one turn; nothing else may add
 * a receipt, which is why it is a closure and not an exported array.
 */
export function createReceiptLedger() {
  const entries = [];
  return {
    add(receipt) {
      if (receipt && typeof receipt === "object") entries.push(receipt);
      return receipt;
    },
    addOutcome({ tool, args, result, denied, verification } = {}) {
      return this.add(receiptFor({ tool, args, result, denied, verification }));
    },
    list() {
      return entries.slice();
    },
    size() {
      return entries.length;
    },
    /** Totals a claim is checked against, plus what a note would say. */
    summary() {
      const totals = entries.reduce(
        (acc, entry) => {
          acc.calls += 1;
          acc.requested += entry.requested;
          acc.applied += entry.applied;
          acc.failed += entry.failed;
          acc.notRun += entry.notRun;
          if (entry.denied) acc.denied += 1;
          if (entry.contradicted) acc.contradicted += 1;
          if (entry.kind === "batch") {
            acc.batches += 1;
            if (entry.undoable) acc.undoable = true;
          }
          return acc;
        },
        { calls: 0, requested: 0, applied: 0, failed: 0, notRun: 0, denied: 0, contradicted: 0, batches: 0, undoable: false },
      );
      // Operations that were never attempted are still part of "12"; they are
      // reported separately because "not run" and "failed" deserve different
      // sentences and mean different things to the person reading them.
      totals.unsuccessful = totals.failed + totals.notRun;
      totals.partial = totals.applied > 0 && (totals.failed > 0 || totals.notRun > 0);
      totals.clean = totals.requested > 0 && totals.unsuccessful === 0 && totals.contradicted === 0;
      return totals;
    },
    /** True when the turn did something that a count could be claimed about. */
    hasOperations() {
      return entries.some((entry) => entry.requested > 0);
    },
  };
}

/* ───────────────────────────────── plans ──────────────────────────────── */

/**
 * Build the plan shown in the transcript.
 *
 * @param {Array<{tool: string, label: string}>} steps calls the model asked for
 * @returns {{steps: Array<{n: number, tool: string, label: string}>, omitted: number}|null}
 *   null when there is nothing to plan (fewer than PLAN_MIN_STEPS).
 */
export function buildTurnPlan(steps = []) {
  const wanted = steps.filter((step) => step && step.tool);
  if (wanted.length < PLAN_MIN_STEPS) return null;
  const kept = wanted.slice(0, PLAN_MAX_STEPS).map((step, i) => ({
    n: i + 1,
    tool: String(step.tool),
    label: clip(step.label || step.tool, 160),
  }));
  return Object.freeze({
    steps: Object.freeze(kept),
    omitted: Math.max(0, wanted.length - kept.length),
    /**
     * Loop-backed tools run once per turn: a model that asks for the same
     * `move_path` three rounds running is describing one intended action, and a
     * plan that repeated it three times would overstate the work before a single
     * operation had run. Distinct calls are distinct steps, always.
     */
    distinct: new Set(kept.map((step) => `${step.tool}::${step.label}`)).size,
    /** Said in every rendering: a plan is not a permission. */
    note: "This is the plan, not the result — and not an approval. Every step still asks the way it always does.",
  });
}

/** The plan as lines, for a text channel or a terminal. */
export function renderPlan(plan) {
  if (!plan) return "";
  const lines = [`⌁ Plan — ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}:`];
  for (const step of plan.steps) lines.push(`  ${step.n}. ${step.label}`);
  if (plan.omitted) lines.push(`  …and ${plan.omitted} more`);
  lines.push(`  ${plan.note}`);
  return lines.join("\n");
}

/* ──────────────────────────────── claims ─────────────────────────────── */

/**
 * Number words up to twenty, plus the couple of idioms a person actually uses.
 * A claim we cannot read is not checked by count — the guard's action-claim
 * rules still apply, and inventing a number to compare against would be worse
 * than staying quiet.
 */
const NUMBER_WORDS = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, dozen: 12,
});

const NUMBER = String.raw`\d{1,4}|(?:a\s+)?(?:${Object.keys(NUMBER_WORDS).join("|")})`;

/** The nouns a count of completed work is usually attached to. */
const COUNT_NOUN =
  String.raw`(?:files?|folders?|director(?:y|ies)|items?|entries|entry|operations?|ops|steps?|moves?|renames?|documents?|photos?|attachments?|tasks?|records?|rows?|lines?)`;

/** Words that turn a count into a description of what did *not* happen. */
const NEGATED =
  /\b(?:could\s?n[o']t|could not|can[’']?t|cannot|failed to|did\s?n[o']t|did not|unable to|not|only|skipped|refused|blocked|left|remaining)\b[^.?!\n]{0,24}$/i;

function numberValue(raw) {
  const text = String(raw).trim().toLowerCase().replace(/^a\s+/, "");
  if (/^\d+$/.test(text)) return Number(text);
  return Number.isInteger(NUMBER_WORDS[text]) ? NUMBER_WORDS[text] : null;
}

/**
 * Extract the numeric claims a reply makes about completed work.
 *
 * Only three shapes are read, because only three shapes are unambiguous enough
 * to check without guessing:
 *
 *   "3 of 12"        an explicit partial report
 *   "all twelve"     everything that was asked for
 *   "12 files"       a bare count with a countable noun after it
 *
 * @param {string} reply
 * @returns {Array<{raw: string, claimed: number|null, of: number|null, all: boolean}>}
 */
export function extractOperationClaims(reply) {
  const said = String(reply ?? "");
  if (!said.trim()) return [];
  const claims = [];
  const spans = [];
  let universalTotal = false;
  const push = (raw, extra, span) => {
    if (claims.length >= 6) return;
    // One span, one claim. "3 of 12 files" matches both the "of" form and the
    // bare-count form; counting it twice would let a true sentence look like a
    // second, unsupported claim of three.
    if (span && spans.some(([start, end]) => span.start < end && start < span.end)) return;
    if (span) spans.push([span.start, span.end]);
    claims.push({ raw: clip(raw, 80), claimed: null, of: null, all: false, ...extra });
  };
  const spanOf = (match) => ({ start: match.index, end: match.index + match[0].length });

  // "3 of 12 operations", "3/12 files", "2 of the 5 folders".
  //
  // The countable noun is required, so "2 of 3 tests passed" in a report about
  // a test run is not mistaken for a file count. A sentence with no countable
  // noun is left alone: the guard's action-claim rules still apply to it, and
  // guessing what number it meant would be worse than saying nothing.
  const ofRe = new RegExp(String.raw`\b(${NUMBER})\s*(?:of|\/)\s*(?:the\s+|your\s+)?(${NUMBER})\b`, "gi");
  for (const match of said.matchAll(ofRe)) {
    if (NEGATED.test(said.slice(Math.max(0, match.index - 40), match.index))) continue;
    const nearby = new RegExp(String.raw`\b${COUNT_NOUN}\b`, "i");
    if (!nearby.test(said.slice(match.index, match.index + 60))) continue;
    push(match[0], { claimed: numberValue(match[1]), of: numberValue(match[2]) }, spanOf(match));
  }

  // "all twelve files", "all 12 of them", "all files", "every file", and the
  // summary words that mean the same thing without a number: "everything",
  // "all done". These are the shapes the issue names — a partial batch
  // described as finished — and they are unreadable as anything else.
  const allRe = new RegExp(
    String.raw`\b(?:(?:all|every|both)\s+(?:of\s+)?(?:the\s+|your\s+|these\s+|those\s+|them\s+)?(?:(${NUMBER})\s+)?(${COUNT_NOUN})?|everything|all\s+(?:done|set|complete|finished))\b`,
    "gi",
  );
  for (const match of said.matchAll(allRe)) {
    if (NEGATED.test(said.slice(Math.max(0, match.index - 40), match.index))) continue;
    // "everything"/"all done" are universal claims with no number attached.
    const universal = /^(?:everything|all\s)/i.test(match[0]) && !match[1] && !match[2];
    if (!match[1] && !match[2] && !universal) continue; // "all of it" says nothing countable
    if (universal) universalTotal = true;
    push(match[0], { claimed: match[1] ? numberValue(match[1]) : null, all: true }, spanOf(match));
  }

  // "moved 12 files", "12 files moved", "I renamed 7 folders".
  //
  // A number inside an "N of M" phrase was already read above; re-reading its
  // denominator as a bare count would invent a claim of twelve from the true
  // sentence "3 of 12 files moved".
  const bareRe = new RegExp(String.raw`\b(${NUMBER})\s+(?:[\w-]+\s+){0,2}(${COUNT_NOUN})\b`, "gi");
  for (const match of said.matchAll(bareRe)) {
    const start = match.index;
    const isDenominator = new RegExp(String.raw`\b${NUMBER}\s*(?:of|\/)\s*(?:the\s+|your\s+)?$`, "i").test(
      said.slice(Math.max(0, start - 24), start),
    );
    if (isDenominator) continue;
    if (NEGATED.test(said.slice(Math.max(0, start - 40), start))) continue;
    push(match[0], { claimed: numberValue(match[1]) }, spanOf(match));
  }

  // One claim per distinct number is enough noise; the correction carries the
  // exact totals anyway.
  const seen = new Set();
  const unique = claims.filter((claim) => {
    const key = `${claim.claimed}:${claim.of}:${claim.all}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // Carried on the returned array rather than as a second return value: the
  // caller reads claims, and one boolean describing them is not worth changing
  // the shape every caller already handles.
  Object.defineProperty(unique, "universalTotal", { value: universalTotal, enumerable: false });
  return unique;
}

/**
 * Compare the reply's counts with the receipts. Pure; never throws for bad input.
 *
 * @param {{reply: string, receipts: Array<object>}} input
 * @returns {{flags: Array<{code: string, message: string}>, mismatches: Array<object>}}
 */
export function auditReceiptClaims({ reply, receipts = [] } = {}) {
  const list = Array.isArray(receipts) ? receipts.filter((r) => r && r.requested > 0) : [];
  if (!list.length) return { flags: [], mismatches: [] };

  const requested = list.reduce((n, r) => n + r.requested, 0);
  const applied = list.reduce((n, r) => n + r.applied, 0);
  const unsuccessful = list.reduce((n, r) => n + r.failed + r.notRun, 0);
  const claims = extractOperationClaims(reply);
  const mismatches = [];

  for (const claim of claims) {
    // "all twelve" is a claim about everything that was asked for.
    if (claim.all && claim.claimed === null) {
      if (unsuccessful > 0 || applied < requested) {
        mismatches.push({
          claim: claim.raw,
          claimed: requested,
          supported: applied,
          message: `the reply says "${claim.raw}" but the receipts cover ${applied} of ${requested} operation${requested === 1 ? "" : "s"}`,
        });
      }
      continue;
    }
    const claimed = claim.claimed;
    if (!Number.isInteger(claimed) || claimed <= 0) continue;
    const denominator = Number.isInteger(claim.of) && claim.of > 0 ? claim.of : null;
    // A denominator that matches a batch's own total is the tool's number, and
    // the numerator must match that batch's applied count.
    if (denominator !== null) {
      const batch = list.find((r) => r.kind === "batch" && r.requested === denominator);
      const supported = batch ? batch.applied : applied;
      if (claimed > supported) {
        mismatches.push({
          claim: claim.raw,
          claimed,
          supported,
          message: `the reply says "${claim.raw}" but ${supported} of ${denominator} operation${denominator === 1 ? "" : "s"} actually completed`,
        });
      }
      continue;
    }
    if (claimed > applied) {
      mismatches.push({
        claim: claim.raw,
        claimed,
        supported: applied,
        message: `the reply says "${claim.raw}" but ${applied} operation${applied === 1 ? "" : "s"} completed this turn`,
      });
    }
  }

  const flags = [];
  if (mismatches.length) {
    flags.push({
      code: "receipt-count-mismatch",
      message: mismatches[0].message,
    });
    // "Done — everything is in the archive" over a half-finished batch is its
    // own failure: no number was claimed, so the count check above is the only
    // thing standing between a reader and a summary of work that did not
    // happen. Name it separately so the note is actionable rather than cryptic.
    if (claims.universalTotal) {
      flags.push({
        code: "partial-failure-unreported",
        message: `${unsuccessful} of ${requested} operation${requested === 1 ? "" : "s"} did not complete, but the reply reports the work as finished`,
      });
    }
  }

  // A partial batch described as a whole success is the same error in prose
  // form, and it is the one the issue names explicitly.
  if (unsuccessful > 0) {
    const said = String(reply ?? "");
    const reported =
      /\b(?:failed|failure|could\s?n[o']t|could not|not run|did\s?n[o']t|did not|skipped|stopped|part(?:ial|ly))\b/i.test(said) ||
      // An explicit "3 of 12" in prose is a faithful partial report.
      new RegExp(String.raw`\b${NUMBER}\s+of\s+${NUMBER}\b`, "i").test(said);
    if (!reported && !flags.some((flag) => flag.code === "partial-failure-unreported")) {
      flags.push({
        code: "partial-failure-unreported",
        message: `${unsuccessful} of ${requested} operation${requested === 1 ? "" : "s"} did not complete, and the reply does not say so`,
      });
    }
  }

  return { flags, mismatches };
}

/* ──────────────────────────────── notes ──────────────────────────────── */

/**
 * The correction handed back to the model when its draft outran its receipts.
 * Data, not an instruction from the owner: it is labelled as a code check so a
 * model cannot read it as new permission or as a change of goal.
 */
export function buildReceiptCorrection({ receipts = [], reply = "" } = {}) {
  const list = Array.isArray(receipts) ? receipts : [];
  const requested = list.reduce((n, r) => n + r.requested, 0);
  const applied = list.reduce((n, r) => n + r.applied, 0);
  const failures = list.flatMap((r) => r.failedItems.map((item) => `${item.from}${item.to ? ` → ${item.to}` : ""} (${item.reason})`));
  const audit = auditReceiptClaims({ reply, receipts: list });
  return [
    "<receipt-check>",
    "A code check compared your draft with the tool results of this turn. It grants no permission and changes no goal; it only corrects the numbers.",
    `Your draft said: ${clip(reply, 240)}`,
    `Receipts: ${applied} of ${requested} operation${requested === 1 ? "" : "s"} completed.`,
    ...audit.flags.map((flag) => `Problem: ${flag.message}`),
    failures.length ? `Failed or not run: ${failures.slice(0, MAX_LISTED_FAILURES).join("; ")}` : "",
    "Rewrite the answer so every number matches the receipts. Say per step what happened and what did not. Do not call a tool to prove it.",
    "</receipt-check>",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The visible receipt footer: per-step truth, including the failures, in the
 * reader's words rather than the model's.
 */
export function renderReceipts(receipts = [], { plan = null } = {}) {
  const list = Array.isArray(receipts) ? receipts : [];
  const operation = list.filter((r) => r && r.requested > 0);
  if (!operation.length) return "";

  const requested = operation.reduce((n, r) => n + r.requested, 0);
  const applied = operation.reduce((n, r) => n + r.applied, 0);
  const failed = operation.reduce((n, r) => n + r.failed, 0);
  const notRun = operation.reduce((n, r) => n + r.notRun, 0);
  const undoable = operation.some((r) => r.undoable);

  // Only when the plan asked for more *distinct* work than the receipts cover:
  // the same loop-backed call repeated across rounds is one intended action.
  // A model that described three steps and took one is a gap worth a line even
  // though nothing failed, because the reader was promised three.
  const plannedDistinct = Number(plan?.distinct ?? plan?.steps?.length ?? 0);
  const planGap = plannedDistinct > operation.length;

  // Quiet when nothing went wrong and the turn was small: the transcript
  // already shows one row per call, and a footer that repeats it every turn is
  // noise that trains the reader to skip the footer that matters.
  if (failed === 0 && notRun === 0 && requested < PLAN_MIN_STEPS && !planGap) return "";

  const lines = [];
  const head = `🧾 **Receipts:** ${applied} of ${requested} operation${requested === 1 ? "" : "s"} completed`;
  lines.push(
    failed || notRun
      ? `${head} — ${[failed ? `${failed} failed` : "", notRun ? `${notRun} not run` : ""].filter(Boolean).join(", ")}.`
      : `${head}.`,
  );

  const items = operation.flatMap((r) => r.failedItems);
  for (const item of items.slice(0, MAX_LISTED_FAILURES)) {
    lines.push(`  • failed: ${item.from}${item.to ? ` → ${item.to}` : ""} (${item.reason})`);
  }
  if (items.length > MAX_LISTED_FAILURES) lines.push(`  • …and ${items.length - MAX_LISTED_FAILURES} more`);
  if (notRun && !items.length) lines.push(`  • ${notRun} operation${notRun === 1 ? " was" : "s were"} never attempted.`);
  if (undoable) lines.push("  • `undo_last` reverses what landed.");
  if (planGap) {
    lines.push(`  • plan had ${plannedDistinct} step${plannedDistinct === 1 ? "" : "s"}; receipts cover ${operation.length} call${operation.length === 1 ? "" : "s"}.`);
  }
  return lines.join("\n");
}

/** The turn plan and receipts as plain data for the transcript and the result. */
export function summarizeTurn({ receipts = [], plan = null } = {}) {
  const list = Array.isArray(receipts) ? receipts : [];
  const totals = list.reduce(
    (acc, r) => {
      acc.requested += Number(r?.requested) || 0;
      acc.applied += Number(r?.applied) || 0;
      acc.failed += Number(r?.failed) || 0;
      acc.notRun += Number(r?.notRun) || 0;
      return acc;
    },
    { requested: 0, applied: 0, failed: 0, notRun: 0 },
  );
  return {
    plan: plan ? { steps: plan.steps.map((s) => ({ n: s.n, tool: s.tool, label: s.label })), omitted: plan.omitted } : null,
    receipts: totals,
  };
}
