import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "pinch-desktop-test-"));
const outside = await mkdtemp(join(tmpdir(), "pinch-desktop-outside-"));
process.env.PINCH_WORKSPACE = root;
process.env.PINCH_DATA = join(root, "data");
process.env.LLM_PROVIDER = "mock";
const { DesktopRuntime, desktopIntent, findDesktopFiles } = await import("../src/desktop.js");
const { resolveModelChoice } = await import("../src/model-choice.js");
const { companionEnv } = await import("../src/windows-companion.js");
const { ensureData, pendingReminders } = await import("../src/store.js");
const { createApproval } = await import("../src/agent.js");
ensureData();
after(async () => { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

function bridge() {
  const messages = [], actions = [];
  return { messages, actions, send: (m) => messages.push(m), action: async (a) => { actions.push(a); return "Action confirmed by native host."; } };
}

test("setup resolves menu numbers to installed names and rejects invalid numeric choices", () => {
  const models = ["qwen3:4b", "fast:latest"];
  assert.equal(resolveModelChoice("1", models), "qwen3:4b");
  assert.equal(resolveModelChoice("2", models), "fast:latest");
  assert.equal(resolveModelChoice("", models), "qwen3:4b");
  assert.equal(resolveModelChoice("qwen3:4b", models), "qwen3:4b");
  for (const input of ["0", "3", "99999999999999999999"]) assert.throws(() => resolveModelChoice(input, models), /installed model number/);
  assert.throws(() => resolveModelChoice("1", []), /installed model number/);
  assert.throws(() => resolveModelChoice("model; rm -rf", models), /model name/);
});

test("desktop intent routing never turns arbitrary app names, schemes or shell text into programs", () => {
  assert.deepEqual(desktopIntent("open Calculator"), { kind: "native", action: "calculator" });
  assert.equal(desktopIntent("open github").url, "https://github.com/");
  for (const text of ["open calc.exe & echo injected", "open javascript:alert(1)", "open file:///C:/secret", "open http://example.com", "open https://user:pass@example.com", "open C:\\Windows\\cmd.exe"])
    assert.equal(desktopIntent(text).kind, "unsupported-open");
  assert.equal(desktopIntent("open https://example.com/?q=hello?").url, "https://example.com/?q=hello?");
});

test("time, status, known apps, file search and reminders do not call the language model", async () => {
  let calls = 0;
  const runtime = new DesktopRuntime({ agent: async () => { calls++; throw Error("not allowed"); }, finder: async () => "found in workspace" });
  const native = bridge(); runtime.attach(native);
  for (const text of ["what time is it", "system status", "open calculator", "find README", "remind me in 20 minutes to stretch"]) {
    const result = await runtime.request(text);
    assert.equal(result.ok, true, result.text); assert.equal(result.fastPath, true);
  }
  assert.equal(calls, 0); assert.equal(native.actions[0].action, "calculator");
  assert.equal(pendingReminders().at(-1).address, "desktop:resident");
  assert.match(runtime.snapshot().text, /must be running/);
});

test("missing companion, invalid inputs, unsupported apps and past reminders are honest", async () => {
  const runtime = new DesktopRuntime();
  assert.equal(runtime.snapshot().available, false);
  assert.equal((await runtime.request("open calculator")).ok, false);
  assert.match((await runtime.request("open unknown.exe")).text, /will not guess/);
  assert.match((await runtime.request("remind me 1990-01-01 to test")).text, /future time/);
  await assert.rejects(runtime.request(""), /1–2000/);
  await assert.rejects(runtime.request({ text: "hello" }), /1–2000/);
  await assert.rejects(runtime.request("a".repeat(2001)), /1–2000/);
  assert.throws(() => runtime.control("listen"), /not running/);
});

test("desktop requests refuse cloud inference and do not call the agent", async () => {
  let calls = 0;
  const runtime = new DesktopRuntime({ selection: () => ({ provider: "openai" }), agent: async () => { calls++; } }); runtime.attach(bridge());
  const result = await runtime.request("tell me about my day");
  assert.equal(result.ok, false); assert.match(result.text, /No remote model or cloud fallback/); assert.equal(calls, 0);
});

test("clipboard contents are local action results, never appended to an agent prompt", async () => {
  let calls = 0;
  const runtime = new DesktopRuntime({ agent: async () => { calls++; } }); const native = bridge();
  native.action = async (intent) => { assert.equal(intent.action, "clipboard"); return "private clipboard sample"; };
  runtime.attach(native);
  assert.equal((await runtime.request("read my clipboard")).text, "private clipboard sample");
  assert.equal(calls, 0);
  assert.deepEqual(runtime.snapshot().recent.map((r) => r.command), ["read my clipboard"]);
});

test("one in-flight desktop request; a second request cannot approve it by voice", async () => {
  let finish;
  const runtime = new DesktopRuntime({ agent: () => new Promise((r) => { finish = r; }) }); runtime.attach(bridge());
  const first = runtime.request("a complex request");
  await assert.rejects(runtime.request("yes"), /current request/);
  finish({ text: "done" }); await first; assert.equal(runtime.busy, false);
});

test("desktop approvals are scoped and require boolean input; disconnect denies pending work", async () => {
  let owned;
  const runtime = new DesktopRuntime({ agent: async ({ onEvent }) => {
    owned = createApproval({ channel: "desktop", sessionId: "desktop-resident", description: "test action" });
    onEvent({ type: "approval", id: owned.id, description: "test action" });
    return { text: (await owned.promise) ? "allowed" : "denied" };
  } }); runtime.attach(bridge());
  const foreign = createApproval({ channel: "web", sessionId: "other", description: "foreign" });
  const request = runtime.request("a complex request");
  assert.equal(runtime.approve(foreign.id, true), false);
  assert.equal(runtime.approve(owned.id, "true"), false);
  assert.equal(runtime.approve(owned.id, true), true);
  assert.equal((await request).text, "allowed");
  const { answerApproval } = await import("../src/agent.js"); answerApproval(foreign.id, false); await foreign.promise;
  const next = runtime.request("another complex request"); runtime.detach();
  assert.equal((await next).text, "denied");
});

test("file finder excludes symlinks/hidden data, uses the workspace guard, and reports bounded coverage", async () => {
  await mkdir(join(root, "docs")); await writeFile(join(root, "docs", "README.md"), "safe");
  await writeFile(join(root, ".env"), "SECRET=private");
  await writeFile(join(outside, "outside-README.md"), "outside");
  await symlink(outside, join(root, "linked-outside"), process.platform === "win32" ? "junction" : "dir");
  const result = await findDesktopFiles("README");
  assert.match(result, /README.md/); assert.doesNotMatch(result, /outside-README/); assert.match(result, /not a full-disk search/);
  assert.doesNotMatch(await findDesktopFiles("env"), /SECRET|\.env/);
  assert.match(await findDesktopFiles("../README"), /not a path/);
  assert.match(await findDesktopFiles("absent", { limit: 1 }), /Searched 1 entries/);
});

test("native child environment omits all model, messaging and instance credentials", () => {
  assert.deepEqual(companionEnv({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", PINCH_KEY: "secret", OPENAI_API_KEY: "secret", TELEGRAM_TOKEN: "secret", PATH: "untrusted" }), { SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
});

test("command deck loads a local script, avoids browser speech, and safely renders remote text", () => {
  const html = readFileSync(new URL("../public/desktop.html", import.meta.url), "utf8");
  const source = readFileSync(new URL("../public/desktop.js", import.meta.url), "utf8");
  assert.ok(html.includes('<script src="/desktop.js" defer></script>'));
  // Check the actual JavaScript, not an HTML tag extracted with a filtering regexp.
  assert.doesNotMatch(html + source, /new (?:webkit)?SpeechRecognition|getUserMedia|innerHTML\s*=/);
  assert.match(source, /textContent=record|textContent=\(record/);
  assert.match(source, /sessionStorage.setItem/);
  assert.doesNotThrow(() => new Script(source, { filename: "desktop.js" }));
});

test("non-Windows desktop launcher refuses to pretend a native companion is running", { skip: process.platform === "win32" }, () => {
  assert.throws(() => execFileSync(process.execPath, [new URL("../scripts/desktop.js", import.meta.url).pathname], { encoding: "utf8", stdio: "pipe" }), /requires Windows/);
});


test("reminders arriving during an approval do not clear native gates or resume the microphone", async () => {
  let owned;
  const runtime = new DesktopRuntime({ agent: async ({ onEvent }) => {
    owned = createApproval({ channel: "desktop", sessionId: "desktop-resident", description: "pending action" });
    onEvent({ type: "approval", id: owned.id, description: "pending action" });
    await owned.promise; return { text: "Request finished." };
  } });
  const native = bridge(); runtime.attach(native);
  const request = runtime.request("a complex request");
  runtime.notify("Time to stretch.");
  assert.equal(runtime.snapshot().phase, "approval");
  assert.equal(runtime.snapshot().approval.id, owned.id);
  assert.equal(native.messages.some((m) => m.op === "reply"), false);
  assert.equal(runtime.approve(owned.id, false), true);
  assert.match((await request).text, /Reminder: Time to stretch/);
  assert.equal(native.messages.filter((m) => m.op === "reply").length, 1);
});

test("PowerShell compilation resolves installed GAC assembly locations, not bare speech DLL names", () => {
  const script = readFileSync(new URL("../desktop/windows.ps1", import.meta.url), "utf8");
  assert.match(script, /\[System\.Speech\.Recognition\.SpeechRecognitionEngine\]\.Assembly\.Location/);
  assert.match(script, /-ReferencedAssemblies \$references/);
  assert.doesNotMatch(script, /['"]System\.Speech\.dll['"]/);
});


test("native speech diagnostics are bounded, scoped to an attached host, and never execute rejected text", () => {
  let calls = 0;
  const runtime = new DesktopRuntime({ agent: async () => { calls++; } });
  assert.equal(runtime.recognition({ status: "error", detail: "not attached" }), false);
  runtime.attach(bridge());
  assert.equal(runtime.recognition({ status: "unknown", text: "open calculator" }), false);
  assert.equal(runtime.recognition({ status: "rejected", detail: "x".repeat(700), text: "open calculator", confidence: 0.2 }), true);
  assert.equal(runtime.snapshot().speech.detail.length, 600);
  assert.equal(runtime.snapshot().speech.confidence, 0.2);
  assert.equal(calls, 0);
  const copy = runtime.snapshot(); copy.speech.text = "changed";
  assert.equal(runtime.snapshot().speech.text, "open calculator");
  runtime.update({ phase: "approval" }); runtime.busy = true;
  runtime.recognition({ status: "error", detail: "device unplugged" });
  assert.equal(runtime.snapshot().phase, "approval");
});

test("native recognizer reports rejection, default-input problems and completion failures", () => {
  const source = readFileSync(new URL("../desktop/Companion.cs", import.meta.url), "utf8");
  for (const event of ["SpeechRecognitionRejected", "AudioSignalProblemOccurred", "SpeechDetected", "InitialSilenceTimeout"])
    assert.ok(source.includes(event));
  assert.ok(source.includes('SpeechStatus("error", e.Error.Message'));
  assert.ok(source.includes('else if (!e.Cancelled) StartRecognition(false)'));
  assert.ok(source.includes('if (!e.Cancelled && e.InputStreamEnded)'));
  assert.ok(source.includes('string next = SpeechGate.Complete()'));
  const cancelCode = source.slice(source.indexOf('static void SpeechAction'),source.indexOf('static void StopSpeech'));
  assert.doesNotMatch(cancelCode, /Recognizer\.Dispose\(/);
  assert.ok(source.includes('SpeechSessionGate.SelfTest()'));
  assert.ok(source.includes('rec.AudioLevelUpdated +='));
  assert.ok(source.includes('if (capture) LoadCaptureGrammars(rec, info.Culture)'));
  const doctor=readFileSync(new URL('../desktop/SpeechDoctor.cs', import.meta.url),'utf8');
  assert.ok(doctor.includes('QuasnoozeCompanion.LoadCaptureGrammars(rec, info.Culture)'));
  assert.ok(doctor.includes('QuasnoozeCompanion.LoadCaptureGrammars(engine, info.Culture)'));
  assert.ok(source.includes('if (!WantWake || Working || Quitting || CurrentPrompt != null) return;'));
  assert.ok(source.includes('if (WantWake && !Working && !Quitting && CurrentPrompt == null)'));
  assert.ok(source.includes('Window.Show(); Window.Activate();'));
});


test("audio level only represents fresh, attached active capture and rejects malformed native values", () => {
  const runtime = new DesktopRuntime();
  assert.equal(runtime.audio(30), false);
  runtime.attach(bridge()); assert.equal(runtime.audio(30), false);
  runtime.update({ mic: true });
  for (const level of [-1, 101, NaN, Infinity, "50", null]) assert.equal(runtime.audio(level), false);
  assert.equal(runtime.audio(30.2), true);
  assert.equal(runtime.snapshot().audioLevel, 30);
  assert.ok(runtime.snapshot().audioAgeMs >= 0);
  runtime.detach(); assert.equal(runtime.audio(50), false);
});


test("speech doctor refuses unsupported platforms without opening a microphone", { skip: process.platform === "win32" }, () => {
  assert.throws(() => execFileSync(process.execPath, [new URL("../scripts/desktop-doctor.js", import.meta.url).pathname], { encoding: "utf8", stdio: "pipe" }), /requires Windows/);
});


test("resident model drafts appear before final completion and clear after it",async()=>{
  let finish;
  const runtime=new DesktopRuntime({agent:async({onEvent})=>{
    onEvent({type:'delta',text:'Hello!'});
    await new Promise(resolve=>{finish=resolve;});
    return {text:'Hello! How are you?'};
  }}); runtime.attach(bridge());
  const pending=runtime.request('hi');
  assert.equal(runtime.snapshot().draft,'Hello!');assert.ok(runtime.snapshot().firstTextMs>=0);
  finish();assert.equal((await pending).text,'Hello! How are you?');
  assert.equal(runtime.snapshot().draft,'');
});


test('desktop persona commands work locally without native host or model inference',async()=>{
 let calls=0;
 const runtime=new DesktopRuntime({agent:async()=>{calls++;throw Error('must not call model');}});
 assert.match((await runtime.request('/persona save local-style Keep answers short.')).text,/Saved persona/);
 const result=await runtime.request('/persona use local-style');
 assert.equal(result.fastPath,true);assert.match(result.text,/now uses/);assert.equal(calls,0);
 await runtime.request('/persona use default');await runtime.request('/persona delete local-style');
});

test('desktop never reports COMPLETED/ready or speaks aloud when guard flags, denials, or contradictions occur', async () => {
  const native = bridge();
  let nextResult;
  const runtime = new DesktopRuntime({ agent: async () => nextResult });
  runtime.attach(native);

  // 1) Hallucinated action with zero tool calls (guard flagged)
  nextResult = {
    text: "I've sent the email.\n\n---\n🛡️ **Code check:** ...",
    trace: [],
    guard: [{ code: "action-without-evidence", message: 'the reply says "sent" but no tool ran' }],
    error: null,
  };
  const guarded = await runtime.request("email priya");
  assert.equal(guarded.ok, false);
  assert.equal(guarded.acted, false);
  assert.equal(runtime.snapshot().phase, "attention");
  assert.equal(runtime.snapshot().recent[0].ok, false);
  assert.equal(native.messages.at(-1).speak, false);

  // 2) Contradicted read-back
  nextResult = {
    text: "Wrote notes.txt",
    trace: [{ tool: "write_file", ok: true, verification: { status: "contradicted", detail: "missing" } }],
    guard: [],
    error: null,
  };
  const contradicted = await runtime.request("save notes.txt");
  assert.equal(contradicted.ok, false);
  assert.equal(contradicted.acted, false);
  assert.equal(runtime.snapshot().phase, "attention");

  // 3) Honest conversational reply where zero tools ran
  nextResult = { text: "Recursion is a function calling itself.", trace: [], guard: [], error: null };
  const conversational = await runtime.request("explain recursion");
  assert.equal(conversational.ok, true);
  assert.equal(conversational.acted, false);
  assert.equal(runtime.snapshot().phase, "ready");
  assert.equal(runtime.snapshot().acted, false);
  assert.equal(native.messages.at(-1).speak, true);

  // 4) Real verified tool execution
  nextResult = {
    text: "Added task.",
    trace: [{ tool: "add_task", ok: true, verification: { status: "verified", detail: "present" } }],
    guard: [],
    error: null,
  };
  const acted = await runtime.request("add task buy milk");
  assert.equal(acted.ok, true);
  assert.equal(acted.acted, true);
  assert.equal(runtime.snapshot().acted, true);
});

