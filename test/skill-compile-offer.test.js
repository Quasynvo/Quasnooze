/**
 * skill-compile-offer.test.js — the in-chat compile offer (issue #207, item 1).
 *
 * The compiler, the registry and replay already exist (test/skill-compiler.test.js).
 * What is under test here is the flow the issue names first: **after a
 * successful multi-step turn, offer to compile it into a named skill** — and
 * when the owner accepts, compile the recorded turn into data, save it
 * *unapproved*, and never run it until the owner approves it.
 *
 * Boundaries being proven:
 *   - the offer is data in the turn result plus one plain sentence — it is not
 *     authority, and it appears only after ≥ 2 successful tool calls;
 *   - `/compile` costs zero model calls and byte-identical arguments survive;
 *   - a compiled skill refuses to replay until the owner approves it;
 *   - unattended runs neither offer nor compile (nobody is here to review);
 *   - the offer module cannot approve or run anything (it may compile and save
 *     through the registry — that is the owner-facing door);
 *   - the thousandth replay costs what the first did — measured, not asserted.
 *
 * The fake is the model (a loopback ollama stand-in with canned tool calls).
 * The system of record — store, registry, policy — is real.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-offer-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-offer-data-"));
process.env.PINCH_AUTO_APPROVE = "true";
process.env.PINCH_FAST_PATH = "off";
process.env.LLM_PROVIDER = "ollama";

let modelRequests = 0;
const server = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  modelRequests += 1;
  const body = JSON.parse(raw || "{}");
  const messages = body.messages || [];
  const text = JSON.stringify(messages);
  const toolRound = messages.some((m) => m.role === "tool");

  let message;
  if (toolRound) {
    message = { content: "Both steps are done." };
  } else if (text.includes("force-tool-loop")) {
    message = {
      content: "",
      tool_calls: [
        { function: { name: "calculator", arguments: { expression: "2+2" } } },
        { function: { name: "remember", arguments: { fact: "compiled turns are cheap" } } },
      ],
    };
  } else if (text.includes("one-tool-turn")) {
    message = { content: "", tool_calls: [{ function: { name: "calculator", arguments: { expression: "2+2" } } }] };
  } else if (text.includes("failed-step-turn")) {
    message = {
      content: "",
      tool_calls: [
        { function: { name: "read_file", arguments: { path: "definitely-missing.txt" } } },
        { function: { name: "calculator", arguments: { expression: "2+2" } } },
      ],
    };
  } else {
    message = { content: "Hello!" };
  }
  res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
  res.end(JSON.stringify({ message, done: true }) + (body.stream ? "\n" : ""));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const { runAgent } = await import("../src/agent.js");
const { loadSkill, approveSkill, deleteSkill, saveSkill } = await import("../src/skills/registry.js");
const { compileSkill } = await import("../src/skills/compiler.js");
const { replaySkill } = await import("../src/skills/replay.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verified = async () => ({ status: "verified", detail: "read back matches" });

function fakeExecute({ result = { ok: true, output: "done" } } = {}) {
  const calls = [];
  return {
    calls,
    execute: async (tool, args) => {
      calls.push({ tool, args });
      return { ...result };
    },
  };
}

/* ────────────────────── the offer appears (and does not) ──────────────── */

test("after a successful multi-step turn, the agent offers to compile it", async () => {
  const result = await runAgent({ sessionId: "s-offer", text: "force-tool-loop" });
  assert.equal(result.trace.length, 2, "the turn really ran two steps");
  assert.ok(result.skillOffer, "the turn result carries the offer as data");
  assert.equal(result.skillOffer.steps, 2);
  assert.equal(result.skillOffer.suggestedName, "force-tool-loop");
  assert.match(result.text, /\/compile force-tool-loop/, "the offer names the command and a skill name");
});

test("a single-call turn is not offered — a skill is a program, not a shortcut", async () => {
  const result = await runAgent({ sessionId: "s-one", text: "one-tool-turn" });
  assert.equal(result.trace.length, 1);
  assert.equal(result.skillOffer, undefined);
  assert.doesNotMatch(result.text, /\/compile/);
});

test("a turn with a failed step is not offered — only successful work compiles", async () => {
  const result = await runAgent({ sessionId: "s-failed", text: "failed-step-turn" });
  assert.equal(result.trace.length, 2);
  assert.equal(result.skillOffer, undefined);
  assert.doesNotMatch(result.text, /\/compile/);
});

test("simple chat is never offered a skill", async () => {
  const result = await runAgent({ sessionId: "s-chat", text: "hello there" });
  assert.equal(result.skillOffer, undefined);
  assert.doesNotMatch(result.text, /\/compile/);
});

test("an unattended run is never offered a skill — nobody is here to review it", async () => {
  const result = await runAgent({ sessionId: "s-auto", text: "force-tool-loop", autonomy: "unattended" });
  assert.equal(result.skillOffer, undefined);
  assert.doesNotMatch(result.text, /\/compile/);
});

/* ───────────────────── the owner accepts: /compile ─────────────────────── */

test("/compile saves the recorded turn as an unapproved skill with byte-identical arguments, and calls no model", async () => {
  await runAgent({ sessionId: "s-compile", text: "force-tool-loop" });
  const before = modelRequests;

  const result = await runAgent({ sessionId: "s-compile", text: "/compile tidy-facts" });
  assert.equal(modelRequests, before, "/compile is deterministic — zero model calls");
  assert.match(result.text, /saved/i);
  assert.match(result.text, /approve/i, "the reply tells the owner how to review and approve");

  const loaded = loadSkill("tidy-facts");
  assert.ok(loaded, "the skill exists in the registry");
  assert.equal(loaded.approval.approved, false, "it is NOT approved — the owner decides that");
  assert.equal(loaded.manifest.steps.length, 2);
  assert.deepEqual(loaded.manifest.steps[0], {
    tool: "calculator",
    args: { expression: "2+2" },
  }, "arguments are byte-identical to what the model sent");
  assert.equal(loaded.manifest.steps[1].tool, "remember");
});

test("a compiled skill cannot replay until the owner approves it", async () => {
  const loaded = loadSkill("tidy-facts");
  const { execute, calls } = fakeExecute();
  const refused = await replaySkill(loaded, { execute, verify: verified, approve: () => true });
  assert.equal(refused.status, "refused");
  assert.match(refused.reason, /not owner-approved/i);
  assert.equal(calls.length, 0, "refused before a single step ran");
  approveSkill("tidy-facts");
  const run = fakeExecute();
  const report = await replaySkill(loadSkill("tidy-facts"), {
    execute: run.execute,
    verify: verified,
    approve: () => true,
    // The recorded turn already remembered the fact: the honest replay says
    // so and the owner accepts it as already satisfied (F08 repair), instead
    // of re-adding it or guessing around it.
    repair: () => ({ action: "satisfied" }),
  });
  assert.equal(report.status, "completed");
  assert.equal(run.calls.length, 1, "approval lets it run — the calculator step runs, the already-applied step is not re-run");
  assert.equal(report.steps.filter((st) => st.satisfied).length, 1);
});

test("/compile without a name or with a bad name is refused, and nothing is saved", async () => {
  await runAgent({ sessionId: "s-names", text: "force-tool-loop" });
  const usage = await runAgent({ sessionId: "s-names", text: "/compile" });
  assert.match(usage.text, /\/compile <name>/i);
  const bad = await runAgent({ sessionId: "s-names", text: "/compile Evil Name!" });
  assert.match(bad.text, /lowercase|name/i);
  assert.throws(() => loadSkill("evil"), /no such skill|not found|unknown/i, "nothing was saved under any smuggled name");
});

test("/compile after a failed turn reports honestly and saves nothing", async () => {
  await runAgent({ sessionId: "s-honest", text: "failed-step-turn" });
  const result = await runAgent({ sessionId: "s-honest", text: "/compile no-luck" });
  assert.match(result.text, /did not succeed|only successful work|∿/);
  assert.throws(() => loadSkill("no-luck"), /no such skill|not found|unknown/i);
});

test("an unattended run cannot compile — reviewing a skill needs a person", async () => {
  const result = await runAgent({ sessionId: "s-auto-compile", text: "/compile sneaky", autonomy: "unattended" });
  assert.match(result.text, /person|review/i);
  assert.throws(() => loadSkill("sneaky"), /no such skill|not found|unknown/i);
});

/* ─────────────── the thousandth run costs the same as the first ────────── */

test("replay cost is flat: the last 100 runs cost what the first 100 did (n=200, measured)", async () => {
  // A repeatable skill: two steps with no one-shot preconditions, so the
  // thousandth run is the same work as the first (remember-style steps are
  // honestly already-applied on re-run and take a repair answer instead).
  saveSkill(compileSkill({
    name: "flat-cost",
    utterance: "force-tool-loop",
    calls: [
      { tool: "calculator", args: { expression: "2+2" }, result: { ok: true } },
      { tool: "calculator", args: { expression: "3*3" }, result: { ok: true } },
    ],
  }));
  approveSkill("flat-cost");
  const loaded = loadSkill("flat-cost");
  const samples = [];
  const before = modelRequests;
  for (let i = 0; i < 200; i++) {
    const { execute, calls } = fakeExecute();
    const report = await replaySkill(loaded, { execute, verify: verified, approve: () => true });
    assert.equal(report.status, "completed");
    assert.equal(calls.length, 2);
    samples.push(report.ms);
  }
  assert.equal(modelRequests, before, "200 replays, zero model calls");
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const first = median(samples.slice(0, 100));
  const last = median(samples.slice(100));
  assert.ok(last <= 2 * first + 5,
    `cost grew across runs: first-half median ${first} ms vs last-half median ${last} ms — the thousandth run must cost what the first did`);
  deleteSkill("flat-cost");
});

/* ─────────────────── the offer cannot widen anything ───────────────────── */

test("the offer module can compile and save — never approve, never run", () => {
  const src = readFileSync(join(ROOT, "src", "agent", "compile-offer.js"), "utf8");
  assert.ok(!/replaySkill|from "\.\.\/skills\/replay\.js"/.test(src), "the offer module cannot run a skill");
  assert.ok(!/approveSkill|revokeSkill/.test(src), "the offer module cannot approve a skill");
  const agentSrc = readFileSync(join(ROOT, "src", "agent.js"), "utf8");
  assert.ok(!agentSrc.includes("skills/"), "the agent never reaches into src/skills/ itself");
});
