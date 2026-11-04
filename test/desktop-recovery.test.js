import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const data = mkdtempSync(join(tmpdir(), 'quas-recovery-'));
process.env.PINCH_DATA = data;
process.env.LLM_PROVIDER = 'mock';
after(() => rmSync(data, { recursive: true, force: true }));
const { DesktopRuntime } = await import('../src/desktop.js');
const { startWindowsCompanion } = await import('../src/windows-companion.js');
const { createApproval } = await import('../src/agent.js');
const { deriveReadiness } = await import('../src/readiness.js');

function fixture({ hangKill = false, spawnThrows = false } = {}) {
  let id = 0;
  const jobs = new Map(), children = [];
  const clock = { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(id) { jobs.delete(id); } };
  function tick() { const [id, fn] = jobs.entries().next().value || []; assert.ok(fn, 'expected scheduled work'); jobs.delete(id); fn(); }
  const runtime = new DesktopRuntime();
  let quits = 0, spawns = 0;
  const host = startWindowsCompanion({ platform: 'win32', runtime, clock, log: { warn() {} }, onQuit: () => quits++, spawnChild() {
    spawns++;
    if (spawnThrows) throw new Error('private spawn diagnostic');
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.messages = []; child.stdin.writable = true;
    child.stdin.write = line => { child.messages.push(JSON.parse(line)); return true; };
    child.stdin.end = child.stdin.write;
    child.kill = () => { child.killed = true; if (!hangKill) child.emit('exit', 1); };
    child.event = event => child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
    children.push(child); return child;
  } });
  return { runtime, host, children, jobs, tick, quits: () => quits, spawns: () => spawns };
}

test('missing-ready and spawn failures allow only three restarts, then explicit retry', () => {
  for (const spawnThrows of [false, true]) {
    const f = fixture({ spawnThrows });
    assert.equal(f.runtime.state.available, false);
    while (f.runtime.state.phase !== 'unavailable') f.tick();
    assert.equal(f.spawns(), 4); // first launch plus three recovery attempts
    assert.equal(f.runtime.state.recoveryAttempts, 3);
    assert.equal(f.runtime.state.retryAvailable, true);
    assert.equal(f.jobs.size, 0);
    assert.equal(f.host.retry(), true);
    assert.equal(f.spawns(), 5);
    f.host.stop();
    while (f.jobs.size) f.tick();
    assert.equal(f.spawns(), 5);
    assert.equal(f.host.retry(), false);
  }
});

test('crashes, pipe failures, stale ready/commands/approvals and results never replay', async () => {
  const f = fixture(); const first = f.children[0];
  first.event({ type: 'command', text: 'open calculator' });
  assert.equal(f.runtime.busy, false); // pre-ready events ignored
  first.event({ type: 'ready' });
  first.event({ type: 'voice', mic: true });
  const pending = f.runtime.request('open calculator');
  const action = first.messages.find(m => m.op === 'action');
  assert.ok(action);
  first.stdin.emit('error', new Error('secret diagnostic'));
  assert.equal(f.runtime.state.available, false);
  assert.match((await pending).text, /outcome unknown/);
  f.tick(); const second = f.children[1];
  second.event({ type: 'ready' });
  assert.equal(f.runtime.state.mic, false);
  assert.equal(f.runtime.state.phase, 'muted');
  assert.equal(second.messages.filter(m => m.op === 'action').length, 0);
  first.event({ type: 'ready' }); first.event({ type: 'voice', mic: true });
  first.event({ type: 'command', text: 'open notepad' });
  first.event({ type: 'result', id: action.id, ok: true, text: 'stale' });
  assert.equal(f.runtime.state.mic, false);
  assert.equal(f.runtime.state.phase, 'muted');
  second.event({ type: 'ready' });
  assert.equal(second.messages.filter(m => m.op === 'init').length, 1);
  second.emit('exit', 1); second.emit('close', 1);
  assert.equal(f.jobs.size, 1);
  f.host.stop(); while (f.jobs.size) f.tick();
  assert.equal(f.spawns(), 2);
});

test('quit cancels retry and non-exiting processes block overlapping launches', () => {
  const f = fixture({ hangKill: true });
  f.tick(); // startup timeout
  f.tick(); // kill watchdog
  assert.equal(f.runtime.state.phase, 'unavailable');
  assert.equal(f.host.retry(), false);
  assert.equal(f.spawns(), 1);
  f.host.stop(); while (f.jobs.size) f.tick();
  const q = fixture(); q.children[0].event({ type: 'quit' });
  assert.equal(q.quits(), 1);
  while (q.jobs.size) q.tick();
  assert.equal(q.spawns(), 1);
});

test('late model callbacks cannot approve work or overwrite a new muted connection', async () => {
  let callback, finish;
  const runtime = new DesktopRuntime({ agent: ({ onEvent }) => { callback = onEvent; return new Promise(r => { finish = r; }); } });
  const messages = [], bridge = { send: m => messages.push(m) };
  runtime.attach(bridge);
  const work = runtime.request('do some work');
  const owned = createApproval({ channel: 'desktop', sessionId: 'desktop-resident', description: 'old permission' });
  callback({ type: 'approval', id: owned.id, description: 'old permission' });
  runtime.detach(); runtime.attach(bridge);
  assert.equal(await owned.promise, false);
  assert.equal(runtime.approve(owned.id, true), false);
  const late = createApproval({ channel: 'desktop', sessionId: 'desktop-resident', description: 'late permission' });
  assert.throws(() => callback({ type: 'approval', id: late.id }), /stale work/);
  assert.equal(await late.promise, false);
  assert.throws(() => callback({ type: 'tool', name: 'write_file' }), /stale work/);
  finish({ text: 'old completed action' }); await work;
  assert.equal(runtime.state.phase, 'muted');
  assert.equal(runtime.state.mic, false);
  assert.equal(messages.filter(m => m.op === 'reply').length, 0);
});

test('recovery snapshots use task 012 unavailable readiness rather than ready', () => {
  for (const phase of ['starting', 'recovering', 'unavailable']) {
    const report = deriveReadiness({ routing: { provider: 'mock' }, checks: [] }, { companion: { available: false, mic: false, phase, text: 'secret' } });
    assert.equal(report.surfaces.voice.state, 'companion-unavailable');
    assert.equal(report.surfaces.voice.companion_phase, phase);
    assert.equal(report.surfaces.voice.ready, false);
    assert.ok(!JSON.stringify(report).includes('secret'));
  }
});


test('ready events do not replenish the three-restart budget', () => {
  const f = fixture();
  for (let attempt = 0; attempt < 4; attempt++) {
    const child = f.children[attempt];
    child.event({ type: 'ready' });
    assert.equal(f.runtime.state.mic, false);
    child.emit('exit', 1);
    if (attempt < 3) f.tick();
  }
  assert.equal(f.spawns(), 4);
  assert.equal(f.runtime.state.phase, 'unavailable');
  f.runtime.control('retry');
  assert.equal(f.spawns(), 5);
  f.host.stop(); while (f.jobs.size) f.tick();
});

test('stdout closure, stdout errors and synchronous pipe writes fail closed', () => {
  for (const failure of ['end', 'error', 'write']) {
    const f = fixture(), child = f.children[0];
    if (failure === 'write') {
      child.stdin.write = () => { throw new Error('private pipe failure'); };
      child.event({ type: 'ready' });
    } else child.stdout.emit(failure, new Error('private pipe failure'));
    assert.equal(f.runtime.state.available, false);
    assert.equal(f.runtime.state.phase, 'recovering');
    assert.ok(!JSON.stringify(f.runtime.snapshot()).includes('private pipe failure'));
    f.host.stop(); while (f.jobs.size) f.tick();
  }
});
