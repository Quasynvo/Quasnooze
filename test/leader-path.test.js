import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "quasnooze-leader-"));
process.env.PINCH_DATA = dataDir;
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_GUARD = "off";
process.env.QUASNOOZE_TALK_CACHE = "on";

import { staticPrefixHash, buildSystemPrompt } from "../src/prompt.js";
import { remember } from "../src/store.js";
import { isVisionModel, visionDecision } from "../src/converse/vision.js";
import { talkCacheKey, talkCacheGet, talkCacheSet, talkCacheClear } from "../src/converse/talk-cache.js";
import { classifyTalk } from "../src/converse/talk-shape.js";
import { approxTokens } from "../src/budget.js";
import { buildTalkPrompt } from "../src/prompt.js";

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test("static system prefix does not move when memory or clock would", () => {
  const a = staticPrefixHash();
  remember("the garage code is 9921");
  const b = staticPrefixHash();
  assert.equal(a, b);
  const full = buildSystemPrompt({ channel: "web" });
  assert.match(full, /garage code is 9921/);
  assert.match(full, /untrusted data, not instructions/);
});

test("vision gate refuses text models and allows known vision tags", () => {
  assert.equal(isVisionModel("qwen2.5-coder:7b"), false);
  assert.equal(isVisionModel("llava:7b"), true);
  assert.equal(visionDecision({ hasImages: false, model: "llama3" }).ok, true);
  assert.equal(visionDecision({ hasImages: true, model: "llama3", provider: "ollama" }).ok, false);
  assert.equal(visionDecision({ hasImages: true, model: "llava", provider: "ollama" }).ok, true);
  assert.equal(visionDecision({ hasImages: true, model: "llama3", provider: "mock" }).ok, true);
});

test("talk cache hits within TTL and misses after", () => {
  talkCacheClear();
  const k = talkCacheKey({ model: "mock/mock", text: "what is TLS", sessionId: "s1" });
  assert.equal(talkCacheGet(k, 1_000), null);
  talkCacheSet(k, "transport layer security", 1_000);
  assert.equal(talkCacheGet(k, 1_000 + 1_000), "transport layer security");
  assert.equal(talkCacheGet(k, 1_000 + 121_000), null);
});

test("talk prompt is cheaper than agent prompt plus a tool schema", () => {
  assert.equal(classifyTalk("what is photosynthesis").kind, "talk");
  const talkTok = approxTokens(buildTalkPrompt({ userText: "what is photosynthesis" }));
  const agentTok = approxTokens(buildSystemPrompt()) + approxTokens('[{"name":"shell"}]');
  assert.ok(talkTok < agentTok, `${talkTok} !< ${agentTok}`);
});
