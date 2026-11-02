/**
 * tests for the pure, security-sensitive bits: the maths evaluator, the
 * command screen and the workspace sandbox. These are the pieces where a bug
 * is not cosmetic.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
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
