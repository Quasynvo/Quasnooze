/**
 * agent-workflow.test.js — issue #108 (`agentic-01-phased-flow`).
 *
 * The claim under test: a design is a *document* a person approves, in a
 * deterministic state machine, before anything runs — and approving it grants
 * nothing except permission to start. Every tool inside still meets the risk
 * tier and the approval gate it met before.
 *
 * Written before the module exists, so the first run is the expected failure.
 * No real model, no network beyond a loopback fake, no secrets.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const sandbox = mkdtempSync(join(tmpdir(), "pinch-workflow-ws-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-workflow-data-"));
process.env.LLM_PROVIDER = "ollama";
process.env.PINCH_AUTO_APPROVE = "false";
process.env.PINCH_FAST_PATH = "off";
process.env.PINCH_WORKFLOW = "on";

const requests = [];
const PLAN = {
  goal: "Tidy the downloads folder",
  scope: ["downloads/"],
  steps: [
    { action: "List downloads and count files by extension", check: "counts reported per extension" },
    { action: "Move every .zip older than 30 days into archive/", check: "archive/ exists and holds the zips" },
  ],
  successChecks: ["downloads/ contains no .zip older than 30 days", "nothing was deleted"],
};

const server = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  const text = JSON.stringify(body.messages || []);
  requests.push({ url: req.url, text, messages: body.messages });
  const isToolResult = (body.messages || []).some((m) => m.role === "tool");
  const executing = text.includes("<workflow-plan");

  let content = "hello there";
  if (text.includes("nine-steps")) {
    content = JSON.stringify({ ...PLAN, steps: Array.from({ length: 9 }, (_, i) => ({ action: `step ${i + 1}` })) });
  } else if (text.includes("long-step")) {
    content = JSON.stringify({ ...PLAN, steps: [{ action: "x".repeat(400) }] });
  } else if (text.includes("no-json")) {
    content = "Sure! Here is my plan in prose, because JSON is optional in my world.";
  } else if (text.includes("which-folder")) {
    content = JSON.stringify({ clarify: "Which folder do you mean: downloads or desktop?" });
  } else if (text.includes("dangerous-step")) {
    content = JSON.stringify({ ...PLAN, steps: [{ action: "Run the shell to touch proof.txt", check: "proof.txt exists" }] });
  } else if (text.includes("tidy-downloads") || text.includes("Tidy the downloads folder")) {
    content = JSON.stringify(PLAN);
  }

  const message = executing && !isToolResult
    ? { content: "", tool_calls: [{ function: { name: "shell", arguments: { command: "touch proof.txt" } } }] }
    : { content: executing ? "The plan ran." : content };

  res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
  res.end(JSON.stringify({ message, done: true }) + (body.stream ? "\n" : ""));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const { runAgent, answerApproval } = await import("../src/agent.js");
const wf = await import("../src/agent/workflow.js");

/** Fresh store per test: one file, deleted, because a workflow outlives a turn. */
beforeEach(() => {
  try { rmSync(wf.workflowStorePath(), { force: true }); } catch { /* first run */ }
  requests.length = 0;
});

const latest = () => wf.listWorkflows()[0];

/* ── acceptance 1: design approval is explicit, session-bound, and grants nothing ── */

test("a plan is data, bounded, and waits for approval instead of running", async () => {
  const result = await runAgent({ sessionId: "s-plan", text: "/plan tidy-downloads" });

  const stored = latest();
  assert.equal(stored.state, "awaiting-design-approval");
  assert.equal(stored.plan.steps.length, 2);
  assert.equal(stored.sessionId, "s-plan");
  // The design is the rendered document, not the model's musings.
  assert.match(result.text, /1\. List downloads/);
  assert.match(result.text, /\/approve/);
  // One model call for the design, and no tool ran.
  assert.equal(requests.length, 1);
  assert.deepEqual(result.trace, []);
  // Nothing that looks like hidden chain-of-thought is stored as a field.
  assert.deepEqual(
    Object.keys(stored.plan).sort(),
    ["goal", "scope", "steps", "successChecks"],
  );
});

test("approval from another session is refused and changes nothing", async () => {
  await runAgent({ sessionId: "s-owner", text: "/plan tidy-downloads" });
  const before = latest();

  const refused = await runAgent({ sessionId: "s-stranger", text: "/approve" });
  assert.match(refused.text, /no design is waiting|not approved|originating/i);

  const afterState = wf.loadWorkflow(before.id);
  assert.equal(afterState.state, "awaiting-design-approval");
  assert.equal(afterState.approval, null);
});

test("an approved design still cannot authorize a tool: the risk gate survives", async () => {
  await runAgent({ sessionId: "s-gate", text: "/plan dangerous-step" });
  let asked = null;
  const result = await runAgent({
    sessionId: "s-gate",
    text: "/approve",
    onEvent: (e) => {
      if (e.type === "approval") { asked = e.id; answerApproval(e.id, false); }
    },
  });

  assert.ok(asked, "a shell call inside an approved plan must still raise an approval");
  assert.equal(existsSync(join(sandbox, "proof.txt")), false, "denied tool must not run");
  assert.ok(result.trace.some((t) => t.tool === "shell" && t.denied), "the denial is recorded");
  assert.equal(latest().state, "blocked");
});

/* ── acceptance 2: a bounded plan, and malformed or oversized input fails closed ── */

test("a plan that is not JSON fails closed with an actionable message", async () => {
  const result = await runAgent({ sessionId: "s-bad", text: "/plan no-json" });

  assert.match(result.text, /not accepted|nothing was executed/i);
  assert.match(result.text, /JSON/i);
  assert.equal(latest().state, "blocked");
  assert.deepEqual(result.trace, [], "a malformed design may not execute anything");
});

test("an oversized plan fails closed and names the limit", async () => {
  const over = await runAgent({ sessionId: "s-nine", text: "/plan nine-steps" });
  assert.match(over.text, /8/);
  assert.equal(latest().state, "blocked");

  const long = await runAgent({ sessionId: "s-long", text: "/plan long-step" });
  assert.match(long.text, /240/);
  assert.equal(latest().state, "blocked");
});

test("one focused clarification is asked, and a second is refused", async () => {
  const first = await runAgent({ sessionId: "s-ask", text: "/plan which-folder" });
  assert.match(first.text, /which folder/i);
  // Still designing, not awaiting approval, and not executing.
  assert.equal(latest().state, "design");

  wf.noteClarification(latest().id);
  const second = wf.submitDesign(wf.loadWorkflow(latest().id), JSON.stringify({ clarify: "again?" }));
  assert.equal(second.ok, false);
  assert.match(second.error, /clarification/i);
  assert.equal(wf.loadWorkflow(latest().id).state, "blocked");
});

/* ── acceptance 3: greetings never plan, and nothing pending survives a stop ── */

test("a greeting makes no planning call and creates no workflow", async () => {
  const result = await runAgent({ sessionId: "s-hi", text: "hello" });
  assert.equal(requests.some((r) => r.text.includes("PLAN-CONTRACT")), false, "a greeting must not reach the design prompt");
  assert.deepEqual(wf.listWorkflows(), []);
  assert.match(result.text, /hello/i);
});

test("cancelling stops a pending design and a later approval cannot revive it", async () => {
  await runAgent({ sessionId: "s-cancel", text: "/plan tidy-downloads" });
  const cancelled = await runAgent({ sessionId: "s-cancel", text: "/cancel" });
  assert.match(cancelled.text, /cancel/i);
  assert.equal(latest().state, "blocked");

  const late = await runAgent({ sessionId: "s-cancel", text: "/approve" });
  assert.match(late.text, /no design is waiting|not approved/i);
  assert.equal(requests.filter((r) => r.text.includes("<workflow-plan")).length, 0);
});

test("a restart never executes a pending step", async () => {
  await runAgent({ sessionId: "s-restart", text: "/plan tidy-downloads" });
  const id = latest().id;

  // Take the workflow to `executing` the way the agent does, then pretend the
  // process died: a different owner epoch, and a lease in the past.
  const approved = wf.approveDesign({ id, sessionId: "s-restart" });
  assert.equal(approved.ok, true);
  assert.equal(wf.beginExecution({ id, sessionId: "s-restart" }).ok, true);
  assert.equal(wf.loadWorkflow(id).state, "executing");

  const path = wf.workflowStorePath();
  const doc = JSON.parse(readFileSync(path, "utf8"));
  doc.workflows[0].lease = { epoch: "some-previous-process", pid: 1, expiresAt: 0 };
  writeFileSync(path, JSON.stringify(doc));

  const recovered = wf.loadWorkflow(id);
  assert.equal(recovered.state, "blocked");
  assert.match(recovered.blockedReason, /interrupted|restart/i);
  assert.equal(wf.beginExecution({ id, sessionId: "s-restart" }).ok, false);
});

test("a corrupt store blocks loudly instead of guessing", async () => {
  writeFileSync(wf.workflowStorePath(), "{ not json at all");
  const result = await runAgent({ sessionId: "s-corrupt", text: "/plan tidy-downloads" });
  assert.match(result.text, /workflow store|unreadable|corrupt/i);
  assert.deepEqual(result.trace, []);
});

/* ── the state machine itself, without a model in the way ── */

test("illegal transitions are refused, and a design approval is single-use", () => {
  const created = wf.createWorkflow({ sessionId: "s-unit", goal: "tidy", channel: "web" });
  assert.equal(created.state, "inspect");

  // No approval before a design exists.
  assert.equal(wf.approveDesign({ id: created.id, sessionId: "s-unit" }).ok, false);
  // No execution before an approval.
  assert.equal(wf.beginExecution({ id: created.id, sessionId: "s-unit" }).ok, false);

  const designed = wf.submitDesign(wf.loadWorkflow(created.id), JSON.stringify(PLAN));
  assert.equal(designed.ok, true);
  assert.equal(wf.loadWorkflow(created.id).state, "awaiting-design-approval");

  assert.equal(wf.approveDesign({ id: created.id, sessionId: "s-other" }).ok, false, "wrong session");
  assert.equal(wf.approveDesign({ id: created.id, sessionId: "s-unit" }).ok, true);
  assert.equal(wf.approveDesign({ id: created.id, sessionId: "s-unit" }).ok, false, "already approved");

  assert.equal(wf.beginExecution({ id: created.id, sessionId: "s-unit" }).ok, true);
  assert.equal(wf.beginExecution({ id: created.id, sessionId: "s-unit" }).ok, false, "approval is spent");

  assert.equal(wf.finishExecution({ id: created.id, ok: true }).state, "done");
  assert.equal(wf.finishExecution({ id: created.id, ok: true }).ok, false, "terminal state");
});

test("a design approval expires", () => {
  const created = wf.createWorkflow({ sessionId: "s-ttl", goal: "tidy" });
  wf.submitDesign(wf.loadWorkflow(created.id), JSON.stringify(PLAN));
  const t0 = Date.now();
  assert.equal(wf.approveDesign({ id: created.id, sessionId: "s-ttl", now: t0 }).ok, true);
  assert.equal(
    wf.beginExecution({ id: created.id, sessionId: "s-ttl", now: t0 + wf.APPROVAL_TTL_MS + 1 }).ok,
    false,
    "an expired approval may not start work",
  );
});

test("the workflow is off unless the owner turns it on", () => {
  assert.equal(wf.parseWorkflowCommand("/plan tidy", { enabled: false }), null, "parsing needs the opt-in flag");
  assert.equal(wf.parseWorkflowCommand("/plan tidy", { enabled: true }).verb, "plan");
  assert.equal(wf.parseWorkflowCommand("/approve", { enabled: true }).verb, "approve");
  assert.equal(wf.parseWorkflowCommand("/cancel", { enabled: true }).verb, "cancel");
  assert.equal(wf.parseWorkflowCommand("please plan my day", { enabled: true }), null);
});
