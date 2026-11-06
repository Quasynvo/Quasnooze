/**
 * verify.js — a tool's return value is a claim, not proof.
 *
 * Every assistant in this category reports what it *tried* to do. OpenAdapt is
 * the only one that made the obvious next step and read the result back from the
 * system of record, and it does that inside a compiled program. Here it is
 * per-action, in a conversation, on the tools that touch something real:
 *
 *   verified      — an independent read of the world agrees with the claim
 *   contradicted  — the world disagrees; the reply is not allowed to say "done"
 *   unverified    — there is no read-back worth trusting for this action
 *
 * The third state is the important one and the one most products skip. A
 * boolean `ok` forces "success" and "we did not check" to look identical, which
 * is exactly how an assistant ends up lying without a bug in it.
 *
 * Verification never changes what the tool did. It reads afterwards, and a
 * verifier that throws is `unverified`, never `verified` — a check that fails
 * open is not a check.
 */
import { readFile } from "node:fs/promises";
import { loadMemory, loadTasks, pendingReminders } from "./store.js";
import { calculate, resolveInWorkspace } from "./tools.js";

export const VERIFIED = "verified";
export const CONTRADICTED = "contradicted";
export const UNVERIFIED = "unverified";

const ok = (detail, evidence = null) => ({ status: VERIFIED, detail, evidence });
const bad = (detail, evidence = null) => ({ status: CONTRADICTED, detail, evidence });
const unknown = (detail) => ({ status: UNVERIFIED, detail, evidence: null });

const clip = (text, n = 120) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/**
 * Independent read-backs, one per tool that changes something. A tool with no
 * entry here is honestly `unverified` rather than optimistically green: a shell
 * command's exit code is the tool's own report, not the world's.
 */
const VERIFIERS = new Map([
  [
    "write_file",
    async ({ path, content }) => {
      let actual;
      try {
        actual = await readFile(resolveInWorkspace(path), "utf8");
      } catch (err) {
        if (/outside the allowed workspace/i.test(String(err.message))) {
          return bad(`the path is outside the workspace, so nothing was written there`);
        }
        return bad(`the file is not readable after the write (${err.code || err.message})`);
      }
      if (actual === content) {
        return ok(`read back ${Buffer.byteLength(content, "utf8")} bytes; byte-identical`, { path });
      }
      return bad(
        `the file on disk differs from what was written (${Buffer.byteLength(actual, "utf8")} bytes on disk vs ` +
          `${Buffer.byteLength(String(content ?? ""), "utf8")} written)`,
        { path },
      );
    },
  ],
  [
    "calculator",
    async ({ expression }, _ctx, result) => {
      let expected;
      try {
        expected = calculate(expression);
      } catch {
        return unknown("the expression could not be recomputed independently");
      }
      const reported = String(result.output ?? "");
      if (reported.includes(String(expected))) {
        return ok(`recomputed ${clip(expression, 60)} = ${expected}`);
      }
      return bad(`recomputation gives ${expected}, the tool reported “${clip(reported, 80)}”`);
    },
  ],
  [
    "add_task",
    async ({ title }) => {
      const needle = String(title ?? "").slice(0, 200).toLowerCase();
      const hit = loadTasks().find((task) => String(task.title).toLowerCase() === needle);
      return hit
        ? ok(`the task list now contains “${clip(hit.title, 80)}”`)
        : bad(`no task matching “${clip(needle, 60)}” is in the task list`);
    },
  ],
  [
    "remind",
    async ({ text }) => {
      const needle = String(text ?? "").slice(0, 300);
      const hit = pendingReminders().find((reminder) => reminder.text === needle);
      return hit
        ? ok(`a pending reminder for “${clip(needle, 60)}” now exists`, { at: hit.at })
        : bad(`no pending reminder for “${clip(needle, 60)}” was found after the call`);
    },
  ],
  [
    "remember",
    async ({ fact }) => {
      const needle = String(fact ?? "").trim().slice(0, 500).toLowerCase();
      const hit = loadMemory().facts.find((entry) => String(entry.text).toLowerCase() === needle);
      return hit
        ? ok(`memory now contains “${clip(needle, 60)}”`)
        : bad(`memory does not contain “${clip(needle, 60)}” after the call`);
    },
  ],
]);

export const VERIFIABLE = new Set(VERIFIERS.keys());

/** Register (or replace) a read-back, for custom tools and for tests. */
export function registerVerifier(name, fn) {
  if (typeof fn !== "function") throw new TypeError("a verifier must be a function");
  VERIFIERS.set(name, fn);
  VERIFIABLE.add(name);
  return fn;
}

/**
 * @param {string} name tool name
 * @param {object} args the arguments the tool was called with
 * @param {object} ctx the tool's context (unused today; kept for verifiers that need it)
 * @param {{ok: boolean, output?: string}} result what the tool reported
 * @returns {Promise<{status: string, detail: string, evidence: object|null, ms: number}|null>}
 *   null when the tool failed: there is nothing to verify, and `ok:false` is
 *   already the honest record.
 */
export async function verifyAction(name, args, ctx, result) {
  if (!result || result.ok !== true) return null;
  const verifier = VERIFIERS.get(name);
  if (!verifier) {
    return { ...unknown(`no independent read-back is defined for ${name}`), ms: 0 };
  }
  const started = Date.now();
  try {
    const verdict = await verifier(args || {}, ctx, result);
    return {
      status: verdict.status,
      detail: verdict.detail,
      evidence: verdict.evidence ?? null,
      ms: Date.now() - started,
    };
  } catch (err) {
    // A verifier that throws proves nothing. Saying so is the whole point.
    return { ...unknown(`the read-back for ${name} failed: ${err.message}`), ms: Date.now() - started };
  }
}

/** One line a human can read in a trace or a reply. */
export function describeVerification(verification) {
  if (!verification) return "";
  if (verification.status === VERIFIED) return `verified — ${verification.detail}`;
  if (verification.status === CONTRADICTED) return `CONTRADICTED — ${verification.detail}`;
  return `unverified — ${verification.detail}`;
}
