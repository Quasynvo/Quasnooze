/**
 * agent-receipts.test.js — issue #136 (`reason-01-plan-verify`).
 *
 * Three claims, one test group each:
 *
 *   1. A plan appears before a multi-step turn and is shown *as a plan*: it is
 *      built from the calls the model already asked for (no extra model round
 *      trip), it is never rendered as the answer, and it authorises nothing —
 *      every call it lists still meets the risk classifier and the approval
 *      gate.
 *   2. A reply is checked against receipts, not against itself: a count the
 *      tools did not report is refused, first by asking the model once to
 *      rewrite, then — if it will not — by a visible, code-generated footer and
 *      an honesty flag. Corrections are bounded and can never run a tool.
 *   3. Partial failure is reported per step, from the tool's own per-operation
 *      record rather than parsed out of its prose.
 *
 * No real model, no network beyond a loopback fake, no secrets.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const sandbox = mkdtempSync(join(tmpdir(), "pinch-receipts-ws-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-receipts-data-"));
process.env.PINCH_AUTO_APPROVE = "false";
process.env.PINCH_FAST_PATH = "off";
process.env.PINCH_GUARD = "on";
process.env.LLM_PROVIDER = "ollama";

/* ───────────────────────────── loopback model ───────────────────────────── */

const requests = [];
const call = (name, args) => ({ function: { name, arguments: args } });
const toolRound = (calls) => ({ content: "", tool_calls: calls });
const answer = (content) => ({ content });

const BATCH = [
  { from: "inbox/one.txt", to: "archive/one.txt" },
  { from: "inbox/two.txt", to: "archive/two.txt" },
  // `blocker` is a regular file, so mkdir(dirname(dst)) fails at apply time:
  // a genuine partial batch, not a validation refusal.
  { from: "inbox/three.txt", to: "blocker/three.txt" },
];

const modelServer = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const messages = body.messages || [];
  const text = JSON.stringify(messages);
  const sawToolResult = messages.some((m) => m.role === "tool");
  const corrected = messages.some((m) => m.role === "user" && String(m.content).startsWith("<receipt-check>"));
  requests.push({ url: req.url, body, text, corrected });

  let message = answer("ok");
  if (req.url === "/api/chat") {
    if (text.includes("plan-then-shell")) {
      message = sawToolResult
        ? answer("All three steps are done.")
        : toolRound([
            call("calculator", { expression: "1+1" }),
            call("calculator", { expression: "2+2" }),
            call("shell", { command: "touch planned.txt" }),
          ]);
    } else if (text.includes("two-calls-only")) {
      message = sawToolResult ? answer("Both done.") : toolRound([call("calculator", { expression: "1+1" }), call("calculator", { expression: "3+3" })]);
    } else if (text.includes("batch-claim")) {
      if (corrected) {
        message = answer("I moved 2 of the 3 files. inbox/three.txt failed: the destination folder could not be created.");
      } else if (sawToolResult) {
        message = answer("Done — I moved all twelve files into the archive.");
      } else {
        message = toolRound([call("move_path", { operations: BATCH })]);
      }
    } else if (text.includes("batch-stubborn")) {
      if (corrected) {
        message = answer("All twelve files are now in the archive. Every one of them.");
      } else if (sawToolResult) {
        message = answer("Done — all twelve files moved.");
      } else {
        message = toolRound([call("move_path", { operations: BATCH })]);
      }
    } else if (text.includes("batch-honest")) {
      if (sawToolResult) {
        message = answer("I moved 2 of 3 files; inbox/three.txt could not be placed because the destination folder failed.");
      } else {
        message = toolRound([call("move_path", { operations: BATCH })]);
      }
    } else if (text.includes("undo-claim")) {
      if (sawToolResult) {
        message = answer("I moved all 12 files.");
      } else {
        message = toolRound([call("move_path", { operations: BATCH.slice(0, 3) })]);
      }
    }
  }
  res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
  res.end(JSON.stringify({ message, done: true }) + (body.stream ? "\n" : ""));
});
await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
process.env.OLLAMA_URL = `http://127.0.0.1:${modelServer.address().port}`;
after(async () => {
  modelServer.closeAllConnections();
  await new Promise((r) => modelServer.close(r));
});

const { runAgent, answerApproval } = await import("../src/agent.js");
const { TOOL_MAP } = await import("../src/tools.js");
const { auditReply } = await import("../src/guard.js");
const receiptsModule = await import("../src/agent/receipts.js");
const { loadMemory } = await import("../src/store.js");
const {
  createReceiptLedger,
  receiptFor,
  buildTurnPlan,
  extractOperationClaims,
  auditReceiptClaims,
  renderReceipts,
  buildReceiptCorrection,
  PLAN_MIN_STEPS,
} = receiptsModule;

beforeEach(() => {
  rmSync(join(sandbox, "inbox"), { recursive: true, force: true });
  rmSync(join(sandbox, "archive"), { recursive: true, force: true });
  rmSync(join(sandbox, "planned.txt"), { force: true });
  rmSync(join(sandbox, "blocker"), { recursive: true, force: true });
  mkdirSync(join(sandbox, "inbox"), { recursive: true });
  for (const name of ["one", "two", "three"]) writeFileSync(join(sandbox, "inbox", `${name}.txt`), name);
  writeFileSync(join(sandbox, "blocker"), "this is a file, not a directory");
});

/* ─────────────────────────── 1. receipts are factual ─────────────────────── */

test("a receipt counts what the tool recorded, and never invents an operation", () => {
  // A plain successful call is one operation.
  const one = receiptFor({ tool: "write_file", args: { path: "notes.txt" }, result: { ok: true } });
  assert.equal(one.requested, 1);
  assert.equal(one.applied, 1);
  assert.equal(one.failed, 0);
  assert.equal(one.target, "notes.txt");

  // A failed call is one requested, zero applied, one failed — not "unverified".
  const failed = receiptFor({ tool: "write_file", args: { path: "notes.txt" }, result: { ok: false, output: "EACCES" } });
  assert.equal(failed.requested, 1);
  assert.equal(failed.applied, 0);
  assert.equal(failed.failed, 1);

  // A contradicted read-back never counts as applied, however the tool felt.
  const contradicted = receiptFor({
    tool: "write_file",
    args: { path: "notes.txt" },
    result: { ok: true },
    verification: { status: "contradicted", detail: "the file is not there" },
  });
  assert.equal(contradicted.applied, 0);

  // A refusal is a receipt that says so, with nothing applied.
  const denied = receiptFor({ tool: "shell", args: { command: "rm -rf build" }, result: null, denied: true });
  assert.equal(denied.denied, true);
  assert.equal(denied.applied, 0);
  assert.equal(denied.requested, 1);

  // A batch carries the tool's per-operation record, including the ones it
  // never attempted.
  const batch = receiptFor({
    tool: "move_path",
    args: { operations: [{}, {}, {}] },
    result: {
      ok: true,
      receipt: {
        kind: "batch",
        batchId: "b_1",
        requested: 12,
        applied: 3,
        failed: 1,
        notRun: 8,
        undoable: true,
        failedItems: [{ from: "a.txt", to: "arch/a.txt", reason: "EEXIST" }],
      },
    },
  });
  assert.equal(batch.requested, 12);
  assert.equal(batch.applied, 3);
  assert.equal(batch.notRun, 8);
  assert.equal(batch.target, "3 operations");
  assert.equal(batch.failedItems[0].reason, "EEXIST");
  assert.equal(Object.isFrozen(batch), true, "a receipt is a record, not a shared mutable object");
});

test("the ledger only ever grows, and its summary separates failed from not-run", () => {
  const ledger = createReceiptLedger();
  ledger.addOutcome({ tool: "calculator", args: { expression: "1+1" }, result: { ok: true } });
  ledger.addOutcome({ tool: "shell", args: { command: "ls" }, result: null, denied: true });
  ledger.addOutcome({
    tool: "move_path",
    args: { operations: [{}, {}] },
    result: { ok: true, receipt: { requested: 2, applied: 1, failed: 0, notRun: 1, batchId: "b_2", undoable: true } },
  });
  const summary = ledger.summary();
  assert.equal(summary.calls, 3);
  assert.equal(summary.applied, 2);
  assert.equal(summary.notRun, 2, "one not-run from the batch, one from the refused call");
  assert.equal(summary.failed, 0);
  assert.equal(summary.denied, 1);
  assert.equal(summary.partial, true);
  assert.equal(summary.clean, false);
  assert.equal(ledger.list().length, 3);

  // A refusal cannot be "corrected" by adding a receipt that did not happen:
  // the API has no way to say so.
  assert.equal(typeof ledger.edit, "undefined");
  assert.equal(typeof ledger.clear, "undefined");
});

/* ─────────────────────── 2. claims against receipts ─────────────────────── */

test("'N of M' claims are read, and negations are not counted as claims", () => {
  const claims = extractOperationClaims("Moved 3 of 12 files, then stopped.");
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claimed, 3);
  assert.equal(claims[0].of, 12);

  assert.deepEqual(extractOperationClaims("I could not move 3 of 12 files."), []);
  assert.deepEqual(extractOperationClaims("Only 3 of 12 files moved."), []);
  // A sentence with no countable noun says nothing we can check.
  assert.deepEqual(extractOperationClaims("2 of 3 tests passed."), []);
});

test("a claim of N completed operations with fewer than N receipts is refused", () => {
  const receipts = [createReceiptLedger()];
  const ledger = createReceiptLedger();
  ledger.addOutcome({
    tool: "move_path",
    args: { operations: [] },
    result: { ok: true, receipt: { requested: 12, applied: 3, failed: 0, notRun: 9, batchId: "b_3" } },
  });
  void receipts;

  // The exact failure the issue names.
  const audit = auditReceiptClaims({ reply: "Done — I moved all twelve files.", receipts: ledger.list() });
  assert.ok(audit.flags.some((f) => f.code === "receipt-count-mismatch"), JSON.stringify(audit.flags));

  // A truthful partial report passes both count and per-step checks.
  const honest = auditReceiptClaims({
    reply: "I moved 3 of 12 files. 9 were not run because the batch stopped.",
    receipts: ledger.list(),
  });
  assert.deepEqual(honest.flags, []);
});

test("partial failure summarised as success is flagged even when no number is claimed", () => {
  const ledger = createReceiptLedger();
  ledger.addOutcome({
    tool: "move_path",
    args: { operations: [] },
    result: { ok: true, receipt: { requested: 4, applied: 2, failed: 2, notRun: 0, batchId: "b_4" } },
  });
  const glossed = auditReceiptClaims({ reply: "Done — everything is in the archive.", receipts: ledger.list() });
  assert.ok(glossed.flags.some((f) => f.code === "partial-failure-unreported"));

  const reported = auditReceiptClaims({ reply: "Two of the four moves failed; both are listed below.", receipts: ledger.list() });
  assert.ok(!reported.flags.some((f) => f.code === "partial-failure-unreported"));
});

test("the honesty guard accepts receipts, and keeps every behaviour it had without them", () => {
  const ledger = createReceiptLedger();
  ledger.addOutcome({
    tool: "move_path",
    args: { operations: [] },
    result: { ok: true, receipt: { requested: 3, applied: 1, failed: 2, notRun: 0, batchId: "b_5" } },
  });

  const withReceipts = auditReply({
    reply: "I moved 1 of 3 files.",
    trace: [{ tool: "move_path", ok: true }],
    userText: "tidy my files",
    receipts: ledger.list(),
  });
  assert.equal(withReceipts.clean, true);

  const inflated = auditReply({
    reply: "I moved all 3 files.",
    trace: [{ tool: "move_path", ok: true }],
    userText: "tidy my files",
    receipts: ledger.list(),
  });
  assert.ok(inflated.flags.some((f) => f.code === "receipt-count-mismatch"));

  // No receipts (every pre-existing caller): identical to the old behaviour.
  const legacy = auditReply({ reply: "I moved a.txt into archive.", trace: [{ tool: "move_path", ok: true }], userText: "tidy" });
  assert.equal(legacy.clean, true);
});

test("corrections and footers are bounded, and name the failed items", () => {
  const ledger = createReceiptLedger();
  ledger.addOutcome({
    tool: "move_path",
    args: { operations: [] },
    result: {
      ok: true,
      receipt: {
        requested: 12,
        applied: 3,
        failed: 9,
        notRun: 0,
        batchId: "b_6",
        undoable: true,
        failedItems: Array.from({ length: 12 }, (_, i) => ({ from: `f${i}.txt`, to: `arch/f${i}.txt`, reason: "EEXIST" })),
      },
    },
  });

  const correction = buildReceiptCorrection({ receipts: ledger.list(), reply: "Done — all twelve moved." });
  assert.match(correction, /^<receipt-check>/);
  assert.match(correction, /3 of 12/);
  assert.match(correction, /f0\.txt/, "the failed item is named, not just counted");
  assert.ok(correction.length < 2000, "a correction is a note, not a transcript");

  const footer = renderReceipts(ledger.list());
  assert.match(footer, /3 of 12 operation/);
  assert.match(footer, /9 failed/);
  assert.match(footer, /failed: f0\.txt/);
  assert.match(footer, /undo_last/);

  // A small clean turn stays quiet: the receipt row would be noise.
  const quiet = createReceiptLedger();
  quiet.addOutcome({ tool: "calculator", args: {}, result: { ok: true } });
  assert.equal(renderReceipts(quiet.list()), "");
});

/* ───────────────────────────── 3. plans ─────────────────────────────────── */

test("a plan needs three steps, is bounded, and says it is not an approval", () => {
  assert.equal(PLAN_MIN_STEPS, 3);
  assert.equal(buildTurnPlan([{ tool: "calculator", label: "calculator(1+1)" }]), null);
  assert.equal(buildTurnPlan([]), null);

  const plan = buildTurnPlan(
    Array.from({ length: 20 }, (_, i) => ({ tool: "read_file", label: `read_file(path=${i})` })),
  );
  assert.equal(plan.steps.length, 12);
  assert.equal(plan.omitted, 8);
  assert.deepEqual(plan.steps[0], { n: 1, tool: "read_file", label: "read_file(path=0)" });
  assert.match(plan.note, /not an approval/i);
  assert.equal(Object.isFrozen(plan.steps), true);
  // A plan is data with no verbs of its own: it cannot run or approve anything.
  for (const key of ["run", "approve", "execute", "authorize"]) assert.equal(key in plan, false);

  // Loop-backed tools run once per turn, so the same call asked for three times
  // is one intended action. The footer compares against *distinct* steps: a plan
  // that repeated itself must not make a complete turn look unfinished.
  const repeated = buildTurnPlan(Array.from({ length: 3 }, () => ({ tool: "move_path", label: "move_path(3 files)" })));
  assert.equal(repeated.steps.length, 3);
  assert.equal(repeated.distinct, 1);
  const complete = renderReceipts(
    [{ requested: 3, applied: 3, failed: 0, notRun: 0, failedItems: [] }],
    { plan: repeated },
  );
  assert.doesNotMatch(complete, /plan had/, "a repeated identical call is not missing work");
  // A plan of genuinely distinct work that the receipts do not cover does say so.
  const distinct = buildTurnPlan([
    { tool: "read_file", label: "read_file(a)" },
    { tool: "read_file", label: "read_file(b)" },
    { tool: "write_file", label: "write_file(c)" },
  ]);
  assert.equal(distinct.distinct, 3);
  assert.match(
    renderReceipts([{ requested: 1, applied: 1, failed: 0, notRun: 0, failedItems: [] }], { plan: distinct }),
    /plan had 3 steps; receipts cover 1 call/,
  );
});

/* ─────────────────────── 4. end to end, through the agent ────────────────── */

test("a three-call turn shows a plan first; a two-call turn does not", async () => {
  const events = [];
  const planned = await runAgent({
    sessionId: "e2e-plan",
    text: "plan-then-shell",
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval") answerApproval(event.id, false);
    },
  });

  const planEvent = events.find((e) => e.type === "plan");
  assert.ok(planEvent, "no plan was shown before a three-call turn");
  assert.equal(planEvent.steps.length, 3);
  assert.match(planEvent.note, /not an approval/i);
  // The plan comes before the first tool runs, and it is not the answer.
  const planAt = events.findIndex((e) => e.type === "plan");
  const firstToolAt = events.findIndex((e) => e.type === "tool");
  assert.ok(planAt < firstToolAt, "the plan must precede the work it describes");
  assert.notEqual(planned.text, planEvent.steps.map((s) => s.label).join("\n"));
  assert.ok(planned.plan, "the plan is returned as data for the transcript");
  assert.equal(planned.plan.steps.length, 3);

  // The plan authorised nothing: the shell call inside it still asked, was
  // denied, and did not run.
  assert.ok(events.some((e) => e.type === "approval"), "a planned dangerous call must still ask");
  assert.equal(existsSync(join(sandbox, "planned.txt")), false, "a planned call must not run without approval");
  assert.ok(planned.trace.some((t) => t.tool === "shell" && t.denied));

  // And the two-call turn gets no plan at all.
  const small = await runAgent({ sessionId: "e2e-small", text: "two-calls-only" });
  assert.equal(small.plan, undefined);
});

test("a plan is never stored as memory", async () => {
  const before = JSON.stringify(loadMemory().facts);
  await runAgent({
    sessionId: "e2e-memory",
    text: "plan-then-shell",
    onEvent: (event) => { if (event.type === "approval") answerApproval(event.id, false); },
  });
  assert.equal(JSON.stringify(loadMemory().facts), before, "a plan must not become a fact about the owner");
  // The plan is also not written anywhere else: not a session field, not a
  // workflow document. That is the whole distinction from the opt-in /plan
  // workflow, which deliberately stores a design a person approved.
  // The session record keeps the user's own words and the tool trace — it is
  // the transcript. What it must not keep is a plan object: no `"plan"` field
  // for a later turn to read as an instruction, and no computed step list.
  const sessions = readFileSync(join(process.env.PINCH_DATA, "sessions", "e2e-memory.json"), "utf8");
  assert.doesNotMatch(sessions, /"plan"\s*:/);
  assert.doesNotMatch(sessions, /⌁ Plan/);
  assert.equal(existsSync(join(process.env.PINCH_DATA, "workflows.json")), false, "an incidental plan must not create a workflow");
});

test("a 12-claim over a 3-receipt turn is corrected once, without running anything", async () => {
  const start = requests.length;
  const result = await runAgent({
    sessionId: "e2e-claim",
    text: "batch-claim",
    onEvent: (event) => { if (event.type === "approval") answerApproval(event.id, true); },
  });

  const turnRequests = requests.slice(start);
  const correctionRequests = turnRequests.filter((r) => r.corrected);
  assert.equal(correctionRequests.length, 1, "exactly one correction round trip");
  assert.equal(correctionRequests[0].body.tools, undefined, "a correction may not offer tools");
  assert.match(JSON.stringify(correctionRequests[0].body.messages), /<receipt-check>[\s\S]*2 of 3 operations completed/);

  // The corrected answer is what the person reads, and it is true.
  assert.doesNotMatch(result.text, /twelve/i);
  assert.match(result.text, /2 of the 3 files/);
  assert.match(result.text, /inbox\/three\.txt failed/);
  assert.deepEqual(result.guard, [], "a corrected answer needs no honesty flag");
  assert.equal(result.claimMismatch, undefined);
  assert.equal(result.receiptSummary.applied, 2);
  assert.equal(result.receiptSummary.requested, 3);
});

test("an unreachable model cannot leave a false claim standing: the flag and the footer do it", async () => {
  const result = await runAgent({
    sessionId: "e2e-stubborn",
    text: "batch-stubborn",
    onEvent: (event) => { if (event.type === "approval") answerApproval(event.id, true); },
  });
  const turnRequests = requests.slice(-2);
  assert.equal(turnRequests.filter((r) => r.corrected).length, 1, "corrections are bounded to one");

  assert.ok(result.claimMismatch, "the mismatch is reported as data, not swallowed");
  assert.ok(result.guard.some((f) => f.code === "receipt-count-mismatch"));
  // The user-facing half does not depend on the model agreeing.
  assert.match(result.text, /Receipts:/);
  assert.match(result.text, /2 of 3 operations completed/);
  assert.match(result.text, /failed: inbox\/three\.txt/);
  assert.match(result.text, /did not line up/, "the existing honesty note still renders");
});

test("an honest partial answer is left alone: no correction, no flag, but a receipt footer", async () => {
  const start = requests.length;
  const result = await runAgent({
    sessionId: "e2e-honest",
    text: "batch-honest",
    // move_path is an `act`-tier tool: the approval gate applies to a test
    // exactly as it does to a person, which is the point.
    onEvent: (event) => { if (event.type === "approval") answerApproval(event.id, true); },
  });
  assert.equal(requests.slice(start).filter((r) => r.corrected).length, 0, "a truthful reply is not rewritten");
  assert.deepEqual(result.guard, []);
  assert.match(result.text, /I moved 2 of 3 files/);
  assert.match(result.text, /Receipts:\*\* 2 of 3 operations completed — 1 failed/);
});

test("the batch tools report per-operation receipts, so 'N of M' is never parsed out of prose", async () => {
  const moved = await TOOL_MAP.get("move_path").run({ operations: BATCH });
  assert.equal(moved.ok, true, moved.output);
  assert.equal(moved.receipt.requested, 3);
  assert.equal(moved.receipt.applied, 2);
  assert.equal(moved.receipt.failed, 1);
  assert.equal(moved.receipt.undoable, true);
  assert.equal(moved.receipt.failedItems.length, 1);
  assert.match(moved.receipt.failedItems[0].from, /inbox\/three\.txt/);
  assert.ok(moved.receipt.failedItems[0].reason.length > 0);
  assert.equal(existsSync(join(sandbox, "archive", "one.txt")), true);
  assert.equal(existsSync(join(sandbox, "inbox", "three.txt")), true, "the failed move left its source alone");

  // A refused plan has no operations to count: it is a failed call, not a
  // batch that "applied zero of zero".
  const refused = await TOOL_MAP.get("move_path").run({ operations: [{ from: "nope.txt", to: "archive/nope.txt" }] });
  assert.equal(refused.ok, false);
  assert.equal(refused.receipt, undefined);

  const undo = await TOOL_MAP.get("undo_last").run({});
  assert.equal(undo.ok, true);
  assert.equal(undo.receipt.action, "undo");
  assert.equal(undo.receipt.requested, 2);
  assert.equal(undo.receipt.applied, 2);
  assert.equal(undo.receipt.undoable, false);
});

test("a denial is a receipt too: the turn knows a step did not run", async () => {
  const events = [];
  const result = await runAgent({
    sessionId: "e2e-denial",
    text: "plan-then-shell",
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval") answerApproval(event.id, false);
    },
  });
  // Two calculators ran; the shell was refused. The footer states the truth
  // without the model having to be trusted to mention it.
  assert.equal(result.receiptSummary.applied, 2);
  assert.equal(result.receiptSummary.requested, 3);
  assert.match(result.text, /Receipts:\*\* 2 of 3 operations completed — 1 not run\./);
  const deniedEvent = events.find((e) => e.type === "tool_done" && e.name === "shell");
  assert.equal(deniedEvent.denied ?? true, true);
});

test("the plan event carries no text that could be mistaken for the answer", async () => {
  const events = [];
  await runAgent({
    sessionId: "e2e-shape",
    text: "plan-then-shell",
    onEvent: (event) => {
      events.push(event);
      if (event.type === "approval") answerApproval(event.id, true);
    },
  });
  const plan = events.find((e) => e.type === "plan");
  assert.deepEqual(Object.keys(plan).sort(), ["note", "omitted", "steps", "type"]);
  for (const step of plan.steps) assert.deepEqual(Object.keys(step).sort(), ["label", "n", "tool"]);
  assert.equal(existsSync(join(sandbox, "planned.txt")), true, "an approved planned call still runs");
});

test("a denied batch contributes no applied operations, whatever it was asked to do", async () => {
  const result = await runAgent({
    sessionId: "e2e-batch-denied",
    text: "batch-claim",
    onEvent: (event) => { if (event.type === "approval") answerApproval(event.id, false); },
  });
  assert.equal(result.receiptSummary.applied, 0);
  assert.equal(result.receiptSummary.requested, 3, "the three operations it asked for are the number that matters");
  assert.equal(result.receiptSummary.notRun, 3, "a refusal was never attempted: not-run, not failed");
  assert.equal(result.receiptSummary.failed, 0);
  // Nothing moved: the trap file legitimately blocked the third move, but the
  // other two never even tried.
  assert.equal(existsSync(join(sandbox, "archive", "one.txt")), false);
  assert.equal(existsSync(join(sandbox, "inbox", "one.txt")), true);
  assert.ok(result.trace.some((t) => t.tool === "move_path" && t.denied));
  // The model's draft claimed work that never happened; the guard says so in
  // code, and the visible footer counts the refusal honestly.
  assert.ok(result.guard.some((f) => f.code === "receipt-count-mismatch"));
});

test("receipt parts always add up, and a refused plan is not reported as one failed operation", () => {
  // A batch-shaped call that never reached the tool: every operation is not-run.
  const refused = receiptFor({ tool: "move_path", args: { operations: [{}, {}, {}, {}] }, result: { ok: false, output: "plan refused" } });
  assert.deepEqual(
    [refused.requested, refused.applied, refused.failed, refused.notRun],
    [4, 0, 0, 4],
    "a refused plan must not be counted as one failed operation",
  );

  // The invariant, over every shape a call can take. A receipt whose parts do
  // not add up is a receipt nobody can check.
  const shapes = [
    { tool: "write_file", args: { path: "a" }, result: { ok: true } },
    { tool: "write_file", args: { path: "a" }, result: { ok: false } },
    { tool: "shell", args: { command: "ls" }, denied: true },
    { tool: "move_path", args: { operations: [{}, {}] }, denied: true },
    { tool: "move_path", args: { operations: [{}] }, result: { ok: false } },
    { tool: "move_path", args: { operations: [{}, {}] }, result: { ok: true, receipt: { requested: 2, applied: 1, failed: 1, notRun: 0 } } },
    { tool: "move_path", args: { operations: [{}, {}, {}] }, result: { ok: true, receipt: { requested: 3, applied: 1, failed: 0, notRun: 1 } } },
    { tool: "calculator", args: {}, result: { ok: true }, verification: { status: "contradicted" } },
  ];
  for (const shape of shapes) {
    const receipt = receiptFor(shape);
    assert.equal(
      receipt.applied + receipt.failed + receipt.notRun,
      receipt.requested,
      `parts do not add up for ${shape.tool}: ${JSON.stringify(receipt)}`,
    );
  }
});
