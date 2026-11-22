import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { validateSchema } from "../src/agent/tool-args.js";

const data = mkdtempSync(join(tmpdir(), "quas-arg-data-"));
const workspace = mkdtempSync(join(tmpdir(), "quas-arg-ws-"));
process.env.PINCH_DATA = data;
process.env.PINCH_WORKSPACE = workspace;
process.env.PINCH_FAST_PATH = "off";
process.env.PINCH_AUTO_APPROVE = "false";
process.env.LLM_PROVIDER = "ollama";

let scenario = "";
const requests = [];
const call = (name, args) => ({ function: { name, arguments: args } });
const server = createServer(async (req, res) => {
  if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "test" }] }));
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const repair = body.messages?.[0]?.content?.startsWith("Repair the tool arguments once.");
  const hasTool = body.messages.some((m) => m.role === "tool");
  let message;
  if (repair) {
    if (scenario === "repair" || scenario === "json-repair") message = { tool_calls: [call("calculator", { expression: "6*7" })] };
    else if (scenario === "approval") message = { tool_calls: [call("write_file", { path: "blocked.txt", content: "no" })] };
    else if (scenario === "switch") message = { tool_calls: [call("write_file", { path: "blocked.txt", content: "no" })] };
    else message = { tool_calls: [call("calculator", { expression: 100 })] };
  } else if (hasTool) message = { content: "The tool finished." };
  else if (scenario === "unknown") message = { tool_calls: [call("not_a_tool", {})] };
  else if (scenario === "approval" || scenario === "missing") message = { tool_calls: [call("write_file", { path: "blocked.txt" })] };
  else if (scenario === "multi") message = { tool_calls: [call("write_file", { path: "blocked.txt", content: 1 }), call("shell", { command: 123 }), call("calculator", { expression: 7 })] };
  else if (scenario === "valid") message = { tool_calls: [call("calculator", { expression: "6*7" })] };
  else if (scenario === "json" || scenario === "json-repair") message = { tool_calls: [call("calculator", '{"expression":')] };
  else message = { tool_calls: [call("calculator", { expression: 7 })] };
  res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
  res.end(JSON.stringify({ message, done: true }) + (body.stream ? "\n" : ""));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
const { runAgent, answerApproval } = await import("../src/agent.js");
after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); rmSync(data, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });

const schema = { type: "object", required: ["operations"], properties: { operations: { type: "array", items: { type: "object", required: ["path"], properties: { path: { type: "string" }, overwrite: { type: "boolean" } } } }, choice: { type: "string", enum: ["a", "b"] }, count: { type: "integer" } } };
test("schema validation is recursive, strict and does not mutate input", () => {
  const valid = { operations: [{ path: "abc", overwrite: false }], choice: "a", count: 2 };
  const copy = structuredClone(valid);
  assert.deepEqual(validateSchema(schema, valid), []);
  assert.deepEqual(valid, copy);
  for (const value of [null, [], "object"]) assert.ok(validateSchema(schema, value).length);
  assert.match(validateSchema(schema, { operations: [{ path: 1, overwrite: "yes" }], choice: "z", count: 1.2 }).join(" "), /operations\[0\]\.path.*string/);
  assert.match(validateSchema(schema, { operations: [{}] }).join(" "), /operations\[0\]\.path/);
  assert.ok(validateSchema(schema, { operations: null }).length);
  assert.ok(validateSchema(schema, { operations: [], count: NaN }).length);
  assert.ok(validateSchema(schema, { operations: [], choice: "z" }).length);
});

async function turn(which) {
  scenario = which; requests.length = 0;
  const events = [];
  const result = await runAgent({ sessionId: `args-${which}`, text: `perform request ${which}`, onEvent: (event) => { events.push(event); if (event.type === "approval") answerApproval(event.id, false); } });
  return { result, events, requests: [...requests] };
}

test("valid call passes through without repair", async () => {
  const { result, events } = await turn("valid");
  assert.equal(events.filter((e) => e.type === "tool_repair").length, 0);
  assert.deepEqual(result.trace[0].args, { expression: "6*7" });
  assert.equal(result.trace[0].ok, true);
});

test("one repair receives errors and the corrected call is executed", async () => {
  const { result, events, requests: calls } = await turn("repair");
  const repairs = calls.filter((r) => r.messages[0].content.startsWith("Repair the tool arguments once."));
  assert.equal(repairs.length, 1);
  assert.match(repairs[0].messages[1].content, /expression.*string/);
  assert.equal(events.filter((e) => e.type === "tool_repair").length, 1);
  assert.equal(result.trace[0].ok, true);
  assert.deepEqual(result.trace[0].args, { expression: "6*7" });
  const records = readFileSync(join(data, "telemetry.ndjson"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.filter((r) => r.sessionId === "args-repair").at(-1).argumentRepairs, 1);
});

test("malformed JSON is included in the repair request and can be repaired", async () => {
  const { result, requests: calls } = await turn("json-repair");
  const repair = calls.find((r) => r.messages[0].content.startsWith("Repair the tool arguments once."));
  assert.match(repair.messages[1].content, /expression/);
  assert.match(repair.messages[1].content, /valid JSON object/);
  assert.equal(result.trace[0].ok, true);
});

for (const name of ["bad", "unknown", "json", "switch", "missing", "multi"]) test(`${name}: one failed repair ends with a typed actionable failure`, async () => {
  const { result, events, requests: calls } = await turn(name);
  assert.equal(calls.filter((r) => r.messages[0].content.startsWith("Repair the tool arguments once.")).length, 1);
  assert.equal(events.filter((e) => e.type === "tool_repair").length, 1);
  assert.equal(result.trace[0].code, "BAD_TOOL_ARGS");
  assert.match(result.text, /BAD_TOOL_ARGS.*try again/i);
  assert.ok(!existsSync(join(workspace, "blocked.txt")));
  if (name === "missing") assert.match(result.text, /Missing required argument: content/);
  if (name === "multi") {
    assert.ok(events.some((e) => e.type === "plan"));
    assert.equal(result.trace.filter((e) => e.code === "BAD_TOOL_ARGS").length, 3);
  }
});

test("a repaired dangerous action still requires approval", async () => {
  const { result, events } = await turn("approval");
  assert.equal(events.filter((e) => e.type === "tool_repair").length, 1);
  assert.ok(events.some((e) => e.type === "approval"));
  assert.ok(result.trace.some((e) => e.denied));
  assert.ok(!existsSync(join(workspace, "blocked.txt")));
});
