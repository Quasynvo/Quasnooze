/**
 * End-to-end agent tests against the mock brain: the tool loop, the
 * permission gate, and the fact that a denied action really does not run.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const sandbox = mkdtempSync(join(tmpdir(), "pinch-agent-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-data-"));
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_AUTO_APPROVE = "false";

const modelRequests = [];
let tagsFail = false;
let replyOverride = null, streamWithoutNewline = false;
let modelFailure = false, modelRedirect = false, redirectedRequests = 0;
const modelServer = createServer(async (req, res) => {
  if (req.url === "/redirect-target") { redirectedRequests++; return res.end("{}"); }
  if (req.url === "/api/tags") {
    res.writeHead(tagsFail ? 503 : 200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }, { name: "coder:7b" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  modelRequests.push({ path: req.url, body });
  const local = req.url === "/api/chat";
  if (local && modelFailure) { res.writeHead(404); return res.end(JSON.stringify({ error: "model not found" })); }
  if (local && modelRedirect) { res.writeHead(302, { location: "/redirect-target" }); return res.end(); }
  const toolRound = local && body.messages.some((m) => m.role === "user" && m.content === "force-tool-loop") && !body.messages.some((m) => m.role === "tool");
  const message = replyOverride || (toolRound
    ? { content: "", tool_calls: [{ function: { name: "calculator", arguments: { expression: "2+2" } } }] }
    : { content: `${local ? "local" : "cloud"} ${body.model}` });
  if (local) {
    res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
    return res.end(JSON.stringify({ message, done: true }) + (body.stream && !streamWithoutNewline ? "\n" : ""));
  }
  if (body.stream) {
    res.setHeader("content-type", "text/event-stream");
    return res.end(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ choices: [{ message }] }));
});
await new Promise((r) => modelServer.listen(0, "127.0.0.1", r));
const modelBase = `http://127.0.0.1:${modelServer.address().port}`;
process.env.OLLAMA_URL = modelBase;
process.env.OPENAI_BASE_URL = `${modelBase}/v1`;
process.env.OPENAI_API_KEY = "test-model-key";
after(async () => { modelServer.closeAllConnections(); await new Promise((r) => modelServer.close(r)); });

const { runAgent, answerApproval } = await import("../src/agent.js");

test("agent runs a safe tool and reports its result", async () => {
  const events = [];
  const result = await runAgent({
    sessionId: "test-safe",
    text: "calc (1200 * 1.18) / 3",
    onEvent: (e) => events.push(e),
  });
  assert.ok(result.trace.some((t) => t.tool === "calculator" && t.ok));
  assert.match(result.text, /472/);
  assert.ok(events.some((e) => e.type === "tool" && e.name === "calculator"));
});

test("dangerous tool asks permission and runs when allowed", async () => {
  let askedId = null;
  const result = await runAgent({
    sessionId: "test-allow",
    text: "run echo lobster-ok",
    onEvent: (e) => {
      if (e.type === "approval") {
        askedId = e.id;
        answerApproval(e.id, true); // simulate the user tapping Allow
      }
    },
  });
  assert.ok(askedId, "an approval prompt should have been raised");
  assert.match(result.text, /lobster-ok/);
});

test("dangerous tool is blocked when the user denies", async () => {
  const marker = join(sandbox, "should-not-exist.txt");
  const result = await runAgent({
    sessionId: "test-deny",
    text: `run touch ${marker}`,
    onEvent: (e) => {
      if (e.type === "approval") answerApproval(e.id, false);
    },
  });
  assert.equal(existsSync(marker), false, "denied command must not execute");
  assert.ok(result.trace.some((t) => t.denied));
});

test("shell output is captured into the conversation", async () => {
  const result = await runAgent({
    sessionId: "test-shell",
    text: "run ls",
    onEvent: (e) => {
      if (e.type === "approval") answerApproval(e.id, true);
    },
  });
  const shell = result.trace.find((t) => t.tool === "shell");
  assert.ok(shell, "shell should have run");
  assert.equal(shell.ok, true);
});

test("path escapes are refused even inside a shell-free tool", async () => {
  const result = await runAgent({
    sessionId: "test-escape",
    text: "read /etc/passwd",
    onEvent: (e) => {
      if (e.type === "approval") answerApproval(e.id, true);
    },
  });
  const read = result.trace.find((t) => t.tool === "read_file");
  assert.ok(read, "read_file should have been attempted");
  assert.match(String(read.output), /outside the allowed workspace/);
});


test("models: switch local/cloud requests without writing .env; invalid changes are atomic", async () => {
  const { brain } = await import("../src/brain.js");
  const envBefore = existsSync(".env") ? readFileSync(".env", "utf8") : null;
  try {
    const available = await brain.probe({ fresh: true });
    assert.deepEqual(available.ollama.models, ["fast:latest", "coder:7b"]);
    assert.deepEqual(await brain.setModel({ provider: "ollama", model: "fast" }), { provider: "ollama", model: "fast:latest" });
    assert.match((await brain.chat([{ role: "user", content: "hello" }])).content, /local fast:latest/);
    const snapshot = brain.active;
    assert.ok(Object.isFrozen(snapshot));
    await assert.rejects(brain.setModel({ provider: "ollama", model: "not-installed" }), /not installed/);
    await assert.rejects(brain.setModel({ provider: "__proto__", model: "bad" }), /Provider/);
    await assert.rejects(brain.setModel({ provider: "ollama", model: "bad name" }), /Model must use/);
    await assert.rejects(brain.setModel({ provider: "ollama", model: "coder:7b", url: "https://attacker.invalid" }), /Only provider and model/);
    await assert.rejects(brain.setModel({ provider: "openai", model: "<svg/onload=alert(1)>" }), /Model must use/);
    assert.deepEqual(brain.active, snapshot);
    await brain.setModel({ provider: "openai", model: "cloud-code" });
    assert.match((await brain.chat([{ role: "user", content: "hello" }])).content, /cloud cloud-code/);
    assert.equal(modelRequests.at(-1).path, "/v1/chat/completions");
    assert.equal(existsSync(".env") ? readFileSync(".env", "utf8") : null, envBefore);
  } finally { brain.resetModel(); }
});

test("models: unavailable Ollama leaves the active model unchanged", async () => {
  const { brain } = await import("../src/brain.js");
  const before = brain.active;
  tagsFail = true;
  try {
    await assert.rejects(brain.setModel({ provider: "ollama", model: "coder:7b" }), /unreachable/);
    assert.deepEqual(brain.active, before);
  } finally { tagsFail = false; brain.resetModel(); }
});

test("models: an in-flight tool loop keeps its provider/model; next turn uses the switch", async () => {
  const { brain } = await import("../src/brain.js");
  try {
    await brain.setModel({ provider: "ollama", model: "coder:7b" });
    const start = modelRequests.length;
    const result = await runAgent({ sessionId: "model-snapshot", text: "force-tool-loop", onEvent(event) {
      if (event.type === "tool") void brain.setModel({ provider: "openai", model: "cloud-next" });
    } });
    assert.ok(result.trace.some((t) => t.tool === "calculator"));
    assert.match(result.text, /local coder:7b/);
    assert.equal(modelRequests.length - start, 2);
    assert.ok(modelRequests.slice(start).every((r) => r.path === "/api/chat" && r.body.model === "coder:7b"));
    const next = await runAgent({ sessionId: "model-next", text: "hello" });
    assert.match(next.text, /cloud cloud-next/);
    const rows = readFileSync(join(process.env.PINCH_DATA, "telemetry.ndjson"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(rows.find((r) => r.sessionId === "model-snapshot").model, "coder:7b");
    assert.equal(rows.find((r) => r.sessionId === "model-next").model, "cloud-next");
  } finally { brain.resetModel(); }
});

test("models: /model is shared by every channel without calling the LLM", async () => {
  const { brain } = await import("../src/brain.js");
  const { routeMessage } = await import("../src/channels/router.js");
  try {
    for (const channel of ["telegram", "discord", "slack", "whatsapp", "web"]) {
      const replies = [];
      const start = modelRequests.length;
      const show = await routeMessage({ channel, text: "/model", send: async (text) => replies.push(text) });
      assert.equal(show.kind, "model");
      assert.match(replies[0], /Active model:/);
      assert.match(replies[0], /coder:7b/);
      await routeMessage({ channel, text: "/model fast", send: async (text) => replies.push(text) });
      assert.equal(brain.active.model, "fast:latest");
      assert.equal(modelRequests.length, start);
    }
    await routeMessage({ channel: "web", text: "/model default", send: async () => {} });
    assert.equal(brain.active.provider, "mock");
  } finally { brain.resetModel(); }
});


test("a recovered model is not primed with old offline transport errors", async () => {
  const { brain } = await import("../src/brain.js");
  const { loadSession } = await import("../src/store.js");
  try {
    await brain.setModel({ provider: "ollama", model: "coder:7b" });
    modelFailure = true;
    const failure = await runAgent({ sessionId: "recover-offline", text: "hello" });
    assert.equal(failure.error, "brain-unreachable");
    assert.match(failure.text, /model not found/);
    assert.equal(loadSession("recover-offline").messages.at(-1).error, "brain-unreachable");
    modelFailure = false;
    const recovered = await runAgent({ sessionId: "recover-offline", text: "try again" });
    assert.equal(recovered.error, null);
    assert.match(recovered.text, /local coder:7b/);
    assert.ok(!modelRequests.at(-1).body.messages.some((m) => m.role === "assistant" && /brain is unreachable/.test(m.content)));
    assert.equal(modelRequests.at(-1).body.think, false);
  } finally { modelFailure = false; brain.resetModel(); }
});

test("model requests never follow redirects, in streaming or non-streaming mode", async () => {
  const { brain } = await import("../src/brain.js");
  try {
    await brain.setModel({ provider: "ollama", model: "coder:7b" });
    modelRedirect = true;
    await assert.rejects(brain.chat([{ role: "user", content: "hello" }]));
    await assert.rejects(brain.chat([{ role: "user", content: "hello" }], { onDelta() {} }));
    assert.equal(redirectedRequests, 0);
  } finally { modelRedirect = false; brain.resetModel(); }
});


test("real-model greetings use a small no-tools request, not a canned bypass", async () => {
  const { brain } = await import("../src/brain.js");
  brain.resetModel(); await brain.setModel({ provider:"ollama",model:"fast:latest" });
  try {
    replyOverride={content:"Hello! What would you like to talk about?"};
    const count=modelRequests.length, events=[];
    const out=await runAgent({sessionId:"social-small",text:"hi",onEvent:e=>events.push(e)});
    assert.equal(modelRequests.length,count+1);
    assert.equal(out.text,replyOverride.content);
    assert.equal(modelRequests.at(-1).body.tools,undefined);
    assert.equal(modelRequests.at(-1).body.options.num_predict,128);
    assert.ok(!modelRequests.at(-1).body.messages[0].content.includes("## How you work on development tasks"));
    assert.ok(out.firstTextMs >= 0);
    assert.equal(events.filter(e=>e.type==="delta").map(e=>e.text).join(''),out.text);
  } finally { replyOverride=null;brain.resetModel(); }
});

test("reasoning is absent from live deltas, stored reply and the next model prompt",async()=>{
  const { brain }=await import("../src/brain.js");
  const { loadSession, appendMessage }=await import("../src/store.js");
  brain.resetModel();await brain.setModel({provider:"ollama",model:"fast:latest"});
  const leaked='Okay, the user said "Hi". Let me think about how to respond. PRIVATE_TRACE</think> Hello!';
  appendMessage("legacy-reasoning",{role:"assistant",content:leaked});
  try {
    replyOverride={content:leaked,thinking:"SEPARATE_PRIVATE_THINKING"};
    const events=[];const out=await runAgent({sessionId:"legacy-reasoning",text:"hello",onEvent:e=>events.push(e)});
    assert.equal(out.text,"Hello!");
    assert.equal(events.filter(e=>e.type==='delta').map(e=>e.text).join(''),"Hello!");
    assert.equal(loadSession("legacy-reasoning").messages.at(-1).content,"Hello!");
    assert.doesNotMatch(JSON.stringify(modelRequests.at(-1).body.messages),/PRIVATE_TRACE/);
    replyOverride={content:'<think>PRIVATE_TRACE with no answer'};
    const invalid=await runAgent({sessionId:"reasoning-only",text:"hi"});
    assert.equal(invalid.error,"model-output-invalid");assert.doesNotMatch(invalid.text,/PRIVATE_TRACE/);
  } finally {replyOverride=null;brain.resetModel();}
});

test("NDJSON final frames without a newline are consumed",async()=>{
  const {brain}=await import("../src/brain.js");brain.resetModel();await brain.setModel({provider:"ollama",model:"fast:latest"});
  try {streamWithoutNewline=true;replyOverride={content:'Hello!'};const out=await brain.chat([{role:'user',content:'hi'}],{onDelta(){}});assert.equal(out.content,'Hello!');}
  finally {streamWithoutNewline=false;replyOverride=null;brain.resetModel();}
});

test("a model cannot execute tools on the no-tools social route",async()=>{
  const {brain}=await import("../src/brain.js");brain.resetModel();await brain.setModel({provider:"ollama",model:"fast:latest"});
  try {
    replyOverride={content:'',tool_calls:[{function:{name:'calculator',arguments:{expression:'2+2'}}}]};
    const out=await runAgent({sessionId:'social-tool-refused',text:'hi'});
    assert.equal(out.error,'model-output-invalid');assert.deepEqual(out.trace,[]);assert.match(out.text,/No action was taken/);
  } finally {replyOverride=null;brain.resetModel();}
});


test("Qwen3 non-thinking control is explicit, without modifying stored/user messages",async()=>{
  const {brain}=await import("../src/brain.js");brain.resetModel();await brain.setModel({provider:"ollama",model:"fast:latest"});
  try {
    replyOverride={content:'Hi!'};
    const messages=[{role:'system',content:'Be conversational.'},{role:'user',content:'hi'}];
    await brain.chat(messages,{model:'qwen3:4b',think:false});
    assert.equal(modelRequests.at(-1).body.think,false);
    assert.match(modelRequests.at(-1).body.messages[0].content,/\/no_think/);
    assert.equal(messages[0].content,'Be conversational.');
    await brain.chat(messages,{model:'qwen3:4b',think:true});
    assert.equal(modelRequests.at(-1).body.think,true);
    assert.doesNotMatch(modelRequests.at(-1).body.messages[0].content,/\/no_think/);
  } finally {replyOverride=null;brain.resetModel();}
});
