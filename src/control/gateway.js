/**
 * gateway.js — which model answers, and what it may cost.
 *
 * providers.js names backends. router.js fails over. This module sits above
 * both: given a *task class* (chat, plan, classify, embed, code), pick a
 * backend, enforce a spend cap, and optionally reuse a cached answer for
 * identical prompts. Nothing here phones a cloud. Cloud is still opt-in in
 * brain.js; the gateway only orders the list the owner already configured.
 */
import { createHash } from "node:crypto";
import { approxTokens } from "../budget.js";

export const TASKS = Object.freeze(["chat", "plan", "classify", "code", "embed", "fast"]);

const DEFAULT_POLICY = Object.freeze({
  chat: ["primary", "fallback"],
  plan: ["primary"],
  classify: ["small", "primary"],
  code: ["primary"],
  embed: ["primary"],
  fast: ["fast-path"],
});

export function classifyTask(text, { hasTools = false, workflow = false } = {}) {
  const t = String(text || "");
  if (workflow) return "plan";
  if (/^(what time is it|what'?s the time)\b/i.test(t.trim())) return "fast";
  if (hasTools && /\b(write|refactor|implement|test|commit)\b/i.test(t)) return "code";
  if (t.length < 80 && /^(is|are|does|do|can|should)\b/i.test(t.trim())) return "classify";
  return "chat";
}

export function route({ task = "chat", backends = [], policy = DEFAULT_POLICY } = {}) {
  const kind = TASKS.includes(task) ? task : "chat";
  const order = policy[kind] || policy.chat || [];
  const byName = new Map(backends.map((b) => [b.name, b]));
  const picked = [];
  for (const name of order) {
    const hit = byName.get(name);
    if (hit) picked.push(hit);
  }
  if (!picked.length) picked.push(...backends);
  return { task: kind, backends: picked };
}

/** In-memory prompt cache. Text is hashed; the cache never stores the prompt. */
export function createPromptCache({ max = 64 } = {}) {
  const map = new Map();
  return {
    key(messages, model) {
      const body = JSON.stringify({ model, messages: messages?.map((m) => ({ role: m.role, content: m.content })) });
      return createHash("sha256").update(body).digest("hex");
    },
    get(k) {
      const hit = map.get(k);
      if (!hit) return null;
      map.delete(k);
      map.set(k, hit);
      return hit.value;
    },
    set(k, value) {
      if (map.size >= max) map.delete(map.keys().next().value);
      map.set(k, { value, at: Date.now() });
    },
    size: () => map.size,
    clear: () => map.clear(),
  };
}

export function createSpendCap({ limitUsd = 5, now = () => Date.now() } = {}) {
  let spent = 0;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  let stamp = day();
  return {
    observe({ usd = 0, tokens = 0 } = {}) {
      if (day() !== stamp) {
        spent = 0;
        stamp = day();
      }
      const add = Number(usd) || 0;
      if (spent + add > limitUsd) {
        return { ok: false, spent, limitUsd, refused: true };
      }
      spent += add;
      return { ok: true, spent, limitUsd, tokens: Number(tokens) || 0 };
    },
    snapshot: () => ({ spent, limitUsd, day: stamp }),
  };
}

export function estimateUsd(text, { dollarsPerMillion = 0.15 } = {}) {
  const tok = approxTokens(text);
  return (tok / 1_000_000) * dollarsPerMillion;
}
