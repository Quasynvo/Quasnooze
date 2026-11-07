/**
 * a2a.js — agent-to-agent envelopes, without a mesh.
 *
 * A2A as a protocol is a 2026–27 story. Inside one owner machine the need is
 * smaller: a worker may not inherit the parent's tool grants, a message must
 * name a goal and a budget, and cancellation must be data. This is that
 * envelope. No sockets, no discovery, no marketplace.
 */
import { randomBytes } from "node:crypto";
import { validate } from "./schema.js";

export const ENVELOPE = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "from", "to", "goal", "budget", "grants", "createdAt"],
  properties: {
    id: { type: "string", minLength: 8, maxLength: 64 },
    from: { type: "string", minLength: 1, maxLength: 64 },
    to: { type: "string", minLength: 1, maxLength: 64 },
    goal: { type: "string", minLength: 1, maxLength: 400 },
    context: { type: "string", maxLength: 4000 },
    budget: {
      type: "object",
      required: ["rounds", "timeoutMs"],
      additionalProperties: false,
      properties: {
        rounds: { type: "number", minimum: 1, maximum: 8 },
        timeoutMs: { type: "number", minimum: 100, maximum: 600_000 },
      },
    },
    grants: {
      type: "array",
      maxItems: 16,
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    createdAt: { type: "string" },
    parentTurn: { type: ["string", "null"] },
  },
});

const SAFE_GRANTS = new Set(["search_docs", "read_file", "list_dir", "grep", "web_search", "memory_search"]);

export function mintEnvelope({ from, to, goal, context = "", budget, grants = [], parentTurn = null } = {}) {
  const cleanGrants = [...new Set((grants || []).map(String))].filter((g) => SAFE_GRANTS.has(g)).slice(0, 16);
  return validate(ENVELOPE, {
    id: randomBytes(8).toString("hex"),
    from: String(from || "parent").slice(0, 64),
    to: String(to || "worker").slice(0, 64),
    goal: String(goal || "").slice(0, 400) || "unspecified",
    context: String(context || "").slice(0, 4000),
    budget: {
      rounds: Math.min(8, Math.max(1, Number(budget?.rounds) || 2)),
      timeoutMs: Math.min(600_000, Math.max(100, Number(budget?.timeoutMs) || 30_000)),
    },
    grants: cleanGrants,
    createdAt: new Date().toISOString(),
    parentTurn: parentTurn == null ? null : String(parentTurn).slice(0, 64),
  });
}

/** A worker may only call tools named in the envelope. Shell is never grantable here. */
export function workerMay(envelope, toolName) {
  if (!envelope || !Array.isArray(envelope.grants)) return false;
  if (SAFE_GRANTS.has(toolName) === false) return false;
  return envelope.grants.includes(toolName);
}

export function replyTo(envelope, { ok, text, evidence = [] } = {}) {
  return {
    id: randomBytes(8).toString("hex"),
    inReplyTo: envelope?.id || null,
    ok: ok === true,
    text: String(text || "").slice(0, 4000),
    evidence: (Array.isArray(evidence) ? evidence : []).slice(0, 8).map((e) => String(e).slice(0, 200)),
    at: new Date().toISOString(),
  };
}
