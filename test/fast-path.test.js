/**
 * The fast path is the first frontier item that ships, so its tests are the
 * contract in practice: a deterministic turn must (1) never touch the model,
 * (2) never route something ambiguous to a tool that acts, and (3) fall back
 * silently when it is wrong, because a failed fast turn is supposed to look
 * exactly like a normal one.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-fast-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-fast-data-"));
process.env.LLM_PROVIDER = "ollama";
process.env.PINCH_AUTO_APPROVE = "false";
delete process.env.PINCH_FAST_PATH;

const modelCalls = [];
const modelServer = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  modelCalls.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
  const message = { content: "model turn" };
  if (req.url === "/api/chat") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ message, done: true }));
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message }] }));
});
await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${modelServer.address().port}`;
process.env.OLLAMA_URL = base;
process.env.OPENAI_BASE_URL = `${base}/v1`;
process.env.OPENAI_API_KEY = "test-model-key";
after(async () => {
  modelServer.closeAllConnections();
  await new Promise((r) => modelServer.close(r));
});

const { runAgent } = await import("../src/agent.js");
const { matchFastIntent, FAST_TOOLS, MAX_WORDS } = await import("../src/fast-path.js");
const { DANGEROUS } = await import("../src/tools.js");

const corpus = JSON.parse(readFileSync("test-fixtures/fast-path-corpus.json", "utf8"));

test("the matcher never routes an ambiguous utterance", () => {
  const wrong = [];
  for (const item of corpus.items) {
    if (item.intent) continue;
    const match = matchFastIntent(item.text);
    if (match) wrong.push(`${item.text} → ${match.name}`);
  }
  assert.deepEqual(wrong, [], "a negative routed to a tool performs an action nobody asked for");
});

test("the matcher covers the deterministic phrasings it claims to", () => {
  const positives = corpus.items.filter((i) => i.intent);
  const missed = positives.filter((i) => matchFastIntent(i.text)?.name !== i.intent);
  assert.deepEqual(missed.map((i) => i.text), [], "coverage regressed");
});

test("the matcher can only reach non-destructive tools", () => {
  for (const item of corpus.items) {
    const match = matchFastIntent(item.text);
    if (!match) continue;
    assert.ok(FAST_TOOLS.has(match.name), `${match.name} is outside the fast-path allowlist`);
    assert.ok(!DANGEROUS.has(match.name), `${match.name} is dangerous and must go through approval`);
  }
  // The allowlist is a literal, so it cannot drift into the whole tool registry.
  assert.ok(FAST_TOOLS.size <= 8, "the fast path is a short list, not a second router");
});

test("a fast turn is decided in microseconds, not milliseconds", () => {
  const started = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) for (const item of corpus.items) matchFastIntent(item.text);
  const perCall = Number(process.hrtime.bigint() - started) / 1000 / (200 * corpus.items.length);
  assert.ok(perCall < 1000, `matcher costs ${perCall.toFixed(1)} µs per utterance, expected < 1000`);
});

test("the clock answers without a model call", async () => {
  const before = modelCalls.length;
  const result = await runAgent({ sessionId: "fast-clock", text: "what time is it", channel: "cli" });
  assert.equal(modelCalls.length, before, "a deterministic turn must not reach the model");
  assert.match(result.text, /^It is \d/);
  assert.deepEqual(result.trace.map((t) => t.tool), ["time_now"]);
  assert.equal(result.trace[0].ok, true);
});

test("a reminder is set without a model call", async () => {
  const before = modelCalls.length;
  const result = await runAgent({ sessionId: "fast-remind", text: "remind me to call mom in 20 minutes", channel: "cli" });
  assert.equal(modelCalls.length, before);
  assert.match(result.text, /Reminder set/);
  assert.match(result.text, /call mom/);
  assert.equal(result.trace[0].tool, "remind");
});

test("a task is added without a model call", async () => {
  const before = modelCalls.length;
  const result = await runAgent({ sessionId: "fast-task", text: "add a task to renew the passport", channel: "cli" });
  assert.equal(modelCalls.length, before);
  assert.match(result.text, /Added task: renew the passport/);
});

test("an ambiguous request still goes to the model", async () => {
  const before = modelCalls.length;
  const result = await runAgent({ sessionId: "fast-ambiguous", text: "remember to buy milk", channel: "cli" });
  assert.equal(modelCalls.length, before + 1, "ambiguity must fall through, not guess");
  assert.equal(result.trace.length, 0);
});

test("a fast turn that fails falls through to the model", async () => {
  const before = modelCalls.length;
  // Shaped like a reminder but with a time the tool cannot parse: the honest
  // answer is a question, and only the model can ask it.
  const result = await runAgent({ sessionId: "fast-bad-time", text: "remind me to sleep at 99pm", channel: "cli" });
  assert.equal(modelCalls.length, before + 1, "a failed fast call is not an answer");
  assert.doesNotMatch(result.text, /^remind/i);
});

test("unattended runs never take the fast path", async () => {
  const before = modelCalls.length;
  await runAgent({ sessionId: "fast-unattended", text: "what time is it", channel: "cli", autonomy: "unattended" });
  assert.equal(modelCalls.length, before + 1, "a scheduled run has nobody to correct a wrong guess");
});

test("the fast path is bounded and switchable", () => {
  const long = `${"word ".repeat(MAX_WORDS + 5)}`.trim();
  assert.equal(matchFastIntent(long), null);
  assert.equal(matchFastIntent(""), null);
  assert.equal(matchFastIntent("what time is it\nand also lock the laptop"), null);
});
