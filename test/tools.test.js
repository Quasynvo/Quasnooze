/**
 * tests for the pure, security-sensitive bits: the maths evaluator, the
 * command screen and the workspace sandbox. These are the pieces where a bug
 * is not cosmetic.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the sandbox at a temp dir before anything imports config.
const sandbox = mkdtempSync(join(tmpdir(), "pinch-test-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_AUTO_APPROVE = "false";
process.env.PINCH_DATA = join(sandbox, "data");

const { calculate, screenCommand, resolveInWorkspace, SafePathError } = await import("../src/tools.js");
const { splitForLimit } = await import("../src/channels/router.js");
const { parseEnv } = await import("../src/config.js");

test("calculator handles precedence and parentheses", () => {
  assert.equal(calculate("2+3*4"), 14);
  assert.equal(calculate("(2+3)*4"), 20);
  assert.equal(calculate("2^3^2"), 512); // right associative
  assert.equal(calculate("-3 + 10"), 7);
  assert.equal(calculate("10 % 3"), 1);
});

test("calculator supports constants and functions", () => {
  assert.ok(Math.abs(calculate("sqrt(16)") - 4) < 1e-9);
  assert.ok(Math.abs(calculate("pi") - Math.PI) < 1e-9);
  assert.equal(calculate("max(3, 9)"), 9);
  assert.ok(Math.abs(calculate("round(2.6)") - 3) < 1e-9);
});

test("calculator refuses anything that is not arithmetic", () => {
  // No eval() anywhere, so injection is impossible by construction — the only
  // question is which error comes back.
  assert.throws(() => calculate("process.exit(1)"), /Unknown name|Only numbers/);
  assert.throws(() => calculate("require('fs')"), /Unknown name|Only numbers/);
  assert.throws(() => calculate("2+"), /Malformed|Could not/);
});

test("screenCommand blocks catastrophic commands", () => {
  assert.equal(screenCommand("rm -rf /").allowed, false);
  assert.equal(screenCommand("mkfs.ext4 /dev/sda1").allowed, false);
  assert.equal(screenCommand("dd if=/dev/zero of=/dev/sda").allowed, false);
  assert.equal(screenCommand(":(){ :|:& };:").allowed, false);
});

test("screenCommand allows ordinary development commands", () => {
  for (const cmd of ["npm test", "git status --short", "python -m pytest -q", "ls -la", "rm -rf ./build"]) {
    assert.equal(screenCommand(cmd).allowed, true, cmd);
  }
});

test("workspace sandbox allows paths inside and blocks escapes", () => {
  assert.equal(resolveInWorkspace("src/app.js").startsWith(sandbox), true);
  assert.equal(resolveInWorkspace(sandbox), sandbox);
  assert.throws(() => resolveInWorkspace("/etc/passwd"), SafePathError);
  assert.throws(() => resolveInWorkspace("../../../../etc/passwd"), SafePathError);
  assert.throws(() => resolveInWorkspace("~/../../etc/passwd"), SafePathError);
});

test("dangling symlinks cannot redirect workspace writes outside the sandbox", async (t) => {
  const outside = mkdtempSync(join(tmpdir(), "pinch-outside-"));
  const link = join(sandbox, "dangling-write");
  const target = join(outside, "created.txt");
  try {
    try { symlinkSync(target, link, "file"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip("symlinks unavailable");
      throw error;
    }
    const { TOOL_MAP } = await import("../src/tools.js");
    await assert.rejects(TOOL_MAP.get("write_file").run({ path: link, content: "escape" }), SafePathError);
    assert.equal(existsSync(target), false);
    assert.throws(() => resolveInWorkspace(join(link, "child")), SafePathError);
    assert.equal(resolveInWorkspace("new-file.txt"), join(sandbox, "new-file.txt"));
  } finally {
    rmSync(link, { force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("splitForLimit never loses characters and respects the limit", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of something reasonably long`).join("\n");
  const parts = splitForLimit(text, 400);
  assert.ok(parts.every((p) => p.length <= 400));
  assert.equal(parts.join("").replace(/\n/g, ""), text.replace(/\n/g, ""));
});

test("env parser ignores comments and keeps quoted values", () => {
  const env = parseEnv(`# comment\nA=1\nB="two words"\n\nC='single'\nBAD LINE\nD=`);
  assert.deepEqual(env, { A: "1", B: "two words", C: "single", D: "" });
});


const { loadLocalTools, TOOL_MAP, DANGEROUS, toolSchemas } = await import('../src/tools.js');
const plugins = mkdtempSync(join(tmpdir(), 'pinch-plugins-'));
after(() => { rmSync(plugins, {recursive:true,force:true}); rmSync(sandbox, {recursive:true,force:true}); });
const quiet = {warn() {}};
function moduleFile(file, name, extra = '') {
  writeFileSync(join(plugins,file), `export default {name:${JSON.stringify(name)},description:'Local fixture',parameters:{type:'object',properties:{}},${extra}run:async()=>({ok:true,output:'local result'})};`);
}
test('local .js/.mjs modules register schemas, default to approval and cannot shadow tools', async () => {
  writeFileSync(join(plugins,'package.json'), '{"type":"module"}');
  moduleFile('a-echo.mjs','local_echo','dangerous:false,');
  moduleFile('b-trusted.js','local_trusted','trusted:true,');
  moduleFile('c-force.mjs','local_force','trusted:true,dangerous:true,');
  moduleFile('d-shadow.mjs','shell','trusted:true,');
  moduleFile('e-duplicate.mjs','local_echo','trusted:true,');
  moduleFile('f-not-trusted.mjs','local_not_trusted','trusted:"true",dangerous:false,');
  writeFileSync(join(plugins,'g-malformed.mjs'), 'export default {name:"broken"};');
  writeFileSync(join(plugins,'h-broken.mjs'), 'throw new Error("bad module");');
  writeFileSync(join(plugins,'ignored.txt'), 'throw new Error("must not import");');
  mkdirSync(join(plugins,'ignored-directory'));
  const shell = TOOL_MAP.get('shell');
  assert.deepEqual(await loadLocalTools({dir:'',log:quiet}),{registered:[],skipped:[]});
  const report = await loadLocalTools({dir:plugins,log:quiet});
  assert.deepEqual(report.registered,['local_echo','local_trusted','local_force','local_not_trusted']);
  assert.equal(report.skipped.length,4);
  assert.equal(TOOL_MAP.get('shell'),shell);
  for(const name of ['local_echo','local_force','local_not_trusted']) {
    assert.equal(DANGEROUS.has(name),true);assert.equal(TOOL_MAP.get(name).dangerous,true);
  }
  assert.equal(DANGEROUS.has('local_trusted'),false);
  assert.ok(toolSchemas().some(schema=>schema.function.name==='local_echo'));
  assert.equal((await TOOL_MAP.get('local_echo').run({})).output,'local result');
  assert.equal(TOOL_MAP.has('broken'),false);
});
test('missing directories and model-writable plugin directories fail closed without importing', async () => {
  assert.equal((await loadLocalTools({dir:join(plugins,'missing'),log:quiet})).skipped.length,1);
  const inside = join(sandbox,'plugins');mkdirSync(inside);
  const marker=join(sandbox,'must-not-import');
  writeFileSync(join(inside,'bad.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');`);
  assert.equal((await loadLocalTools({dir:inside,log:quiet})).skipped.length,1);
  assert.equal(existsSync(marker),false);
});
test('local plugin calls really wait for approval, denial and unattended refusal never run', async () => {
  const {brain}=await import('../src/brain.js');
  const {runAgent,answerApproval}=await import('../src/agent.js');
  const original=brain.chat, tool=TOOL_MAP.get('local_echo'), run=tool.run;
  let ran=0;
  tool.run=async()=>{ran++;return {ok:true,output:'approved local result'};};
  try {
    for(const mode of ['deny','allow','unattended']) {
      let count=0, asked=0, offered=false;
      brain.chat=async(messages,options)=>{
        offered ||= options.tools?.some(schema=>schema.function.name==='local_echo');
        return count++===0 ? {content:'',toolCalls:[{id:'plugin-call',name:'local_echo',arguments:{}}]} : {content:'Finished.',toolCalls:[]};
      };
      const before=ran;
      const result=await runAgent({sessionId:'plugin-'+mode,text:'Use my local tool',autonomy:mode==='unattended'?'unattended':'interactive',onEvent:event=>{
        if(event.type==='approval') {asked++;assert.equal(ran,before);answerApproval(event.id,mode==='allow');}
      }});
      assert.ok(offered);
      assert.equal(asked,mode==='unattended'?0:1);
      assert.equal(ran,before+(mode==='allow'?1:0));
      assert.ok(result.trace.some(item=>mode==='allow'?item.ok:item.denied));
    }
  } finally {brain.chat=original;tool.run=run;}
});
test('terminal CLI loads configured local plugins before answering', async () => {
  const {execFileSync}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const dir=mkdtempSync(join(tmpdir(),'pinch-plugin-cli-'));
  const marker=join(dir,'loaded');
  try {
    writeFileSync(join(dir,'cli plugin #1.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');export default {name:'cli_fixture',description:'CLI fixture',parameters:{type:'object'},run:async()=>({ok:true,output:'yes'})};`);
    execFileSync(process.execPath,[fileURLToPath(new URL('../src/cli.js',import.meta.url)),'ask','hello'],{env:{...process.env,PINCH_TOOLS_DIR:dir},timeout:10000,stdio:'pipe'});
    assert.equal(existsSync(marker),true);
  } finally {rmSync(dir,{recursive:true,force:true});}
});


test('dot-prefixed workspace directories and symlink plugin entries cannot bypass loading restrictions', async (t) => {
  const inside=join(sandbox,'..plugins');mkdirSync(inside);
  writeFileSync(join(inside,'bad.mjs'),'throw new Error("should not be imported")');
  const warnings=[];
  assert.equal((await loadLocalTools({dir:inside,log:{warn:line=>warnings.push(line)}})).skipped.length,1);
  assert.match(warnings[0],/outside every PINCH_WORKSPACE/);
  const links=mkdtempSync(join(tmpdir(),'pinch-plugin-links-'));
  try {
    try {symlinkSync(join(plugins,'a-echo.mjs'),join(links,'linked.mjs'),'file');}
    catch(error) {if(['EPERM','EACCES','ENOSYS'].includes(error.code)){t.diagnostic('File symlink permission unavailable; workspace restriction verified.');return;}throw error;}
    const result=await loadLocalTools({dir:links,log:quiet});
    assert.deepEqual(result.registered,[]);assert.deepEqual(result.skipped,['linked.mjs']);
  } finally {rmSync(links,{recursive:true,force:true});}
});


test('server boot registers local plugins before opening the web panel', async () => {
  const {spawn}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const dir=mkdtempSync(join(tmpdir(),'pinch-plugin-server-'));
  const marker=join(dir,'loaded');
  writeFileSync(join(dir,'boot.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');export default {name:'boot_fixture',description:'Boot fixture',parameters:{type:'object'},run:async()=>({ok:true,output:'yes'})};`);
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/index.js',import.meta.url))],{
    env:{...process.env,PINCH_TOOLS_DIR:dir,PINCH_PORT:'0',PINCH_HOST:'127.0.0.1',PINCH_KEY:'',PINCH_TOOLS:''},stdio:['ignore','pipe','pipe']});
  let output='';
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('server did not become ready: '+output)),10000);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('exit',code=>{clearTimeout(timer);reject(new Error('server exited '+code+': '+output));});
      child.stderr.on('data',data=>{output+=data;});
      child.stdout.on('data',data=>{output+=data;if(output.includes('web panel:')){clearTimeout(timer);resolve();}});
    });
    assert.equal(existsSync(marker),true);
    assert.match(output,/local tools: boot_fixture/);
  } finally {
    if(child.exitCode===null && child.signalCode===null) {
      await new Promise(resolve=>{child.once('exit',resolve);child.kill();});
    }
    rmSync(dir,{recursive:true,force:true});
  }
});

/* ── system_control: volume & media transport (laptop-01) ─────────────────
 * The contract under test: explicit params, typed results, bounded errors
 * (never clamped), no shell for audio, and honest degradation without the
 * Windows companion. */

const SYS_MEDIA_ACTIONS = ["volume_up","volume_down","set_volume","mute","unmute","media_play_pause","media_next","media_previous"];

test("system_control schema exposes lock/sleep plus the volume/media actions with a bounded integer level", () => {
  const schema = toolSchemas().find((s) => s.function.name === "system_control").function.parameters;
  for (const action of ["lock", "sleep", ...SYS_MEDIA_ACTIONS]) {
    assert.ok(schema.properties.action.enum.includes(action), `schema must offer ${action}`);
  }
  assert.ok(!schema.properties.action.enum.includes("shutdown"), "shutdown stays deliberately absent");
  assert.equal(schema.properties.level.type, "integer");
  assert.equal(schema.properties.level.minimum, 0);
  assert.equal(schema.properties.level.maximum, 100);
});

test("set_volume rejects out-of-range and non-integer levels with the bound named — never clamps", async () => {
  const sys = TOOL_MAP.get("system_control");
  for (const level of [500, -1, 101, 50.5, "50", undefined]) {
    const res = await sys.run({ action: "set_volume", level });
    assert.equal(res.ok, false, `level ${String(level)} must be rejected`);
    assert.match(res.output, /between 0 and 100/);
    assert.match(res.output, /Nothing was changed/);
    assert.equal(res.state, undefined, "a rejected call must not fabricate a resulting state");
  }
});

test("level is rejected on any action other than set_volume — including lock, where no shell may run", async () => {
  const sys = TOOL_MAP.get("system_control");
  for (const action of ["volume_up", "mute", "lock"]) {
    const res = await sys.run({ action, level: 10 });
    assert.equal(res.ok, false);
    assert.match(res.output, /only accepted with set_volume/);
    assert.match(res.output, /Nothing was changed/);
  }
});

test("volume/media degrade with an actionable typed failure when no companion is attached", async () => {
  const { desktop } = await import("../src/desktop.js");
  assert.ok(!desktop.bridge, "precondition: no companion in this test process");
  const res = await TOOL_MAP.get("system_control").run({ action: "volume_up" });
  assert.equal(res.ok, false);
  assert.match(res.output, /Windows companion/);
  assert.match(res.output, /npm run desktop/);
  assert.match(res.output, /Nothing was changed/);
});

test("volume actions route through the companion bridge as enum + integer and report resulting state", async () => {
  const { desktop } = await import("../src/desktop.js");
  const sent = [];
  desktop.attach({ send() {}, action: async (a) => { sent.push(a); return JSON.stringify({ level: 40, muted: false, transport: "none" }); } });
  try {
    const res = await TOOL_MAP.get("system_control").run({ action: "set_volume", level: 40 });
    assert.deepEqual(sent, [{ action: "media", media: "set_volume", level: 40 }], "wire payload is an enum and an integer — no shell text");
    assert.equal(res.ok, true);
    assert.deepEqual(res.state, { level: 40, muted: false });
    assert.match(res.output, /40%/);
    assert.match(res.output, /not muted/);
  } finally { desktop.detach(); }
});

test("media transport reports the key send as unverified while stating the audio state it could verify", async () => {
  const { desktop } = await import("../src/desktop.js");
  const sent = [];
  desktop.attach({ send() {}, action: async (a) => { sent.push(a); return JSON.stringify({ level: 25, muted: true, transport: "key-sent-unverified" }); } });
  try {
    const res = await TOOL_MAP.get("system_control").run({ action: "media_play_pause" });
    assert.deepEqual(sent, [{ action: "media", media: "media_play_pause" }], "no level is sent when none applies");
    assert.equal(res.ok, true);
    assert.equal(res.state.transport, "key-sent-unverified");
    assert.match(res.output, /not verifiable/);
    assert.match(res.output, /25%/);
  } finally { desktop.detach(); }
});

test("a companion reply without typed state is reported as unknown, not dressed up as success", async () => {
  const { desktop } = await import("../src/desktop.js");
  desktop.attach({ send() {}, action: async () => "Action confirmed by native host." });
  try {
    const res = await TOOL_MAP.get("system_control").run({ action: "mute" });
    assert.equal(res.ok, false);
    assert.match(res.output, /unknown/);
    assert.match(res.output, /check the device/);
  } finally { desktop.detach(); }
});

/* ── clipboard read & write behind a preview (laptop-03) ───────────────── */

const {
  CLIPBOARD_READ_MAX_BYTES,
  CLIPBOARD_WRITE_MAX_BYTES,
  truncateUtf8,
  inspectClipboardSecret,
  setClipboardAdapterForTests,
  clearClipboardStateForTests,
} = await import("../src/tools.js");

test("read_clipboard and write_clipboard are dangerous tools and respect QUASNOOZE_CLIPBOARD=off", async () => {
  assert.equal(DANGEROUS.has("read_clipboard"), true);
  assert.equal(DANGEROUS.has("write_clipboard"), true);
  assert.ok(toolSchemas().some((s) => s.function.name === "read_clipboard"));
  assert.ok(toolSchemas().some((s) => s.function.name === "write_clipboard"));

  const prev = process.env.QUASNOOZE_CLIPBOARD;
  let touched = false;
  setClipboardAdapterForTests({
    read: async () => { touched = true; return "should not read"; },
    write: async () => { touched = true; },
  });
  try {
    process.env.QUASNOOZE_CLIPBOARD = "off";
    assert.equal(toolSchemas().some((s) => s.function.name === "read_clipboard"), false);
    assert.equal(toolSchemas().some((s) => s.function.name === "write_clipboard"), false);

    const r = await TOOL_MAP.get("read_clipboard").run({});
    assert.equal(r.ok, false);
    assert.match(r.output, /disabled.*QUASNOOZE_CLIPBOARD=off/);

    const w = await TOOL_MAP.get("write_clipboard").run({ text: "hello" });
    assert.equal(w.ok, false);
    assert.match(w.output, /disabled.*QUASNOOZE_CLIPBOARD=off/);
    assert.equal(touched, false, "disabled clipboard tools must never touch the OS clipboard");
  } finally {
    if (prev === undefined) delete process.env.QUASNOOZE_CLIPBOARD;
    else process.env.QUASNOOZE_CLIPBOARD = prev;
    clearClipboardStateForTests();
  }
});

test("read_clipboard bounds output to 4,096 UTF-8 bytes without splitting multibyte characters and reports original byte count", async () => {
  try {
    setClipboardAdapterForTests({ read: async () => "" });
    const empty = await TOOL_MAP.get("read_clipboard").run({});
    assert.equal(empty.ok, true);
    assert.match(empty.output, /empty \(0 bytes\)/);

    setClipboardAdapterForTests({ read: async () => "Quarterly planning summary: launch moved to Friday." });
    const shortRes = await TOOL_MAP.get("read_clipboard").run({});
    assert.equal(shortRes.ok, true);
    assert.match(shortRes.output, /Clipboard \(51 bytes\):/);
    assert.match(shortRes.output, /Quarterly planning summary/);

    // Place a 4-byte emoji right across the 4,096-byte boundary ("a" * 4094 + "😀" * 500 = 6,094 bytes).
    const boundaryText = "a".repeat(CLIPBOARD_READ_MAX_BYTES - 2) + "😀".repeat(500);
    const expectedTotalBytes = Buffer.byteLength(boundaryText, "utf8");
    assert.equal(expectedTotalBytes, 6094);
    setClipboardAdapterForTests({ read: async () => boundaryText });

    const longRes = await TOOL_MAP.get("read_clipboard").run({});
    assert.equal(longRes.ok, true);
    assert.match(longRes.output, /6094 bytes total; truncated to 4094 bytes/);
    assert.equal(longRes.output.includes("\uFFFD"), false, "UTF-8 truncation must never split a code point");

    const unit = truncateUtf8("a😀b", 3);
    assert.equal(unit.text, "a");
    assert.equal(unit.originalBytes, 6);
    assert.equal(unit.shownBytes, 1);
    assert.equal(unit.truncated, true);
  } finally {
    clearClipboardStateForTests();
  }
});

test("read_clipboard refuses secret-shaped content with an explanation instead of silently truncating", async () => {
  const secretSamples = [
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n-----END OPENSSH PRIVATE KEY-----", /private-key header/],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAtest\n-----END RSA PRIVATE KEY-----", /private-key header/],
    ["AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ", /private-key header/],
    ["Tr0ub4dor&3!xK9", /password/],
    ["kivtag-7jufPy-zabqox", /password/],
    ["correct-horse-battery-staple-9", /passphrase|password/],
    ["Username: alice@example.com\nPassword: SuperSecret!Password99", /password-manager|credential/],
    ["sk-proj-1234567890abcdefghijklmnop", /API key|access token|credential/],
    ["ghp_1234567890abcdefghijklmnopqrstuvwxyz", /API key|access token|credential/],
    ["postgres://admin:s3cr3tPass@db.internal:5432/prod", /credentials embedded in a URL/],
    // Secret placed PAST the 4,096-byte truncation cap: must STILL be refused, never silently truncated away!
    [" benign note ".repeat(400) + "\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----", /private-key header/],
  ];

  try {
    for (const [sample, expectedReason] of secretSamples) {
      setClipboardAdapterForTests({ read: async () => sample });
      const res = await TOOL_MAP.get("read_clipboard").run({});
      assert.equal(res.ok, false, `expected secret refusal for ${sample.slice(0, 40)}`);
      assert.match(res.output, /Refused to read the clipboard/);
      assert.match(res.output, expectedReason);
      assert.match(res.output, /not|rather than silently truncated/);
      assert.equal(res.output.includes(sample.slice(0, 24)), false, "refusal must not echo the secret back");
    }

    // Ordinary prose, URLs, paths, hashes, and code snippets are allowed cleanly.
    const benignSamples = [
      "Summarise what I copied: Distributed systems trade availability and consistency under partitions.",
      "https://github.com/Quasynvo/Quasnooze/issues/127",
      "/Users/alice/projects/quasnooze/src/tools.js",
      "72e74bb345090da06b5720d6774d405cb7657572",
      "laptop-03-clipboard-preview",
      "MAX_RETRY_COUNT_2026_DEFAULT",
      "function verifyPassword(user, password) {\n  return hash(password) === user.digest;\n}",
    ];
    for (const okSample of benignSamples) {
      assert.equal(inspectClipboardSecret(okSample).secret, false, `falsely flagged benign text: ${okSample}`);
      setClipboardAdapterForTests({ read: async () => okSample });
      const res = await TOOL_MAP.get("read_clipboard").run({});
      assert.equal(res.ok, true, `benign sample should succeed: ${okSample}`);
    }
  } finally {
    clearClipboardStateForTests();
  }
});

test("write_clipboard validates input bounds and writes exact text", async () => {
  let current = "original clipboard value";
  setClipboardAdapterForTests({
    read: async () => current,
    write: async (next) => { current = next; },
  });
  try {
    const empty = await TOOL_MAP.get("write_clipboard").run({ text: "" });
    assert.equal(empty.ok, false);
    assert.equal(current, "original clipboard value", "empty write must not clear the clipboard");

    const huge = await TOOL_MAP.get("write_clipboard").run({ text: "x".repeat(CLIPBOARD_WRITE_MAX_BYTES + 1) });
    assert.equal(huge.ok, false);
    assert.match(huge.output, /exceeds/);
    assert.equal(current, "original clipboard value", "oversized write must leave clipboard unchanged");

    const exact = "npm test -- test/tools.test.js";
    const ok = await TOOL_MAP.get("write_clipboard").run({ text: exact });
    assert.equal(ok.ok, true);
    assert.equal(current, exact);
    assert.match(ok.output, /Wrote 30 bytes/);
  } finally {
    clearClipboardStateForTests();
  }
});

/* ── file actions: move, rename, trash, undo journal (#129 / laptop-05) ──
 *
 * The contract under test is the issue's acceptance list, one test per line:
 * nothing can delete, cross-root moves are refused, undo of a partial batch
 * reports exactly what it restored, and every mutation is journaled and
 * previewed before it runs (the preview half lives in action-preview.test.js
 * and hardening.test.js).
 */

const { TRASH_DIR_NAME, FILE_BATCH_MAX } = await import("../src/tools.js");
const { loadFileJournal } = await import("../src/store.js");

function lastBatchId(output) {
  const match = /batch (b_[a-z0-9_]+)/.exec(String(output));
  assert.ok(match, `no batch id in output: ${output}`);
  return match[1];
}

test("file-action tools are dangerous (approval + unattended refusal) and list_recent_changes is not", () => {
  for (const name of ["move_path", "rename_path", "trash_path", "undo_last"]) {
    assert.equal(DANGEROUS.has(name), true, `${name} must ask for approval`);
  }
  assert.equal(DANGEROUS.has("list_recent_changes"), false, "reading the journal is read-only");
  assert.ok(toolSchemas().some((s) => s.function.name === "move_path"));
  assert.ok(toolSchemas().some((s) => s.function.name === "undo_last"));
});

test("a plan of moves is one approved batch: applied in order, journaled with one batch id and the turn id", async () => {
  mkdirSync(join(sandbox, "dl"), { recursive: true });
  writeFileSync(join(sandbox, "dl", "one.txt"), "1");
  writeFileSync(join(sandbox, "dl", "two.txt"), "2");

  const res = await TOOL_MAP.get("move_path").run(
    {
      operations: [
        { from: "dl/one.txt", to: "arch/one.txt" },
        { from: "dl/two.txt", to: "arch/two.txt" },
      ],
    },
    { turnId: "turn_fixture_1" },
  );
  assert.equal(res.ok, true, res.output);
  assert.match(res.output, /Applied 2 of 2 operations/);

  const batchId = lastBatchId(res.output);
  const entries = loadFileJournal().filter((entry) => entry.batchId === batchId);
  assert.equal(entries.length, 2, "every mutation gets its own journal entry");
  for (const entry of entries) {
    assert.equal(entry.kind, "apply");
    assert.equal(entry.status, "applied");
    assert.equal(entry.action, "move");
    assert.equal(entry.turnId, "turn_fixture_1");
    assert.ok(entry.source.length && entry.destination.length && entry.at);
  }
  assert.equal(readFileSync(join(sandbox, "arch", "one.txt"), "utf8"), "1");
  assert.equal(readFileSync(join(sandbox, "arch", "two.txt"), "utf8"), "2");
  assert.equal(existsSync(join(sandbox, "dl", "one.txt")), false);

  const list = await TOOL_MAP.get("list_recent_changes").run({ limit: 5 });
  assert.equal(list.ok, true);
  assert.match(list.output, new RegExp(batchId));
  assert.match(list.output, /arch\/one\.txt/);
  assert.match(list.output, /applied/);

  // Leave the journal clean for the tests below: undo this batch now.
  const undo = await TOOL_MAP.get("undo_last").run({});
  assert.equal(undo.ok, true, undo.output);
  assert.match(undo.output, /restored 2 of 2/);
  assert.equal(readFileSync(join(sandbox, "dl", "one.txt"), "utf8"), "1");
  assert.equal(readFileSync(join(sandbox, "dl", "two.txt"), "utf8"), "2");
});

test("trash_path never deletes: the bytes stay on disk and undo restores the original path", async () => {
  const file = join(sandbox, "keepme.txt");
  writeFileSync(file, "precious bytes");

  const trash = await TOOL_MAP.get("trash_path").run({ operations: [{ path: file }] });
  assert.equal(trash.ok, true, trash.output);
  assert.equal(existsSync(file), false, "the original path is vacated");

  const entry = loadFileJournal().filter((e) => e.kind === "apply" && e.action === "trash").at(-1);
  assert.equal(entry.status, "applied");
  assert.ok(entry.destination.includes(TRASH_DIR_NAME), `trash landed outside the trash dir: ${entry.destination}`);
  assert.equal(readFileSync(entry.destination, "utf8"), "precious bytes", "the bytes must still be on disk");

  const undo = await TOOL_MAP.get("undo_last").run({});
  assert.equal(undo.ok, true, undo.output);
  assert.match(undo.output, /restored 1 of 1 applied operation/);
  assert.match(undo.output, /keepme\.txt/);
  assert.equal(readFileSync(file, "utf8"), "precious bytes", "undo must restore the original path");

  const journal = loadFileJournal();
  assert.equal(journal.find((e) => e.id === entry.id).status, "undone");
  assert.ok(
    journal.some((e) => e.kind === "undo" && e.action === "trash" && e.destination === file),
    "the reversal is journaled too",
  );

  const again = await TOOL_MAP.get("undo_last").run({});
  assert.equal(again.ok, true);
  assert.match(again.output, /Nothing to undo/);
});

test("nothing in the file actions can unlink: src/tools.js carries no delete primitive", () => {
  const src = readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  // The invariant, checked at the source level: every mutation in this item
  // is a rename. A future `unlink(` or `rmSync(` in here is the bug the
  // journal exists to prevent.
  assert.doesNotMatch(src, /unlink\s*\(|unlinkSync|rmSync|rmdirSync/);
});

test("overwrite without the explicit flag is refused — nothing was changed", async () => {
  writeFileSync(join(sandbox, "src-file.txt"), "new-content");
  writeFileSync(join(sandbox, "dst-file.txt"), "old-content");

  const refused = await TOOL_MAP.get("move_path").run({
    operations: [{ from: "src-file.txt", to: "dst-file.txt" }],
  });
  assert.equal(refused.ok, false);
  assert.match(refused.output, /already exists/);
  assert.match(refused.output, /overwrite: true/);
  assert.match(refused.output, /Nothing was changed/);
  assert.equal(readFileSync(join(sandbox, "dst-file.txt"), "utf8"), "old-content");
  assert.equal(readFileSync(join(sandbox, "src-file.txt"), "utf8"), "new-content");
});

test("overwrite with the flag trashes the existing destination first, and one undo reverses both", async () => {
  const overwritten = await TOOL_MAP.get("move_path").run({
    operations: [{ from: "src-file.txt", to: "dst-file.txt", overwrite: true }],
  });
  assert.equal(overwritten.ok, true, overwritten.output);
  assert.equal(readFileSync(join(sandbox, "dst-file.txt"), "utf8"), "new-content");

  const batchId = lastBatchId(overwritten.output);
  const entries = loadFileJournal().filter((e) => e.batchId === batchId);
  assert.equal(entries.length, 2, "trash-the-old and move-the-new are both journaled in the batch");
  const trashed = entries.find((e) => e.action === "trash");
  assert.equal(trashed.status, "applied");
  assert.equal(readFileSync(trashed.destination, "utf8"), "old-content", "the replaced file was recovered, not deleted");

  const undo = await TOOL_MAP.get("undo_last").run({});
  assert.equal(undo.ok, true, undo.output);
  assert.match(undo.output, /restored 2 of 2/);
  assert.equal(readFileSync(join(sandbox, "src-file.txt"), "utf8"), "new-content");
  assert.equal(readFileSync(join(sandbox, "dst-file.txt"), "utf8"), "old-content");
});

test("undo of a partially-applied batch reports exactly what was restored", async () => {
  mkdirSync(join(sandbox, "partial"), { recursive: true });
  writeFileSync(join(sandbox, "blocker"), "a file, not a directory");
  writeFileSync(join(sandbox, "partial", "good.txt"), "good");
  writeFileSync(join(sandbox, "partial", "later.txt"), "later");

  // Op 1 applies; op 2 fails at apply time (its destination parent is a
  // regular file), which validation cannot see without running.
  const res = await TOOL_MAP.get("move_path").run({
    operations: [
      { from: "partial/good.txt", to: "moved/good.txt" },
      { from: "partial/later.txt", to: "blocker/later.txt" },
    ],
  });
  assert.equal(res.ok, true, "a partial batch applied something, so it reports honestly as partial");
  assert.match(res.output, /Applied 1 of 2 operations, then stopped/);
  assert.match(res.output, /failed/);
  const batchId = lastBatchId(res.output);
  assert.equal(readFileSync(join(sandbox, "moved", "good.txt"), "utf8"), "good");
  assert.equal(existsSync(join(sandbox, "partial", "later.txt")), true, "the failed op's source is untouched");

  const undo = await TOOL_MAP.get("undo_last").run({});
  assert.equal(undo.ok, true, undo.output);
  assert.match(undo.output, new RegExp(`Undid batch ${batchId}`));
  assert.match(undo.output, /restored 1 of 1 applied operation/);
  assert.match(undo.output, /Restored:/);
  assert.match(undo.output, /partial\/good\.txt \(from moved\/good\.txt\)/);
  assert.match(undo.output, /Never applied in this batch \(1\)/);
  assert.match(undo.output, /partial\/later\.txt/);

  assert.equal(readFileSync(join(sandbox, "partial", "good.txt"), "utf8"), "good", "the applied op is back");
  assert.equal(existsSync(join(sandbox, "moved", "good.txt")), false);
  assert.equal(existsSync(join(sandbox, "partial", "later.txt")), true);
});

test("rename_path renames in place and refuses names that are paths", async () => {
  writeFileSync(join(sandbox, "before.txt"), "payload");
  const ok = await TOOL_MAP.get("rename_path").run({ operations: [{ path: "before.txt", new_name: "after.txt" }] });
  assert.equal(ok.ok, true, ok.output);
  assert.equal(readFileSync(join(sandbox, "after.txt"), "utf8"), "payload");

  const asPath = await TOOL_MAP.get("rename_path").run({ operations: [{ path: "after.txt", new_name: "sub/after.txt" }] });
  assert.equal(asPath.ok, false);
  assert.match(asPath.output, /plain name, not a path/);
  assert.match(asPath.output, /Nothing was changed/);
  assert.equal(existsSync(join(sandbox, "after.txt")), true);

  const dot = await TOOL_MAP.get("rename_path").run({ operations: [{ path: "after.txt", new_name: ".." }] });
  assert.equal(dot.ok, false);
  assert.match(dot.output, /Nothing was changed/);

  // Clean the journal for the tests that follow.
  const undo = await TOOL_MAP.get("undo_last").run({});
  assert.equal(undo.ok, true, undo.output);
  assert.equal(readFileSync(join(sandbox, "before.txt"), "utf8"), "payload");
});

test("a whole-plan validation failure runs nothing, not even the first operation", async () => {
  writeFileSync(join(sandbox, "v1.txt"), "1");
  writeFileSync(join(sandbox, "v2.txt"), "2");
  const res = await TOOL_MAP.get("move_path").run({
    operations: [
      { from: "v1.txt", to: "v1-moved.txt" },
      { from: "does-not-exist.txt", to: "nowhere.txt" },
    ],
  });
  assert.equal(res.ok, false);
  assert.match(res.output, /Plan refused/);
  assert.match(res.output, /Nothing was changed/);
  assert.equal(existsSync(join(sandbox, "v1.txt")), true, "op 1 must not run when op 2 fails validation");
  assert.equal(existsSync(join(sandbox, "v1-moved.txt")), false);
});

test("an empty or oversized plan is refused with a sentence the model can act on", async () => {
  const empty = await TOOL_MAP.get("move_path").run({ operations: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.output, /non-empty array/);
  const huge = await TOOL_MAP.get("trash_path").run({
    operations: Array.from({ length: FILE_BATCH_MAX + 1 }, (_, i) => ({ path: `f${i}.txt` })),
  });
  assert.equal(huge.ok, false);
  assert.match(huge.output, new RegExp(`${FILE_BATCH_MAX} operations`));
  assert.match(huge.output, /Nothing was changed/);
});

test("cross-root moves are refused, not silently copied", async () => {
  const { spawn } = await import("node:child_process");
  const base = mkdtempSync(join(tmpdir(), "pinch-roots-"));
  try {
    const rootA = join(base, "rootA");
    const rootB = join(base, "rootB");
    mkdirSync(rootA, { recursive: true });
    mkdirSync(rootB, { recursive: true });
    writeFileSync(join(rootA, "shared.txt"), "only copy");

    // config.js reads PINCH_WORKSPACE once at import, so two roots need a
    // child process — the same reason the symlink tests spawn one.
    const script = `
      import { readFileSync, existsSync } from "node:fs";
      import { join } from "node:path";
      const [a, b] = process.env.PINCH_WORKSPACE.split(",");
      const { TOOL_MAP } = await import(${JSON.stringify(new URL("../src/tools.js", import.meta.url).href)});
      const refused = await TOOL_MAP.get("move_path").run({ operations: [{ from: join(a, "shared.txt"), to: join(b, "shared.txt") }] });
      const sourceAfterRefusal = existsSync(join(a, "shared.txt")) ? readFileSync(join(a, "shared.txt"), "utf8") : null;
      const copyInBAfterRefusal = existsSync(join(b, "shared.txt"));
      const allowed = await TOOL_MAP.get("move_path").run({ operations: [{ from: join(a, "shared.txt"), to: join(a, "moved.txt") }] });
      console.log(JSON.stringify({
        refusedOk: refused.ok,
        refusedOutput: refused.output,
        sourceStillThere: sourceAfterRefusal,
        noCopyInB: !copyInBAfterRefusal,
        sameRootOk: allowed.ok,
      }));
    `;
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PINCH_WORKSPACE: `${rootA},${rootB}`, PINCH_DATA: join(base, "data"), LLM_PROVIDER: "mock" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`))));
    });
    const result = JSON.parse(stdout);
    assert.equal(result.refusedOk, false, "cross-root move must be refused");
    assert.match(result.refusedOutput, /cross-root move refused/);
    assert.match(result.refusedOutput, /not copied/);
    assert.match(result.refusedOutput, /Nothing was changed/);
    assert.equal(result.sourceStillThere, "only copy", "the source must be untouched");
    assert.equal(result.noCopyInB, true, "a refused cross-root move must not leave a copy behind");
    assert.equal(result.sameRootOk, true, "the same-root control move must still work");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
