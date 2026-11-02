import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {execFileSync} from 'node:child_process';
const dir=mkdtempSync(join(tmpdir(),'pinch-personas-'));
process.env.PINCH_DATA=dir;process.env.PINCH_WORKSPACE=dir;process.env.LLM_PROVIDER='mock';
const {ensureData,loadPersonas,savePersona,selectPersona,activePersona,removePersona,invalidate}=await import('../src/store.js');
const {buildExport}=await import('../src/export.js');
const {personaCommand}=await import('../src/personas.js');
ensureData();const path=join(dir,'personas.json');
after(()=>rmSync(dir,{recursive:true,force:true}));
test('persona writes persist across processes, survive cache mutation, and are exported',()=>{
 savePersona('concise-coder','Be concise and give a small code example.');selectPersona('chat-a','concise-coder');
 const copy=loadPersonas();copy.personas[0].instructions='mutated';
 assert.match(activePersona('chat-a').instructions,/Be concise/);
 const persisted=JSON.parse(readFileSync(path,'utf8'));
 assert.equal(persisted.personas[0].name,'concise-coder');
 const child=execFileSync(process.execPath,['--input-type=module','-e',"import {activePersona} from './src/store.js';console.log(activePersona('chat-a').name)"],{cwd:new URL('..',import.meta.url),env:{...process.env},encoding:'utf8'});
 assert.equal(child.trim(),'concise-coder');
 assert.equal(readdirSync(dir).some(name=>name.endsWith('.tmp')),false);
 const exported=buildExport();assert.equal(exported.counts.personas,1);assert.deepEqual(exported.personas,persisted);
});
test('selection is per session and deletion resets affected sessions only',()=>{
 savePersona('planner','Use a numbered daily plan.');selectPersona('chat-b','planner');
 assert.equal(activePersona('chat-a').name,'concise-coder');assert.equal(activePersona('chat-b').name,'planner');
 savePersona('planner','Use an updated numbered daily plan.');assert.match(activePersona('chat-b').instructions,/updated/);
 selectPersona('alias/chat','planner');assert.equal(activePersona('alias_chat').name,'planner');
 selectPersona('alias_chat','default');
 selectPersona('chat-a','default');assert.equal(activePersona('chat-a'),null);
 removePersona('planner');assert.equal(activePersona('chat-b'),null);assert.equal(loadPersonas().selections.length,0);
});
test('invalid names/instructions cannot become paths, permissions or oversized overlays',()=>{
 const before=readFileSync(path,'utf8');
 for(const name of ['../escape','default','__proto__','Uppercase','a'.repeat(41),'x/y']) assert.throws(()=>savePersona(name,'text'));
 for(const value of ['',null,{},'x'.repeat(2001)])assert.throws(()=>savePersona('bad',value));
 assert.throws(()=>selectPersona('chat-a','missing'));
 assert.equal(readFileSync(path,'utf8'),before);
});
test('failed atomic rename preserves previous file and in-process state',()=>{
 const before=readFileSync(path,'utf8'), original=fs.renameSync;
 try {
  fs.renameSync=(from,to)=>{if(to===path)throw new Error('simulated rename failure');return original(from,to);};syncBuiltinESMExports();
  assert.throws(()=>savePersona('failed-write','Not committed'),/simulated/);
  assert.equal(readFileSync(path,'utf8'),before);assert.equal(loadPersonas().personas.some(p=>p.name==='failed-write'),false);
 } finally {fs.renameSync=original;syncBuiltinESMExports();for(const f of readdirSync(dir).filter(x=>x.endsWith('.tmp')))rmSync(join(dir,f));}
});
test('corrupt/unsupported files fall back for prompts but cannot be silently overwritten',()=>{
 const before=readFileSync(path,'utf8');
 for(const value of ['{broken',JSON.stringify({version:99,personas:[],selections:[]}),JSON.stringify({version:1,personas:[],selections:[],autoApprove:true})]){
  writeFileSync(path,value);invalidate();assert.ok(loadPersonas().warning);assert.equal(activePersona('chat-a'),null);
  assert.throws(()=>savePersona('test','hi'),/not overwritten/);assert.equal(readFileSync(path,'utf8'),value);
 }
 writeFileSync(path,before);invalidate();
});
test('commands do not dispatch model text and reject malformed input without mutation',()=>{
 assert.equal(personaCommand('ordinary text','chat-a'),null);
 assert.match(personaCommand('/persona use missing','chat-a'),/unchanged/);
 assert.match(personaCommand('/persona use default extra','chat-a'),/unchanged/);
 assert.match(personaCommand('/persona list','chat-a'),/concise-coder/);
});


test('other-process edits are visible and registry limits fail before replacing the file',()=>{
 const before=readFileSync(path,'utf8');
 try {
  const state={version:1,personas:Array.from({length:50},(_,i)=>({name:'p'+i,instructions:'Style '+i})),selections:Array.from({length:1000},(_,i)=>({sessionId:'session-'+i,name:'p0'}))};
  writeFileSync(path,JSON.stringify(state)); // no invalidate: external writer must be visible
  assert.equal(loadPersonas().personas.length,50);
  const full=readFileSync(path,'utf8');
  assert.throws(()=>savePersona('overflow','Too many'));assert.equal(readFileSync(path,'utf8'),full);
  assert.throws(()=>selectPersona('one-more-session','p0'));assert.equal(readFileSync(path,'utf8'),full);
  selectPersona('session-0','p1');assert.equal(activePersona('session-0').name,'p1');
 } finally {writeFileSync(path,before);invalidate();}
});
