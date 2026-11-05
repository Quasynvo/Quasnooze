/**
 * verify.test.js — the fault-injection suite behind `skill-02`.
 *
 * The claim is narrow and checkable: when a tool says it did something, an
 * independent read decides whether it did, and a contradiction cannot be
 * reported to the user as success. So the suite feeds the verifier twenty
 * actions whose *return value is a lie* — a write that never landed, a
 * calculation that does not recompute, a task that is not in the list — and
 * requires every one to be caught.
 *
 * The three states matter as much as the checks:
 *   verified     an independent read agrees
 *   contradicted the world disagrees
 *   unverified   no read-back worth trusting exists
 * A boolean `ok` collapses the last two into one, which is how a system ends up
 * saying "done" about something it never checked.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const workspace = mkdtempSync(join(tmpdir(), "pinch-verify-ws-"));
process.env.PINCH_WORKSPACE = workspace;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-verify-data-"));
process.env.PINCH_AUTO_APPROVE = "true";
process.env.LLM_PROVIDER = "ollama";

// The model endpoint has to exist before src/config.js is imported, because
// config reads the environment once — the same trap the product avoids.
const modelCalls = [];
const modelServer = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  modelCalls.push(body);
  const alreadyCalled = body.messages.some((m) => m.role === "tool");
  const says = (marker) => body.messages.some((m) => typeof m.content === "string" && m.content.includes(marker));
  const toolCall = (name, args) => ({ content: "", tool_calls: [{ function: { name, arguments: args } }] });
  let message = { content: "done" };
  if (!alreadyCalled && says("write-verify-file")) {
    message = toolCall("write_file", { path: "agent.txt", content: "from the agent\n" });
  }
  if (!alreadyCalled && says("lie-about-it")) {
    message = toolCall("__liar", {});
  }
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

const { verifyAction, registerVerifier, VERIFIED, CONTRADICTED, UNVERIFIED } = await import("../src/verify.js");
const { saveTask, remember, addReminder } = await import("../src/store.js");
const { runAgent } = await import("../src/agent.js");
const { registerTool } = await import("../src/tools.js");

const write = (name, content) => {
  writeFileSync(join(workspace, name), content, "utf8");
  return join(workspace, name);
};

/* ─────────────────────────── 20 injected faults ─────────────────────────── */

const cases = [
  // write_file — the return value says "wrote it"; the disk decides.
  {
    name: "write that landed",
    tool: "write_file",
    args: { path: "honest.txt", content: "hello\n" },
    setup: () => write("honest.txt", "hello\n"),
    result: { ok: true, output: "Wrote 6 bytes to honest.txt" },
    expect: VERIFIED,
  },
  {
    name: "write that never happened",
    tool: "write_file",
    args: { path: "missing.txt", content: "hello\n" },
    setup: () => {},
    result: { ok: true, output: "Wrote 6 bytes to missing.txt" },
    expect: CONTRADICTED,
  },
  {
    name: "write whose content differs",
    tool: "write_file",
    args: { path: "drifted.txt", content: "the approved text\n" },
    setup: () => write("drifted.txt", "some other text\n"),
    result: { ok: true, output: "Wrote 17 bytes to drifted.txt" },
    expect: CONTRADICTED,
  },
  {
    name: "write that was truncated",
    tool: "write_file",
    args: { path: "short.txt", content: "0123456789" },
    setup: () => write("short.txt", "01234"),
    result: { ok: true, output: "Wrote 10 bytes to short.txt" },
    expect: CONTRADICTED,
  },
  {
    name: "empty file, written as asked",
    tool: "write_file",
    args: { path: "empty.txt", content: "" },
    setup: () => write("empty.txt", ""),
    result: { ok: true, output: "Wrote 0 bytes to empty.txt" },
    expect: VERIFIED,
  },
  {
    name: "write outside the workspace",
    tool: "write_file",
    args: { path: "../../etc/passwd", content: "x" },
    setup: () => {},
    result: { ok: true, output: "Wrote 1 bytes" },
    // The path policy forbids the write, so the claim "wrote it" is false and
    // the read-back says so rather than shrugging as unverified.
    expect: CONTRADICTED,
  },

  // calculator — recomputation is independent of the tool's own answer.
  {
    name: "sum that recomputes",
    tool: "calculator",
    args: { expression: "2+2" },
    result: { ok: true, output: "2+2 = 4" },
    expect: VERIFIED,
  },
  {
    name: "sum reported wrong",
    tool: "calculator",
    args: { expression: "2+2" },
    result: { ok: true, output: "2+2 = 5" },
    expect: CONTRADICTED,
  },
  {
    name: "sum of different numbers",
    tool: "calculator",
    args: { expression: "1200*1.18" },
    result: { ok: true, output: "1200*1.18 = 1416" },
    expect: VERIFIED,
  },
  {
    name: "float sum, still exact",
    tool: "calculator",
    args: { expression: "0.1+0.2" },
    result: { ok: true, output: "0.1+0.2 = 0.30000000000000004" },
    expect: VERIFIED,
  },
  {
    name: "expression that cannot be recomputed",
    tool: "calculator",
    args: { expression: "2+" },
    result: { ok: true, output: "2+ = 2" },
    expect: UNVERIFIED,
  },

  // add_task — the list is the record, not the reply.
  {
    name: "task that is in the list",
    tool: "add_task",
    args: { title: "renew the passport" },
    setup: () => saveTask({ id: "t1", title: "renew the passport", done: false }),
    result: { ok: true, output: "Added task: renew the passport" },
    expect: VERIFIED,
  },
  {
    name: "task that never landed",
    tool: "add_task",
    args: { title: "pay the electricity bill" },
    setup: () => {},
    result: { ok: true, output: "Added task: pay the electricity bill" },
    expect: CONTRADICTED,
  },
  {
    name: "task whose title was changed",
    tool: "add_task",
    args: { title: "call the landlord" },
    setup: () => saveTask({ id: "t2", title: "call the landlord about the boiler", done: false }),
    result: { ok: true, output: "Added task: call the landlord" },
    expect: CONTRADICTED,
  },
  {
    name: "task already marked done",
    tool: "add_task",
    args: { title: "book the taxi" },
    setup: () => saveTask({ id: "t3", title: "book the taxi", done: true }),
    result: { ok: true, output: "Added task: book the taxi" },
    expect: VERIFIED,
  },

  // remind — a reminder that is not pending is not a reminder.
  {
    name: "reminder that is pending",
    tool: "remind",
    args: { text: "call mom", when: "in 20 minutes" },
    setup: () =>
      addReminder({
        id: "r1",
        text: "call mom",
        at: new Date(Date.now() + 20 * 60000).toISOString(),
        address: "cli",
        channel: "cli",
        fired: false,
        cancelled: false,
      }),
    result: { ok: true, output: "Reminder set for 18:40 (in 20 minutes): \"call mom\"." },
    expect: VERIFIED,
  },
  {
    name: "reminder that was never stored",
    tool: "remind",
    args: { text: "stretch", when: "in 2 hours" },
    setup: () => {},
    result: { ok: true, output: "Reminder set for 20:40 (in 2 hours): \"stretch\"." },
    expect: CONTRADICTED,
  },
  {
    name: "reminder whose text was altered",
    tool: "remind",
    args: { text: "take the bins out", when: "in 1 hour" },
    setup: () =>
      addReminder({
        id: "r2",
        text: "take the recycling out",
        at: new Date(Date.now() + 3600000).toISOString(),
        address: "cli",
        channel: "cli",
        fired: false,
        cancelled: false,
      }),
    result: { ok: true, output: "Reminder set for 21:40 (in 1 hour)." },
    expect: CONTRADICTED,
  },

  // remember — memory is the record of a fact.
  {
    name: "fact that is remembered",
    tool: "remember",
    args: { fact: "the door code is 4411" },
    setup: () => remember("the door code is 4411"),
    result: { ok: true, output: "Remembered: the door code is 4411" },
    expect: VERIFIED,
  },
  {
    name: "fact that was never saved",
    tool: "remember",
    args: { fact: "the wifi password is hunter2" },
    setup: () => {},
    result: { ok: true, output: "Remembered: the wifi password is hunter2" },
    expect: CONTRADICTED,
  },
];

test("twenty injected faults, twenty correct verdicts", async () => {
  const rows = [];
  for (const item of cases) {
    item.setup?.();
    const verdict = await verifyAction(item.tool, item.args, {}, item.result);
    rows.push({ name: item.name, got: verdict?.status, want: item.expect, detail: verdict?.detail });
  }
  const wrong = rows.filter((r) => r.got !== r.want);
  assert.deepEqual(
    wrong,
    [],
    `verdict mismatch:\n${wrong.map((r) => `  ${r.name}: got ${r.got}, want ${r.want} (${r.detail})`).join("\n")}`,
  );
  assert.equal(rows.length, 20);
  // Zero silent wrong successes: every lie in the suite was caught, not passed.
  const silent = rows.filter((r) => r.want === CONTRADICTED && r.got === VERIFIED);
  assert.equal(silent.length, 0);
});

test("the happy path is verified, not merely allowed", async () => {
  const cases = [
    ["write_file", { path: "happy.txt", content: "x" }, () => write("happy.txt", "x"), { ok: true, output: "ok" }],
    ["calculator", { expression: "7*6" }, null, { ok: true, output: "7*6 = 42" }],
  ];
  for (const [tool, args, setup, result] of cases) {
    setup?.();
    const verdict = await verifyAction(tool, args, {}, result);
    assert.equal(verdict.status, VERIFIED, `${tool} should be verified`);
  }
});

test("a failed action is not verified at all", async () => {
  const verdict = await verifyAction("write_file", { path: "x", content: "y" }, {}, { ok: false, output: "boom" });
  assert.equal(verdict, null, "ok:false is already the honest record; there is nothing to read back");
});

test("an unknown tool is unverified, never green", async () => {
  const verdict = await verifyAction("shell", { command: "true" }, {}, { ok: true, output: "" });
  assert.equal(verdict.status, UNVERIFIED);
  assert.match(verdict.detail, /no independent read-back/);
});

test("a verifier that throws reports unverified, not success", async () => {
  registerVerifier("__explodes", () => {
    throw new Error("the read-back itself is broken");
  });
  const verdict = await verifyAction("__explodes", {}, {}, { ok: true, output: "fine" });
  assert.equal(verdict.status, UNVERIFIED);
  assert.match(verdict.detail, /broken/);
});

/* ─────────────────────────── end to end through the agent ──────────────── */

// A tool that claims success and does nothing.// A tool that claims success and does nothing. This is the whole threat model:
// not a malicious tool, an optimistic one.
registerTool({
  name: "__liar",
  description: "claims to have written a file it never touches",
  run: async () => ({ ok: true, output: "Wrote 12 bytes to ghost.txt" }),
});

test("the agent attaches a read-back to every action it reports", async () => {
  const events = [];
  const result = await runAgent({
    sessionId: "verify-e2e",
    text: "write-verify-file",
    channel: "cli",
    onEvent: (e) => events.push(e),
  });
  const entry = result.trace.find((t) => t.tool === "write_file");
  assert.ok(entry, "the write should be in the trace");
  assert.equal(entry.verification.status, VERIFIED);
  assert.equal(readFileSync(join(workspace, "agent.txt"), "utf8"), "from the agent\n");
  const doneEvent = events.find((e) => e.type === "tool_done" && e.name === "write_file");
  assert.equal(doneEvent?.ok, true);
  assert.equal(doneEvent?.verification?.status, VERIFIED);
});

test("a contradicted action reaches the model as a contradiction", async () => {
  const unverifiedEvents = [];
  const result = await runAgent({
    sessionId: "verify-liar",
    text: "lie-about-it",
    channel: "cli",
    onEvent: (e) => unverifiedEvents.push(e),
  });
  const entry = result.trace.find((t) => t.tool === "__liar");
  assert.equal(entry.verification.status, UNVERIFIED);
  const unverifiedDone = unverifiedEvents.find((e) => e.type === "tool_done" && e.name === "__liar");
  assert.equal(unverifiedDone?.ok, true);
  assert.equal(unverifiedDone?.verification?.status, UNVERIFIED);

  // Register a read-back that always disagrees: the tool's claim is checked
  // against something that exists, and the check fails.
  registerVerifier("__liar", async () => ({ status: "contradicted", detail: "ghost.txt does not exist" }));
  const contradictedEvents = [];
  const second = await runAgent({
    sessionId: "verify-liar-2",
    text: "lie-about-it",
    channel: "cli",
    onEvent: (e) => contradictedEvents.push(e),
  });
  const secondEntry = second.trace.find((t) => t.tool === "__liar");
  assert.equal(secondEntry.verification.status, CONTRADICTED, "the read-back decides, not the tool");
  const contradictedDone = contradictedEvents.find((e) => e.type === "tool_done" && e.name === "__liar");
  assert.equal(contradictedDone?.ok, false, "contradicted tool_done must never mark ok:true for UI checkmarks");
  assert.equal(contradictedDone?.verification?.status, CONTRADICTED);
  assert.match(contradictedDone?.preview || "", /contradicted/);

  const toolMessage = modelCalls
    .flatMap((call) => call.messages)
    .filter((m) => m.role === "tool" && m.content.includes("ghost.txt"));
  assert.ok(
    toolMessage.some((m) => m.content.includes("[verification: contradicted")),
    "the model is told the action was contradicted, so it cannot describe it as done",
  );
  assert.match(second.text, /could not be confirmed by an independent read-back/);
});

test("verification is cheap enough to run on every action", async () => {
  const samples = [];
  for (let i = 0; i < 20; i++) {
    write("cheap.txt", "x");
    const started = process.hrtime.bigint();
    await verifyAction("write_file", { path: "cheap.txt", content: "x" }, {}, { ok: true, output: "ok" });
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const p95 = samples[Math.floor(samples.length * 0.95)];
  assert.ok(p95 < 50, `p95 read-back cost ${p95.toFixed(2)} ms, contract allows 50 ms`);
});
