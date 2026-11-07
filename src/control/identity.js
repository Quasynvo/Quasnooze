/**
 * identity.js — who is talking, and what they may see.
 *
 * Quasnooze is single-owner by design. That is not the same as having no
 * identity: sessions, channels and retrieval still need a stable subject so
 * a Telegram chat cannot read a web-panel memory, and a document tagged for
 * one workspace root cannot leak into another.
 *
 * Subjects are data, never taken from model output. Channel + session +
 * optional tenant label. The tenant label comes from config / env only.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

const CHANNELS = new Set(["web", "cli", "telegram", "discord", "slack", "whatsapp", "desktop", "system"]);

export function normalizeChannel(channel) {
  const c = String(channel || "web").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  return CHANNELS.has(c) ? c : "web";
}

export function tenantId() {
  const raw = process.env.QUASNOOZE_TENANT || config.memoryScope || "user";
  return String(raw).slice(0, 80);
}

/**
 * A subject is the unit of isolation for memory, traces and retrieval.
 * Hashing keeps logs free of raw session ids while remaining stable.
 */
export function subject({ channel = "web", sessionId = "default", owner = config.ownerName } = {}) {
  const ch = normalizeChannel(channel);
  const sid = String(sessionId || "default").slice(0, 128);
  const ten = tenantId();
  const id = createHash("sha256").update(`${ten}|${ch}|${sid}`).digest("hex").slice(0, 16);
  return {
    id,
    tenant: ten,
    channel: ch,
    sessionId: sid,
    owner: String(owner || "friend").slice(0, 80),
  };
}

/** True when `doc` may be shown to `who`. Missing ACL means owner-only. */
export function mayRead(who, doc) {
  if (!doc || typeof doc !== "object") return false;
  if (!who || typeof who !== "object") return false;
  const acl = doc.acl && typeof doc.acl === "object" ? doc.acl : null;
  if (!acl) return who.tenant === tenantId();
  if (Array.isArray(acl.denySubjects) && acl.denySubjects.includes(who.id)) return false;
  if (acl.public === true) return who.tenant === (acl.tenant || tenantId());
  if (acl.tenant && acl.tenant !== who.tenant) return false;
  if (Array.isArray(acl.subjects) && acl.subjects.length) return acl.subjects.includes(who.id);
  if (acl.channel && acl.channel !== who.channel) return false;
  return who.tenant === (acl.tenant || tenantId());
}

export function stampAcl(who, extra = {}) {
  return {
    tenant: who.tenant,
    channel: who.channel,
    subjects: [who.id],
    public: false,
    ...extra,
  };
}
