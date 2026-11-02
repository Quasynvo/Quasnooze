import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function deck(fetcher) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent:'', disabled:false, hidden:false, dataset:{}, focus(){this.focused=true;}, replaceChildren(){}, append(){}, showModal(){this.open=true;}, close(){this.open=false;} });
    return elements.get(id);
  };
  const context = createContext({ document:{ getElementById:element, querySelectorAll:()=>[], createElement:()=>element(Symbol()) },
    location:{ search:'', origin:'http://127.0.0.1:7777', pathname:'/' }, history:{replaceState(){}},
    sessionStorage:{getItem:()=>null,setItem(){}},localStorage:{getItem:()=>null},
    fetch:fetcher,AbortSignal,URL,URLSearchParams,setInterval(){},setTimeout(){},clearTimeout(){} });
  const source = readFileSync(new URL('../public/desktop.js',import.meta.url),'utf8');
  const bootstrap='clock();setInterval(clock,30000);refresh();setInterval(refresh,1500);';
  assert.ok(source.includes(bootstrap));
  runInContext(source.replace(bootstrap,''),context);
  return {element, refresh:()=>runInContext('refresh()',context)};
}
const state = {available:true,mic:true,phase:'armed',busy:false,lastMs:null,recent:[],speech:{status:'rejected',detail:'No command was run',text:'<img src=x onerror=alert(1)>',confidence:0.2}};
const response = data => new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});

test('connection loss clears stale native CONNECTED status, disables controls, and recovers',async()=>{
  let online=true;
  const ui=deck(async path=>{if(!online) throw new TypeError('Failed to fetch');return response(path==='/api/desktop'?state:{model:'qwen3:4b',provider:'ollama'});});
  await ui.refresh();
  assert.equal(ui.element('nativeStatus').textContent,'CONNECTED');
  assert.match(ui.element('speechDetail').textContent,/REJECTED/);
  assert.match(ui.element('heardText').textContent,/<img/);
  online=false;await ui.refresh();
  assert.equal(ui.element('nativeStatus').textContent,'UNKNOWN');
  assert.equal(ui.element('micState').textContent,'UNKNOWN');
  assert.equal(ui.element('audioMeter').value,0);
  assert.match(ui.element('audioLabel').textContent,/UNKNOWN/);
  assert.match(ui.element('notice').textContent,/Cannot reach the Pinch service/);
  for(const id of ['listenButton','muteButton','stopButton','runButton','allow','deny']) assert.equal(ui.element(id).disabled,true);
  online=true;await ui.refresh();
  assert.equal(ui.element('nativeStatus').textContent,'CONNECTED');
  assert.equal(ui.element('listenButton').disabled,false);
});

test('a failed model-health request does not falsely disconnect a working native control API',async()=>{
  const ui=deck(async path=>{if(path==='/api/health')throw new TypeError('Failed to fetch');return response(state);});
  await ui.refresh();
  assert.equal(ui.element('connection').textContent,'LOCAL SERVICE CONNECTED');
  assert.equal(ui.element('nativeStatus').textContent,'CONNECTED');
  assert.equal(ui.element('listenButton').disabled,false);
  assert.match(ui.element('modelStatus').textContent,/Model status unavailable/);
});


test('audio display distinguishes live level, stale samples and released microphone',async()=>{
  const live={...state,audioAgeMs:20,audioLevel:35};
  const ui=deck(async path=>response(path==='/api/desktop'?live:{model:'test',provider:'mock'}));
  await ui.refresh();assert.equal(ui.element('audioMeter').value,35);
  live.audioAgeMs=5000;await ui.refresh();assert.equal(ui.element('audioMeter').value,0);
  assert.match(ui.element('audioLabel').textContent,/Waiting/);
  live.mic=false;await ui.refresh();assert.match(ui.element('audioLabel').textContent,/not capturing/);
});


test('reviewing rejected speech only opens an editable draft and never dispatches it',async()=>{
  const calls=[];
  const ui=deck(async (path,options)=>{calls.push([path,options.method]);return response(path==='/api/desktop'?state:{model:'test',provider:'mock'});});
  await ui.refresh(); const count=calls.length;
  assert.equal(ui.element('reviewHeard').hidden,false);
  ui.element('reviewHeard').onclick();
  assert.equal(ui.element('command').value,state.speech.text);
  assert.equal(ui.element('command').focused,true);
  assert.equal(calls.length,count);
  assert.equal(calls.some(([,method])=>method==='POST'),false);
});


test('safe in-progress model text is displayed before request completion',async()=>{
  const live={...state,busy:true,phase:'working',draft:'Hello!',text:'Working…'};
  const ui=deck(async path=>response(path==='/api/desktop'?live:{model:'test',provider:'mock'}));
  await ui.refresh();assert.equal(ui.element('result').textContent,'Hello!');
  assert.match(ui.element('resultKind').textContent,/RESPONDING/);
});
