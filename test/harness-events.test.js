/**
 * harness-events.test.js — deterministic action lifecycle policy pipeline tests.
 *
 * Verifies:
 *  1. Exact lifecycle order: validate -> deterministic policy -> existing user
 *     approval -> execute -> bounded after event.
 *  2. Monotonic policy lattice: handlers may ask or deny, never convert denial
 *     into authorization or suppress validation, risk screen, unattended gates,
 *     or interactive session approval.
 *  3. Structural commit gating across shell chains/wrappers and commit tools.
 *  4. Fail-closed errors, rejections, timeouts, invalid return shapes,
 *     AbortSignal cancellations, and unattended turns never execute actions.
 *  5. Observational callbacks (afterTool, beforeContextTrim) cannot alter
 *     execution results or context trimming.
 *  6. Unconfigured mode preserves baseline behavior; zero credentials, raw
 *     prompts, commit messages, or tool outputs are emitted or written to disk;
 *     zero runtime dependencies or external hooks are accepted.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "quasnooze-harness-test-"));
const workspace = join(scratch, "workspace");
const dataDir = join(scratch, "data");

const CANARY_OPENAI_KEY = "sk-harnesscanarysecret9876543210";
const CANARY_AUTH_KEY = "qh_auth_secret_token_99887766";

let scriptedResponses = [];
const modelRequests = [];

const fakeOllama = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    if (req.url === "/api/tags") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "harness-fake:latest" }] }));
      return;
    }
    const body = raw ? JSON.parse(raw) : {};
    modelRequests.push({ url: req.url, body });
    const next = scriptedResponses.shift() || { content: "Done." };
    const message = {
      role: "assistant",
      content: next.content ?? "",
      ...(next.toolCalls ? { tool_calls: next.toolCalls } : {}),
    };
    if (body.stream) {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(`${JSON.stringify({ message, done: true })}\n`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ message, done: true }));
  });
});

await new Promise((resolve) => fakeOllama.listen(0, "127.0.0.1", resolve));
const { port } = fakeOllama.address();

process.env.QUASNOOZE_WORKSPACE = workspace;
process.env.QUASNOOZE_DATA = dataDir;
process.env.QUASNOOZE_GUARD = "off";
process.env.QUASNOOZE_AUTO_APPROVE = "false";
process.env.QUASNOOZE_HARNESS_EVENTS = "off";
process.env.QUASNOOZE_NUM_CTX = "768";
process.env.QUASNOOZE_NUM_PREDICT = "128";
process.env.QUASNOOZE_KEY = CANARY_AUTH_KEY;
process.env.OPENAI_API_KEY = CANARY_OPENAI_KEY;
process.env.LLM_PROVIDER = "ollama";
process.env.OLLAMA_MODEL = "harness-fake:latest";
process.env.OLLAMA_URL = `http://127.0.0.1:${port}`;

const { mkdirSync } = await import("node:fs");
mkdirSync(workspace, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const { runAgent, answerApproval, pendingApprovalsFor } = await import("../src/agent.js");
const { appendMessage } = await import("../src/store.js");
const { registerTool } = await import("../src/tools.js");
const {
  BUILTIN_POLICY_RULES,
  EVENT_TYPES,
  HarnessConfigError,
  POLICY_DECISIONS,
  createHarnessPipeline,
  isHarnessPipeline,
  redactHarnessText,
  resolveHarnessPipeline,
} = await import("../src/harness/events.js");

const executedFakeCalls = [];

before(() => {
  registerTool(
    {
      name: "fake_safe_probe",
      dangerous: false,
      description: "Deterministic non-dangerous test tool.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Probe query" },
        },
        required: ["query"],
      },
      async run(args) {
        executedFakeCalls.push({ tool: "fake_safe_probe", args });
        return { ok: true, output: `SENSITIVE_TOOL_STDOUT_CANARY:${args.query}` };
      },
    },
    { dangerous: false },
  );

  registerTool(
    {
      name: "fake_danger_action",
      dangerous: true,
      description: "Deterministic dangerous test tool requiring approval.",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "Target label" },
          secretToken: { type: "string", description: "Optional credential" },
        },
        required: ["target"],
      },
      async run(args) {
        executedFakeCalls.push({ tool: "fake_danger_action", args });
        return { ok: true, output: `APPLIED_DANGER_CANARY:${args.target}` };
      },
    },
    { dangerous: true },
  );

  // Deliberately registered with dangerous:false to prove structural commit
  // recognition still gates commit tools through beforeCommit & session approval.
  registerTool(
    {
      name: "git_commit",
      dangerous: false,
      description: "Fake structured commit tool.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
          noVerify: { type: "boolean", description: "Skip hooks" },
          amend: { type: "boolean", description: "Amend previous commit" },
        },
        required: ["message"],
      },
      async run(args) {
        executedFakeCalls.push({ tool: "git_commit", args });
        return { ok: true, output: "COMMIT_EXECUTED_CANARY" };
      },
    },
    { dangerous: false },
  );
});

after(async () => {
  await new Promise((resolve) => fakeOllama.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
});

function scriptToolTurn(name, args, finalReply = "Completed.") {
  scriptedResponses = [
    {
      content: "",
      toolCalls: [{ function: { name, arguments: args } }],
    },
    {
      content: finalReply,
    },
  ];
}

test("unconfigured mode preserves baseline behavior for safe, fast-path, and dangerous tools", async () => {
  executedFakeCalls.length = 0;

  assert.equal(resolveHarnessPipeline(undefined, "off"), null);

  // Fast-path turn runs unchanged with harness disabled.
  const fast = await runAgent({ sessionId: "unconfigured-fast", text: "what time is it" });
  assert.equal(fast.trace[0]?.tool, "time_now");
  assert.equal(fast.trace[0]?.ok, true);

  // Safe tool runs without approval prompt when unconfigured.
  scriptToolTurn("fake_safe_probe", { query: "baseline" }, "Probe finished.");
  const events = [];
  const safeTurn = await runAgent({
    sessionId: "unconfigured-safe",
    text: "run safe probe",
    onEvent: (e) => events.push(e),
  });
  assert.equal(executedFakeCalls.length, 1);
  assert.equal(events.some((e) => e.type === "approval"), false);
  assert.equal(safeTurn.trace[0]?.ok, true);

  // Dangerous tool still asks and does not execute when user denies.
  executedFakeCalls.length = 0;
  scriptToolTurn("fake_danger_action", { target: "prod" }, "Stopped.");
  const denyTurn = await runAgent({
    sessionId: "unconfigured-deny",
    text: "apply dangerous change",
    onEvent(e) {
      if (e.type === "approval") answerApproval(e.id, false);
    },
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(denyTurn.trace[0]?.denied, true);
});

test("enforces exact order validate -> beforeTool -> approval -> execute -> afterTool", async () => {
  executedFakeCalls.length = 0;
  const order = [];

  const harness = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        (event) => {
          order.push(`beforeTool:${event.tool.name}`);
          return { decision: POLICY_DECISIONS.CONTINUE };
        },
      ],
    },
    observers: {
      afterTool: [
        (event) => {
          order.push(`afterTool:${event.tool.name}:${event.ok}`);
        },
      ],
    },
  });
  assert.equal(isHarnessPipeline(harness), true);

  // 1. Invalid arguments fail at validate BEFORE beforeTool, approval, execute, or afterTool.
  scriptedResponses = [
    {
      content: "",
      toolCalls: [{ function: { name: "fake_danger_action", arguments: { unknownField: 123 } } }],
    },
    { content: "Validation failed as expected." },
  ];
  const invalidTurn = await runAgent({
    sessionId: "order-invalid",
    text: "call tool with invalid schema args",
    harness,
    onEvent(e) {
      if (e.type === "approval") order.push("approval");
    },
  });
  assert.equal(invalidTurn.trace[0]?.invalid, true);
  assert.deepEqual(order, []);
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(
    harness.events().filter((e) => e.type !== EVENT_TYPES.BEFORE_CONTEXT_TRIM).length,
    0,
  );

  // 2. Valid dangerous tool runs in exact lifecycle order.
  const targetFile = join(workspace, "lifecycle-order.txt");
  scriptToolTurn("write_file", { path: "lifecycle-order.txt", content: "hello harness" }, "Wrote file.");
  const validTurn = await runAgent({
    sessionId: "order-valid",
    text: "create lifecycle-order.txt",
    harness,
    onEvent(e) {
      if (e.type === "approval") {
        order.push("approval");
        assert.equal(existsSync(targetFile), false, "file must not exist before approval resolves");
        answerApproval(e.id, true);
      }
      if (e.type === "tool") {
        order.push(`execute:${e.name}`);
      }
    },
  });

  assert.equal(validTurn.trace[0]?.ok, true);
  assert.equal(readFileSync(targetFile, "utf8"), "hello harness");
  assert.deepEqual(order, [
    "beforeTool:write_file",
    "approval",
    "execute:write_file",
    "afterTool:write_file:true",
  ]);
});

test("a policy handler returning allow cannot convert denial into authorization or bypass user approval", async () => {
  executedFakeCalls.length = 0;

  // 1. Earlier policy deny + later "allow" check stays deny.
  const denyThenAllow = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        () => ({ decision: "deny", reason: "blocked-by-policy" }),
        () => ({ decision: "allow", allow: true, bypassApproval: true }),
      ],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "should-not-run" }, "Denied.");
  const deniedByPolicy = await runAgent({
    sessionId: "monotonic-deny",
    text: "probe",
    harness: denyThenAllow,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(deniedByPolicy.trace[0]?.denied, true);
  assert.equal(deniedByPolicy.trace[0]?.reason, "blocked-by-policy");

  // 2. Handler returning { decision: "allow", bypassApproval: true } CANNOT suppress user denial!
  let approvalRaised = false;
  const allowAttempt = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        () => ({ decision: "allow", allow: true, autoApprove: true, bypassApproval: true }),
      ],
    },
  });
  scriptToolTurn("fake_danger_action", { target: "critical" }, "User denied.");
  const userDenied = await runAgent({
    sessionId: "allow-cannot-bypass-user",
    text: "do dangerous thing",
    harness: allowAttempt,
    onEvent(e) {
      if (e.type === "approval") {
        approvalRaised = true;
        answerApproval(e.id, false);
      }
    },
  });
  assert.equal(approvalRaised, true, "existing session approval must still be raised");
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(userDenied.trace[0]?.denied, true);

  // 3. Handler returning "allow" CANNOT bypass catastrophic command screen.
  scriptToolTurn("shell", { command: "rm -rf /" }, "Refused.");
  const screenDenied = await runAgent({
    sessionId: "allow-cannot-bypass-screen",
    text: "run catastrophic shell command",
    harness: allowAttempt,
  });
  assert.equal(screenDenied.trace[0]?.denied, true);
  assert.equal(screenDenied.trace[0]?.tier, "blocked");

  // 4. Handler returning "ask" CAN escalate an otherwise unprompted safe tool.
  let safeAsked = false;
  const escalateSafe = createHarnessPipeline({
    policyChecks: {
      beforeTool: [() => "ask", () => "allow"],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "escalated" }, "Denied by user.");
  await runAgent({
    sessionId: "ask-escalates-safe",
    text: "run safe probe with policy ask",
    harness: escalateSafe,
    onEvent(e) {
      if (e.type === "approval") {
        safeAsked = true;
        answerApproval(e.id, false);
      }
    },
  });
  assert.equal(safeAsked, true);
  assert.equal(executedFakeCalls.length, 0);
});

test("structural commit proposals trigger beforeCommit and never execute without approval or when unattended", async () => {
  executedFakeCalls.length = 0;
  const stages = [];

  const harness = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        (ev) => {
          stages.push(`beforeTool:${ev.tool.name}:isCommit=${ev.isCommit}`);
          return "allow"; // Ignored authorization attempt must not bypass commit gate.
        },
      ],
      beforeCommit: [
        (ev) => {
          stages.push(`beforeCommit:${ev.commit.vcs}:${ev.commit.subcommand}`);
          return "allow"; // Minimum decision for beforeCommit remains "ask" (or "deny" unattended).
        },
      ],
    },
    observers: {
      afterTool: [(ev) => stages.push(`afterTool:${ev.tool.name}`)],
    },
  });

  // 1. Structured git_commit tool (even registered dangerous:false) asks and blocks on user denial.
  let commitAsked = false;
  scriptToolTurn("git_commit", { message: "SECRET_COMMIT_MESSAGE_CANARY" }, "Not committed.");
  const interactiveDenied = await runAgent({
    sessionId: "commit-tool-deny",
    text: "commit staged work",
    harness,
    onEvent(e) {
      if (e.type === "approval") {
        commitAsked = true;
        stages.push("approval:denied");
        answerApproval(e.id, false);
      }
    },
  });
  assert.equal(commitAsked, true);
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(interactiveDenied.trace[0]?.denied, true);
  assert.deepEqual(stages, [
    "beforeTool:git_commit:isCommit=true",
    "beforeCommit:git:commit",
    "approval:denied",
  ]);

  // 2. Unattended commit attempt (wrapped shell git commit) never executes and raises no approval.
  stages.length = 0;
  let unattendedAsked = false;
  scriptToolTurn(
    "shell",
    { command: "sh -c 'echo should_not_run > committed.txt && git commit -m msg'" },
    "Unattended refused.",
  );
  const unattendedCommit = await runAgent({
    sessionId: "commit-unattended",
    text: "scheduled commit attempt",
    autonomy: "unattended",
    harness,
    onEvent(e) {
      if (e.type === "approval") unattendedAsked = true;
    },
  });
  assert.equal(unattendedAsked, false);
  assert.equal(existsSync(join(workspace, "committed.txt")), false);
  assert.equal(unattendedCommit.trace[0]?.denied, true);
  assert.equal(unattendedCommit.trace[0]?.reason, "unattended");

  // 3. Strict profile denies --no-verify commits before prompting the user.
  let strictAsked = false;
  const strictHarness = createHarnessPipeline({ profile: "strict" });
  scriptToolTurn("git_commit", { message: "bypass hooks", noVerify: true }, "Strict denied.");
  const strictRes = await runAgent({
    sessionId: "commit-strict-noverify",
    text: "commit skipping hooks",
    harness: strictHarness,
    onEvent(e) {
      if (e.type === "approval") strictAsked = true;
    },
  });
  assert.equal(strictAsked, false);
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(strictRes.trace[0]?.denied, true);
  assert.equal(strictRes.trace[0]?.reason, "commit-hook-bypass-denied");
});

test("handler failures, timeouts, invalid return shapes, cancellations, and unattended actions fail closed", async () => {
  executedFakeCalls.length = 0;

  // 1. Synchronous throw in beforeTool fails closed.
  const syncThrowHarness = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        () => {
          throw new Error("boom in policy check");
        },
      ],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "throw-case" }, "Failed closed.");
  const throwTurn = await runAgent({
    sessionId: "fail-closed-throw",
    text: "run probe",
    harness: syncThrowHarness,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(throwTurn.trace[0]?.denied, true);
  assert.equal(throwTurn.trace[0]?.failedClosed, true);

  // 2. Async rejection in beforeCommit fails closed.
  const asyncRejectHarness = createHarnessPipeline({
    policyChecks: {
      beforeCommit: [async () => Promise.reject(new Error("commit policy crashed"))],
    },
  });
  scriptToolTurn("git_commit", { message: "attempt" }, "Commit failed closed.");
  const rejectTurn = await runAgent({
    sessionId: "fail-closed-reject",
    text: "commit work",
    harness: asyncRejectHarness,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(rejectTurn.trace[0]?.denied, true);
  assert.equal(rejectTurn.trace[0]?.failedClosed, true);

  // 3. Policy timeout fails closed without executing tool.
  const timeoutHarness = createHarnessPipeline({
    timeoutMs: 25,
    policyChecks: {
      beforeTool: [() => new Promise((resolve) => setTimeout(() => resolve("continue"), 200))],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "timeout-case" }, "Timed out.");
  const timeoutTurn = await runAgent({
    sessionId: "fail-closed-timeout",
    text: "run slow policy",
    harness: timeoutHarness,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(timeoutTurn.trace[0]?.denied, true);
  assert.equal(timeoutTurn.trace[0]?.failedClosed, true);
  assert.match(String(timeoutTurn.trace[0]?.reason), /^policy-timeout:/);

  // 4. Invalid handler return shape fails closed.
  const invalidReturnHarness = createHarnessPipeline({
    policyChecks: {
      beforeTool: [() => ({ unexpected: true })],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "invalid-shape" }, "Invalid decision.");
  const invalidShapeTurn = await runAgent({
    sessionId: "fail-closed-shape",
    text: "run probe",
    harness: invalidReturnHarness,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(invalidShapeTurn.trace[0]?.failedClosed, true);

  // 5. Cancellation while awaiting approval cleans up pending approval and never executes.
  const abortDuringApproval = new AbortController();
  const stdHarness = createHarnessPipeline({ profile: "standard" });
  scriptToolTurn("git_commit", { message: "abort-while-pending" }, "Aborted.");
  const cancelledTurn = await runAgent({
    sessionId: "cancel-during-approval",
    text: "commit pending cancellation",
    harness: stdHarness,
    signal: abortDuringApproval.signal,
    onEvent(e) {
      if (e.type === "approval") {
        assert.equal(pendingApprovalsFor("cancel-during-approval").length, 1);
        abortDuringApproval.abort();
      }
    },
  });
  assert.equal(pendingApprovalsFor("cancel-during-approval").length, 0);
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(cancelledTurn.trace[0]?.cancelled, true);
  assert.equal(cancelledTurn.trace[0]?.denied, true);

  // 6. Cancellation mid-beforeTool check fails closed and never executes.
  const abortMidPolicy = new AbortController();
  const midCancelHarness = createHarnessPipeline({
    timeoutMs: 500,
    policyChecks: {
      beforeTool: [
        async () => {
          abortMidPolicy.abort();
          await new Promise((r) => setTimeout(r, 20));
          return "continue";
        },
      ],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "abort-mid-policy" }, "Aborted.");
  const midCancelled = await runAgent({
    sessionId: "cancel-mid-policy",
    text: "run probe and cancel",
    harness: midCancelHarness,
    signal: abortMidPolicy.signal,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(midCancelled.trace[0]?.cancelled, true);

  // 7. Unattended action escalated to "ask" by policy refuses cleanly without running.
  const askPolicy = createHarnessPipeline({
    policyChecks: {
      beforeTool: [() => ({ decision: "ask", reason: "needs-review" })],
    },
  });
  scriptToolTurn("fake_safe_probe", { query: "unattended-ask" }, "Unattended refused.");
  const unattendedAsk = await runAgent({
    sessionId: "unattended-policy-ask",
    text: "run unattended probe",
    autonomy: "unattended",
    harness: askPolicy,
  });
  assert.equal(executedFakeCalls.length, 0);
  assert.equal(unattendedAsk.trace[0]?.denied, true);
  assert.equal(unattendedAsk.trace[0]?.reason, "unattended");
});

test("observational afterTool and beforeContextTrim callbacks are frozen, redacted, and cannot alter actions", async () => {
  executedFakeCalls.length = 0;
  const trimEvents = [];
  const afterEvents = [];

  const harness = createHarnessPipeline({
    timeoutMs: 40,
    observers: {
      afterTool: [
        (ev) => {
          afterEvents.push(ev);
          assert.throws(() => {
            ev.ok = false;
          }, TypeError);
          throw new Error("observer failure must be isolated");
        },
        () => ({ ok: false, output: "MUTATED_BY_OBSERVER" }),
      ],
      beforeContextTrim: [
        (ev) => {
          trimEvents.push(ev);
          assert.throws(() => {
            ev.keptMessages = 0;
          }, TypeError);
          throw new Error("trim observer failure must be isolated");
        },
      ],
    },
  });

  // Seed enough history to exceed QUASNOOZE_NUM_CTX=768 so fit() trims older messages.
  for (let i = 0; i < 16; i += 1) {
    appendMessage("trim-session", {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `HISTORICAL_PROMPT_SECRET_${i} ` + "context filler words ".repeat(35),
    });
  }

  scriptToolTurn("fake_safe_probe", { query: "check-isolation" }, "Final unaffected answer.");
  const beforeDataFiles = new Set(readdirSync(dataDir));

  const res = await runAgent({
    sessionId: "trim-session",
    text: `TOP_SECRET_USER_PROMPT_CANARY please probe with ${CANARY_OPENAI_KEY}`,
    harness,
  });

  assert.equal(executedFakeCalls.length, 1);
  assert.equal(res.trace[0]?.ok, true);
  assert.match(res.trace[0]?.output || "", /SENSITIVE_TOOL_STDOUT_CANARY:check-isolation/);
  assert.equal(res.text, "Final unaffected answer.");

  assert.ok(trimEvents.length >= 1, "expected beforeContextTrim event when history overflows window");
  assert.equal(trimEvents[0].type, EVENT_TYPES.BEFORE_CONTEXT_TRIM);
  assert.ok(trimEvents[0].droppedMessages > 0);
  assert.ok(trimEvents[0].keptMessages < trimEvents[0].totalMessages);
  assert.equal(trimEvents[0].promptsWithheld, true);

  assert.equal(afterEvents.length, 1);
  assert.equal(afterEvents[0].type, EVENT_TYPES.AFTER_TOOL);
  assert.equal(afterEvents[0].outputWithheld, true);
  assert.ok(afterEvents[0].outputBytes > 0);
  assert.equal("output" in afterEvents[0], false);

  // Verify no credentials, raw prompts, file bodies, commit messages, or tool stdout appear in events.
  writeFileSync(join(workspace, "secret-note.txt"), "initial");
  scriptToolTurn(
    "write_file",
    {
      path: `secret-note.txt`,
      content: `PRIVATE_FILE_BODY_CANARY token=${CANARY_OPENAI_KEY} auth=${CANARY_AUTH_KEY}`,
    },
    "Saved.",
  );
  await runAgent({
    sessionId: "redaction-session",
    text: "RAW_USER_PROMPT_DO_NOT_RECORD",
    harness,
    onEvent(e) {
      if (e.type === "approval") answerApproval(e.id, true);
    },
  });

  const serializedEvents = JSON.stringify(harness.events());
  for (const forbidden of [
    CANARY_OPENAI_KEY,
    CANARY_AUTH_KEY,
    "TOP_SECRET_USER_PROMPT_CANARY",
    "HISTORICAL_PROMPT_SECRET_",
    "RAW_USER_PROMPT_DO_NOT_RECORD",
    "SENSITIVE_TOOL_STDOUT_CANARY",
    "PRIVATE_FILE_BODY_CANARY",
  ]) {
    assert.equal(
      serializedEvents.includes(forbidden),
      false,
      `harness event ledger must not contain ${forbidden}`,
    );
  }

  const redactedSample = redactHarnessText(
    `Bearer ${CANARY_OPENAI_KEY} https://user:s3cr3t@example.com/hook?api_key=mysecret123 --token supersecret99`,
  );
  assert.equal(redactedSample.includes(CANARY_OPENAI_KEY), false);
  assert.equal(redactedSample.includes("s3cr3t"), false);
  assert.equal(redactedSample.includes("mysecret123"), false);
  assert.equal(redactedSample.includes("supersecret99"), false);

  // No harness event log file is written to disk by default (only session JSON & telemetry.ndjson exist).
  const afterDataFiles = readdirSync(dataDir);
  for (const name of afterDataFiles) {
    if (!beforeDataFiles.has(name)) {
      assert.ok(
        name === "sessions" || name === "telemetry.ndjson",
        `unexpected file written by default: ${name}`,
      );
    }
  }
});

test("rejects external shell/network/plugin hooks, arbitrary runAgent callbacks, and preserves zero runtime deps", async () => {
  for (const badOption of [
    { command: "sh -c echo" },
    { shell: "/bin/sh" },
    { url: "https://evil.example/webhook" },
    { webhook: "https://evil.example/hook" },
    { plugin: "./custom-hook.js" },
    { module: "some-package" },
    { allow: true },
    { bypassApproval: true },
    { rules: ["non-existent-rule"] },
    { policyChecks: { afterTool: [() => "deny"] } },
    { policyChecks: { beforeContextTrim: [() => "deny"] } },
    { policyChecks: { beforeTool: [{ command: "id" }] } },
    { observers: { afterTool: [{ url: "https://evil.example" }] } },
  ]) {
    assert.throws(() => createHarnessPipeline(badOption), HarnessConfigError);
  }

  // Unbranded callback objects passed directly to runAgent are rejected.
  await assert.rejects(
    () =>
      runAgent({
        sessionId: "reject-unbranded",
        text: "hello",
        harness: { beforeTool: () => "continue" },
      }),
    HarnessConfigError,
  );

  // Built-in rule registry is frozen and non-empty; package.json has zero runtime dependencies.
  assert.equal(Object.isFrozen(BUILTIN_POLICY_RULES), true);
  assert.ok(Object.keys(BUILTIN_POLICY_RULES).length >= 4);

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.dependencies || {}, {});
});

test("fast-path turns enforce beforeTool -> execute -> afterTool and stop on policy denial", async () => {
  const seen = [];
  const allowFast = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        (ev) => {
          seen.push(`before:${ev.tool.name}`);
          return "continue";
        },
      ],
    },
    observers: {
      afterTool: [(ev) => seen.push(`after:${ev.tool.name}:${ev.ok}`)],
    },
  });

  const okFast = await runAgent({
    sessionId: "fast-harness-ok",
    text: "what time is it",
    harness: allowFast,
  });
  assert.equal(okFast.trace[0]?.tool, "time_now");
  assert.equal(okFast.trace[0]?.ok, true);
  assert.deepEqual(seen, ["before:time_now", "after:time_now:true"]);

  const denySeen = [];
  const denyFast = createHarnessPipeline({
    policyChecks: {
      beforeTool: [
        (ev) => {
          denySeen.push(`before:${ev.tool.name}`);
          return { decision: "deny", reason: "clock-disabled" };
        },
      ],
    },
    observers: {
      afterTool: [(ev) => denySeen.push(`after:${ev.tool.name}`)],
    },
  });

  const deniedFast = await runAgent({
    sessionId: "fast-harness-deny",
    text: "what time is it",
    harness: denyFast,
  });
  assert.equal(deniedFast.trace[0]?.denied, true);
  assert.equal(deniedFast.trace[0]?.reason, "clock-disabled");
  assert.deepEqual(denySeen, ["before:time_now"]);
});

