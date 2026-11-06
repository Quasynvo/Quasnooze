import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "quasnooze-typed-input-"));
process.env.PINCH_WORKSPACE = root;
process.env.PINCH_DATA = join(root, "data");
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_AUTO_APPROVE = "true"; // type_text must ignore this deliberately.
after(async () => { await rm(root, { recursive: true, force: true }); });

const { desktop, DesktopRuntime } = await import("../src/desktop.js");
const { TOOL_MAP, describeBuiltinTools } = await import("../src/tools.js");
const { buildActionPreview } = await import("../src/action-preview.js");
const { classifyToolAction, ACT } = await import("../src/risk.js");
const { runAgent, answerApproval } = await import("../src/agent.js");
const { brain } = await import("../src/brain.js");
const { startWindowsCompanion } = await import("../src/windows-companion.js");

const tool = TOOL_MAP.get("type_text");
const target = { handle: "1002", title: "notes - Notepad", process: "notepad.exe" };

function fakeBridge(handler) {
  const calls = [];
  return {
    calls,
    send() {},
    os: async (payload, opts) => { calls.push(payload); return handler(payload, opts); },
  };
}

test("dry run captures the actual foreground target and preview counts text without typing", async () => {
  const bridge = fakeBridge((payload) => {
    assert.equal(payload.kind, "preview_type_text");
    assert.equal(payload.text, "hello\nworld");
    assert.equal(payload.expectedWindowTitle, target.title);
    return { ...target, dryRun: true, keystrokes: 11, delayMs: 20 };
  });
  desktop.attach(bridge);
  try {
    const preparation = await tool.prepare({ text: "hello\nworld", expected_window_title: target.title });
    assert.deepEqual(preparation.target, target);
    const preview = buildActionPreview("type_text", { text: "hello\nworld" }, { preparation });
    assert.match(preview.target, /notes - Notepad — notepad.exe/);
    assert.match(preview.effectSummary, /11 UTF-16 characters total/);
    assert.match(preview.effectSummary, /hello\\nworld/);
    assert.match(preview.effectSummary, /Dry run sent nothing/);
    assert.deepEqual(bridge.calls.map(c => c.kind), ["preview_type_text"]);
  } finally { desktop.detach(); }
});

test("long previews truncate text while retaining its full character count", async () => {
  const text = "x".repeat(500);
  desktop.attach(fakeBridge(() => ({ ...target, keystrokes: 500, delayMs: 20 })));
  try {
    const preparation = await tool.prepare({ text });
    const preview = buildActionPreview("type_text", { text }, { preparation });
    assert.match(preview.effectSummary, /500 UTF-16 characters total/);
    assert.ok(preview.effectSummary.includes("…"));
    assert.ok(preview.effectSummary.length <= 320);
  } finally { desktop.detach(); }
});

test("invalid input and credential-field refusals never request execution", async () => {
  for (const text of ["", "x".repeat(4001)]) {
    await assert.rejects(tool.prepare({ text }), err => err.code === "BAD_TEXT");
  }
  desktop.attach(fakeBridge(() => {
    const err = new Error("The focused field looks like a password or credential field.");
    err.code = "CREDENTIAL_FIELD";
    throw err;
  }));
  try {
    await assert.rejects(tool.prepare({ text: "secret" }), err => err.code === "CREDENTIAL_FIELD" && /refused/.test(err.message) && /No approval/.test(err.message));
    assert.equal(desktop.bridge.calls.length, 1);
  } finally { desktop.detach(); }
});

test("execution uses only the approved native snapshot and reports host counts", async () => {
  const bridge = fakeBridge((payload) => {
    if (payload.kind === "preview_type_text") return { ...target, keystrokes: 5, delayMs: 20 };
    assert.equal(payload.kind, "type_text");
    assert.equal(payload.handle, target.handle);
    assert.equal(payload.approvedTitle, target.title);
    assert.equal(payload.approvedProcess, target.process);
    assert.equal(payload.text, "hello");
    return { ...target, sent: 5, keystrokes: 5 };
  });
  desktop.attach(bridge);
  try {
    const actionPreparation = await tool.prepare({ text: "hello" });
    const result = await tool.run({ text: "hello", handle: "attacker", approvedTitle: "attacker" }, { actionPreparation });
    assert.equal(result.ok, true);
    assert.match(result.output, /Typed 5 of 5/);
    const missing = await tool.run({ text: "hello" });
    assert.equal(missing.ok, false);
    assert.match(missing.output, /dry-run snapshot/);
  } finally { desktop.detach(); }
});

test("aborted and focus-changed sends report exactly how much was sent", async () => {
  for (const [code, sent] of [["ABORTED", 2], ["TARGET_CHANGED", 3]]) {
    desktop.attach(fakeBridge((payload) => {
      if (payload.kind === "preview_type_text") return { ...target, keystrokes: 5, delayMs: 20 };
      const err = new Error(code === "ABORTED" ? "Typing was aborted." : "The foreground window changed during typing.");
      err.code = code;
      err.data = { ...target, sent, keystrokes: 5 };
      throw err;
    }));
    try {
      const actionPreparation = await tool.prepare({ text: "hello" });
      const result = await tool.run({ text: "hello" }, { actionPreparation });
      assert.equal(result.ok, false);
      assert.match(result.output, new RegExp(`Sent ${sent} of 5`));
      assert.match(result.output, /no further characters/);
    } finally { desktop.detach(); }
  }
});

test("risk and inventory keep type_text at act with fresh approval under auto-approve", () => {
  assert.deepEqual(classifyToolAction("type_text"), {
    tier: ACT,
    why: "typed input can submit forms or trigger shortcuts and always needs fresh approval",
    freshApproval: true,
  });
  const described = describeBuiltinTools({ autoApprove: true }).find(t => t.name === "type_text");
  assert.equal(described.effectiveInteractivePolicy, "fresh-approval-required");
  assert.equal(described.unattendedPolicy, "refused");
});

test("agent denial sends nothing and auto-approve cannot suppress the prompt", async () => {
  const original = brain.chat;
  let round = 0, executions = 0, approvals = 0;
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "preview_type_text") return { ...target, keystrokes: 5, delayMs: 20 };
    executions++;
    return { ...target, sent: 5, keystrokes: 5 };
  }));
  brain.chat = async () => round++ === 0
    ? { content: "", toolCalls: [{ id: "type-denied", name: "type_text", arguments: { text: "hello" } }] }
    : { content: "Done", toolCalls: [] };
  try {
    const result = await runAgent({ sessionId: "type-denied", channel: "web", text: "type hello", onEvent(event) {
      if (event.type !== "approval") return;
      approvals++;
      assert.match(event.preview.target, /notes - Notepad/);
      answerApproval(event.id, false);
    } });
    assert.equal(approvals, 1);
    assert.equal(executions, 0);
    assert.equal(result.trace[0].denied, true);
  } finally { brain.chat = original; desktop.detach(); }
});

test("an approval that times out sends nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = brain.chat;
  let round = 0, executions = 0;
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "preview_type_text") return { ...target, keystrokes: 5, delayMs: 20 };
    executions++;
    return { ...target, sent: 5, keystrokes: 5 };
  }));
  brain.chat = async () => round++ === 0
    ? { content: "", toolCalls: [{ id: "type-timeout", name: "type_text", arguments: { text: "hello" } }] }
    : { content: "Done", toolCalls: [] };
  try {
    const result = await runAgent({ sessionId: "type-timeout", channel: "web", text: "type hello", onEvent(event) {
      if (event.type === "approval") t.mock.timers.tick(10 * 60 * 1000 + 1);
    } });
    assert.equal(executions, 0);
    assert.equal(result.trace[0].denied, true);
  } finally { brain.chat = original; desktop.detach(); }
});

test("agent approval executes the same dry-run snapshot once", async () => {
  const original = brain.chat;
  let round = 0, executions = 0;
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "preview_type_text") return { ...target, keystrokes: 5, delayMs: 20 };
    executions++;
    assert.equal(payload.handle, target.handle);
    return { ...target, sent: 5, keystrokes: 5 };
  }));
  brain.chat = async () => round++ === 0
    ? { content: "", toolCalls: [{ id: "type-allowed", name: "type_text", arguments: { text: "hello" } }] }
    : { content: "Done", toolCalls: [] };
  try {
    const result = await runAgent({ sessionId: "type-allowed", channel: "web", text: "type hello", onEvent(event) {
      if (event.type === "approval") answerApproval(event.id, true);
    } });
    assert.equal(executions, 1);
    assert.equal(result.trace[0].ok, true);
  } finally { brain.chat = original; desktop.detach(); }
});

test("bridge abort interrupts the pending native send and waits for its sent-count reply", async () => {
  const children = [];
  const runtime = new DesktopRuntime();
  const host = startWindowsCompanion({
    platform: "win32", runtime, log: { warn() {} }, onQuit() {},
    spawnChild() {
      const child = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.stdin.writable = true;
      child.messages = [];
      child.stdin.write = line => { child.messages.push(JSON.parse(line)); return true; };
      child.stdin.end = child.stdin.write;
      child.kill = () => child.emit("exit", 1);
      child.event = event => child.stdout.emit("data", Buffer.from(JSON.stringify(event) + "\n"));
      children.push(child); return child;
    },
  });
  const child = children[0];
  child.event({ type: "ready" });
  const controller = new AbortController();
  const pending = runtime.typeText("hello", target, { signal: controller.signal });
  const request = child.messages.find(m => m.op === "os" && m.kind === "type_text");
  controller.abort();
  assert.ok(child.messages.some(m => m.op === "abort_type" && m.id === request.id));
  child.event({ type: "result", id: request.id, ok: false, code: "ABORTED", text: "Typing was aborted. Sent 2 of 5.", data: { sent: 2, keystrokes: 5 } });
  await assert.rejects(pending, err => err.code === "ABORTED" && err.data.sent === 2);
  host.stop();
});

test("native host uses Unicode SendInput, credential inspection, focus checks and immediate abort", () => {
  const cs = readFileSync(new URL("../desktop/Companion.cs", import.meta.url), "utf8");
  for (const needle of ["SendInput", "KEYEVENTF_UNICODE", "AutomationElement.IsPasswordProperty", "GetForegroundWindow", "abort_type", "AbortId == id", "Thread.Sleep(DelayMs)", 'case "preview_type_text"', 'case "type_text"']) {
    assert.ok(cs.includes(needle), `missing native safeguard: ${needle}`);
  }
  assert.match(cs, /if \(!\(raw is bool\)\) throw new QuasnoozeWindows\.OsFailure\("FIELD_UNKNOWN"/);
  assert.match(cs, /if \(SendInput\(2, inputs, Marshal\.SizeOf\(typeof\(INPUT\)\)\) != 2\)/);
  assert.ok(cs.indexOf('op") == "abort_type"') < cs.indexOf("Post(() => Receive(copy))"), "abort must be handled before the UI queue");
});
