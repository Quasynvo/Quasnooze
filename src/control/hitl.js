/**
 * hitl.js — a durable human-in-the-loop queue.
 *
 * In-memory approvals in agent.js die with the process. That is correct for
 * a ten-minute "allow this shell?" prompt. It is wrong for "wait for me to
 * review this outbound message tomorrow". This queue is JSON on disk:
 * pending → approved | denied | expired. The model cannot mint a decision.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { validate } from "./schema.js";

export const HITL_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["id", "state", "action", "createdAt"],
  properties: {
    id: { type: "string", minLength: 8, maxLength: 64 },
    state: { type: "string", enum: ["pending", "approved", "denied", "expired"] },
    action: { type: "string", minLength: 1, maxLength: 400 },
    preview: { type: "string", maxLength: 4000 },
    sessionId: { type: "string", maxLength: 128 },
    channel: { type: "string", maxLength: 32 },
    createdAt: { type: "string" },
    decidedAt: { type: ["string", "null"] },
    by: { type: ["string", "null"] },
    ttlMs: { type: "number", minimum: 1000, maximum: 7 * 24 * 3600 * 1000 },
  },
});

const FILE = () => join(config.dataDir, "hitl-queue.json");
const MAX = 50;

function load() {
  if (!existsSync(FILE())) return [];
  try {
    const raw = JSON.parse(readFileSync(FILE(), "utf8"));
    return Array.isArray(raw) ? raw.slice(-MAX) : [];
  } catch {
    return [];
  }
}

function save(items) {
  mkdirSync(dirname(FILE()), { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(items.slice(-MAX), null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, FILE());
}

function expire(items, now) {
  return items.map((item) => {
    if (item.state !== "pending") return item;
    const age = now - Date.parse(item.createdAt || 0);
    if (Number.isFinite(age) && age > (item.ttlMs || 3_600_000)) {
      return { ...item, state: "expired", decidedAt: new Date(now).toISOString() };
    }
    return item;
  });
}

export function enqueueHitl({ action, preview = "", sessionId = "default", channel = "web", ttlMs = 3_600_000, now = Date.now() } = {}) {
  const item = validate(HITL_SCHEMA, {
    id: randomBytes(8).toString("hex"),
    state: "pending",
    action: String(action || "action").slice(0, 400),
    preview: String(preview || "").slice(0, 4000),
    sessionId: String(sessionId).slice(0, 128),
    channel: String(channel).slice(0, 32),
    createdAt: new Date(now).toISOString(),
    decidedAt: null,
    by: null,
    ttlMs: Number(ttlMs) || 3_600_000,
  });
  const items = expire(load(), now);
  items.push(item);
  save(items);
  return item;
}

export function decideHitl(id, { approve, by = "owner", now = Date.now() } = {}) {
  const items = expire(load(), now);
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return { ok: false, error: "unknown item" };
  const cur = items[idx];
  if (cur.state !== "pending") return { ok: false, error: `already ${cur.state}`, item: cur };
  const next = {
    ...cur,
    state: approve ? "approved" : "denied",
    decidedAt: new Date(now).toISOString(),
    by: String(by || "owner").slice(0, 80),
  };
  items[idx] = next;
  save(items);
  return { ok: true, item: next };
}

export function listHitl({ state, now = Date.now() } = {}) {
  const items = expire(load(), now);
  save(items);
  return state ? items.filter((i) => i.state === state) : items;
}

export function pendingHitl(opts) {
  return listHitl({ ...opts, state: "pending" });
}
