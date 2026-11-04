import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// Minimal deterministic DOM/event double, not a browser or screen reader.
function deck(fetcher) {
  const elements = new Map(), body = { id: 'body' };
  const document = { activeElement: body, body, getElementById: element, querySelectorAll: () => [], createElement: () => element(Symbol()) };
  function element(id) {
    if (!elements.has(id)) {
      let disabled = false, text = '';
      const node = { id, hidden: false, dataset: {}, textWrites: 0,
        focus() { if (!disabled) { this.focused = true; document.activeElement = this; } },
        contains(other) { return other === this || (id === 'permission' && ['allow', 'deny'].includes(other?.id)); },
        replaceChildren() {}, append() {}, showModal() { this.open = true; }, close() { this.open = false; },
      };
      Object.defineProperty(node, 'disabled', { get: () => disabled, set(value) { disabled = value; if (value && document.activeElement === node) document.activeElement = body; } });
      Object.defineProperty(node, 'textContent', { get: () => text, set(value) { text = value; node.textWrites++; } });
      elements.set(id, node);
    }
    return elements.get(id);
  }
  const context = createContext({ document,
    location: { search: '', origin: 'http://127.0.0.1:7777', pathname: '/' }, history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null },
    fetch: fetcher, AbortSignal, URL, URLSearchParams, setInterval() {}, setTimeout() {}, clearTimeout() {},
  });
  const source = readFileSync(new URL('../public/desktop.js', import.meta.url), 'utf8');
  const bootstrap = 'clock();setInterval(clock,30000);refresh();setInterval(refresh,1500);';
  assert.ok(source.includes(bootstrap));
  runInContext(source.replace(bootstrap, ''), context);
  return { element, refresh: () => runInContext('refresh()', context), active: () => document.activeElement };
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
  assert.match(ui.element('notice').textContent,/Cannot reach the Quasnooze service/);
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


const tick = () => new Promise(resolve => setImmediate(resolve));
test('dialog names, focus targets and permission/microphone status hooks exist on actual controls', () => {
  const html = readFileSync(new URL('../public/desktop.html', import.meta.url), 'utf8');
  for (const name of ['native', 'model', 'key']) {
    assert.ok(html.includes(`<dialog id="${name}Dialog" aria-labelledby="${name}Title" aria-describedby="${name}Intro">`));
    assert.ok(html.includes(`<h2 id="${name}Title">`));
    assert.ok(html.includes(`<p id="${name}Intro">`));
  }
  assert.match(html, /id="keyInput" autofocus/);
  assert.match(html, /id="modelSelect" autofocus/);
  assert.match(html, /id="permission" role="region" aria-labelledby="permissionTitle"/);
  assert.match(html, /id="permissionStatus" role="status"/);
  assert.match(html, /id="micStatus" role="status" aria-live="polite" aria-atomic="true"/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  assert.match(html, /\.composer input:focus-visible\{outline:2px solid/);
});

test('scoped Escape denies the current approval and returns focus without mic controls', async () => {
  let live = { ...state, busy: true, approval: { id: 'keyboard-deny', description: '<img src=x onerror=alert(1)>' } };
  const posts = [];
  const ui = deck(async (path, options) => {
    if (options.method === 'POST') { posts.push(JSON.parse(options.body)); live = { ...live, approval: null, busy: false }; }
    return response(path === '/api/desktop' ? live : { model: 'fixture', provider: 'mock' });
  });
  await ui.refresh(); ui.element('deny').focus();
  assert.equal(ui.element('approvalText').textContent, live.approval.description);
  let prevented = false;
  ui.element('permission').onkeydown({ key: 'Escape', preventDefault() { prevented = true; } });
  await tick();
  assert.equal(prevented, true);
  assert.deepEqual(posts, [{ approval: { id: 'keyboard-deny', allowed: false } }]);
  assert.equal(ui.element('permission').hidden, true);
  assert.equal(ui.active().id, 'command');
  assert.equal(ui.element('permissionStatus').textContent, 'No tool approval pending.');
});

test('Escape does not deny from a modal, other keys or disconnected disabled controls', async () => {
  let online = true;
  const live = { ...state, approval: { id: 'scoped-only', description: 'Synthetic request' } }, posts = [];
  const ui = deck(async (path, options) => {
    if (!online) throw new Error('offline');
    if (options.method === 'POST') posts.push(JSON.parse(options.body));
    return response(path === '/api/desktop' ? live : {});
  });
  await ui.refresh();
  const event = key => ({ key, preventDefault() { throw new Error('must not consume this event'); } });
  ui.element('modelDialog').open = true;
  ui.element('permission').onkeydown(event('Escape'));
  ui.element('modelDialog').open = false;
  for (const key of ['Enter', ' ', 'p', 'P']) ui.element('permission').onkeydown(event(key));
  online = false; await ui.refresh();
  ui.element('permission').onkeydown(event('Escape'));
  await ui.element('allow').onclick();
  assert.deepEqual(posts, []);
  assert.match(ui.element('permissionStatus').textContent, /unknown.*disabled/);
});

test('background polling does not steal input focus or rewrite unchanged live-region text', async () => {
  const live = { ...state, mic: false, approval: { id: 'background', description: 'Review this action' } };
  const ui = deck(async path => response(path === '/api/desktop' ? live : {}));
  ui.element('command').focus();
  await ui.refresh();
  const announcements = ui.element('permissionStatus').textWrites, micWrites = ui.element('micState').textWrites;
  await ui.refresh();
  assert.equal(ui.active().id, 'command');
  assert.equal(ui.element('permissionStatus').textWrites, announcements);
  assert.equal(ui.element('micState').textWrites, micWrites);
});

test('duplicate activation is suppressed and a pending request never replays against a replacement ID', async () => {
  let release;
  const live = { ...state, approval: { id: 'first', description: 'First action' } }, posts = [];
  const ui = deck(async (path, options) => {
    if (options.method === 'POST') {
      posts.push(JSON.parse(options.body));
      await new Promise(resolve => { release = resolve; });
    }
    return response(path === '/api/desktop' ? live : {});
  });
  await ui.refresh(); ui.element('allow').focus();
  const first = ui.element('allow').onclick();
  assert.equal(ui.element('allow').disabled, true); assert.equal(ui.element('deny').disabled, true);
  await ui.element('allow').onclick();
  live.approval = { id: 'second', description: 'Different action' }; await ui.refresh();
  assert.equal(ui.element('allow').disabled, true);
  release(); await first;
  assert.deepEqual(posts, [{ approval: { id: 'first', allowed: true } }]);
  assert.equal(ui.element('permission').hidden, false);
  assert.equal(ui.element('approvalText').textContent, 'Different action');
});

test('unavailable mic state is UNKNOWN in every visible status, never a claim of release', async () => {
  const live = { ...state, available: false, mic: false, micUnknown: true, phase: 'unavailable' };
  const ui = deck(async path => response(path === '/api/desktop' ? live : {}));
  await ui.refresh();
  assert.equal(ui.element('micState').textContent, 'UNKNOWN');
  assert.match(ui.element('audioLabel').textContent, /UNKNOWN/);
  assert.match(ui.element('footerState').textContent, /UNKNOWN/);
  assert.equal(ui.element('listenButton').disabled, true);
});
