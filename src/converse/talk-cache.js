/**
 * talk-cache.js — identical talk-only questions should not pay decode twice.
 *
 * Hash of (model + user text) only. Never caches act/social, never stores the
 * prompt, 120 s TTL. Off with QUASNOOZE_TALK_CACHE=off.
 */
import { createHash } from "node:crypto";

const TTL_MS = 120_000;
const MAX = 64;
const store = new Map();

export function talkCacheEnabled() {
  const v = process.env.QUASNOOZE_TALK_CACHE;
  if (v === undefined || v === "") return true;
  return /^(1|true|yes|on)$/i.test(String(v));
}

export function talkCacheKey({ model, text, sessionId = "" }) {
  return createHash("sha256").update(`${model}\n${sessionId}\n${String(text || "").trim()}`).digest("hex");
}

export function talkCacheGet(key, now = Date.now()) {
  const hit = store.get(key);
  if (!hit) return null;
  if (now - hit.at > TTL_MS) {
    store.delete(key);
    return null;
  }
  return hit.text;
}

export function talkCacheSet(key, text, now = Date.now()) {
  if (store.size >= MAX) store.delete(store.keys().next().value);
  store.set(key, { text: String(text || "").slice(0, 4000), at: now });
}

export function talkCacheClear() {
  store.clear();
}
