import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { buildActionPreview, approvalDescription, PREVIEW_LIMITS, sanitizeActionPreview, redactPreviewText } from '../src/action-preview.js';
const dir = mkdtempSync(join(tmpdir(), 'quas-preview-'));
process.env.PINCH_DATA = join(dir, 'data');
process.env.PINCH_WORKSPACE = dir;
process.env.PINCH_AUTO_APPROVE = 'false';
process.env.PINCH_RISK_TIERS = 'false';
process.env.LLM_PROVIDER = 'mock';
process.env.PINCH_KEY = 'configured-secret-canary';
after(() => rmSync(dir, { recursive: true, force: true }));
const { createApproval, answerApproval, pendingApprovalsFor, runAgent } = await import('../src/agent.js');
const { brain } = await import('../src/brain.js');
const { TOOL_MAP } = await import('../src/tools.js');
const { DesktopRuntime } = await import('../src/desktop.js');

test('bounded display-only contract describes supported effects and honest unknowns', () => {
  const longDescription = approvalDescription('x'.repeat(10000));
  assert.ok(longDescription.length <= 2000);
  assert.match(longDescription, /description truncated/);
  const write = buildActionPreview('write_file', { path: 'notes.txt', content: 'private-canary' });
  assert.equal(write.target, 'notes.txt');
  assert.match(write.effectSummary, /Create or replace.*14 bytes/);
  assert.ok(!JSON.stringify(write).includes('private-canary'));
  assert.ok(write.redactions.includes('content-withheld'));
  const shell = buildActionPreview('shell', { cwd: '/workspace', command: 'raw-command-canary' }, { risk: { tier: 'act', why: 'raw-command-canary is not on the read-only list' } });
  assert.equal(shell.target, '/workspace');
  assert.match(shell.effectSummary, /unknown/);
  assert.ok(!JSON.stringify(shell).includes('raw-command-canary'));
  const unknown = buildActionPreview('custom_clipboard', { clipboard: 'clipboard-canary', command: 'raw-command-canary' });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.target, 'unknown');
  assert.ok(!JSON.stringify(unknown).includes('canary'));
  const url = buildActionPreview('open_url', { url: 'https://user:password-canary@example.com/page?q=query-canary#fragment-canary' });
  assert.equal(url.target, 'https://example.com/page');
  assert.ok(!JSON.stringify(url).includes('canary'));
  assert.equal(buildActionPreview('system_control', { action: 'shutdown' }).effectSummary, 'unknown');
  assert.match(buildActionPreview('screenshot').effectSummary, /personal information/);
  for (const [key, limit] of Object.entries(PREVIEW_LIMITS)) {
    assert.ok(sanitizeActionPreview({ [key]: 'x'.repeat(10000) })[key].length <= limit);
  }
});

test('redacts configured/pattern canaries before truncation and retains redaction reasons', async () => {
  const preview = buildActionPreview('write_file', { path: 'configured-secret-canary/notes', content: 'secret content' }, { secrets: ['configured-secret-canary'] });
  const owned = createApproval({ channel: 'web', sessionId: 'redaction', description: 'token=pattern-canary configured-secret-canary', preview });
  const snapshot = pendingApprovalsFor('redaction')[0];
  assert.ok(!JSON.stringify(snapshot).includes('canary'));
  assert.ok(snapshot.preview.redactions.includes('sensitive-or-control-text'));
  assert.ok(snapshot.preview.redactions.includes('content-withheld'));
  assert.ok(Object.isFrozen(snapshot.preview));
  assert.ok(!redactPreviewText('Bearer bearer-canary sk-longsecretcanary ghp_longsecretcanary password="quoted canary"').includes('canary'));
  assert.equal(answerApproval(owned.id, false), true);
  assert.equal(await owned.promise, false);
  assert.equal(answerApproval(owned.id, true), false);
});

test('allow, deny, scoping, stale IDs and unattended blocks keep existing tool policies', async () => {
  const original = brain.chat, tool = TOOL_MAP.get('write_file'), run = tool.run;
  let calls = 0;
  tool.run = async () => { calls++; return { ok: true, output: 'done' }; };
  try {
    for (const [mode, allowed] of [['allow', true], ['deny', false], ['unattended', false]]) {
      let round = 0, approvalEvent;
      brain.chat = async () => round++ === 0
        ? { content: '', toolCalls: [{ id: 'mock-call', name: 'write_file', arguments: { path: join(dir, 'target.txt'), content: 'content-canary' } }] }
        : { content: 'Finished.', toolCalls: [] };
      const before = calls;
      await runAgent({ sessionId: mode, channel: 'web', text: 'Please write my file', autonomy: mode === 'unattended' ? 'unattended' : 'interactive', onEvent(event) {
        if (event.type !== 'approval') return;
        approvalEvent = event;
        assert.equal(event.preview.tool, 'write_file');
        assert.ok(!JSON.stringify(event.preview).includes('content-canary'));
        const pending = pendingApprovalsFor(mode)[0];
        assert.equal(pending.id, event.id);
        assert.deepEqual(pending.preview, event.preview);
        assert.deepEqual(pendingApprovalsFor('foreign-session'), []);
        assert.equal(answerApproval('stale-id', true), false);
        answerApproval(event.id, allowed);
      } });
      assert.equal(calls - before, allowed ? 1 : 0);
      assert.equal(Boolean(approvalEvent), mode !== 'unattended');
      assert.deepEqual(pendingApprovalsFor(mode), []);
      if (approvalEvent) assert.equal(answerApproval(approvalEvent.id, true), false);
    }
    // New preview metadata must not become a persistent timeline/log artifact.
    for (const name of readdirSync(join(dir, 'data', 'sessions'))) {
      const saved = readFileSync(join(dir, 'data', 'sessions', name), 'utf8');
      assert.ok(!saved.includes('riskRationale'));
      assert.ok(!saved.includes('effectSummary'));
    }
  } finally { brain.chat = original; tool.run = run; }
});

test('native approval snapshots carry metadata but stale native IDs remain denied', async () => {
  let owned;
  const sent = [];
  const runtime = new DesktopRuntime({ agent: async ({ onEvent }) => {
    owned = createApproval({ channel: 'desktop', sessionId: 'desktop-resident', description: 'write file', preview: buildActionPreview('write_file', { path: 'file.txt' }) });
    const pending = pendingApprovalsFor('desktop-resident')[0];
    onEvent({ type: 'approval', ...pending });
    return { text: (await owned.promise) ? 'allowed' : 'denied' };
  } });
  runtime.attach({ send: m => sent.push(m) });
  const pending = runtime.request('write a file');
  assert.equal(runtime.snapshot().approval.preview.target, 'file.txt');
  assert.match(sent.find(m => m.op === 'approval').text, /Expected effect:/);
  runtime.detach(); await pending;
  assert.equal(runtime.approve(owned.id, true), false);
});

test('browser formatters render hostile fields as bounded plain text', () => {
  const context = {};
  runInNewContext(readFileSync(new URL('../public/approval-preview.js', import.meta.url), 'utf8'), context);
  const hostile = '<img src=x onerror=alert(1)> & </pre><script>alert(2)</script>';
  const text = context.approvalPreviewText({ tool: hostile, target: hostile, effectSummary: 'x'.repeat(10000), redactions: [hostile] });
  assert.ok(text.includes(hostile)); // Literal text, not trusted/HTML-escaped markup.
  assert.ok(text.length < 1500);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const nodes = new Map();
  const el = { style: {}, querySelector(key) { if (!nodes.has(key)) nodes.set(key, { appendChild(node) { this.child = node; } }); return nodes.get(key); } };
  const document = { createElement: type => type === 'div' ? el : { style: {} } };
  const body = html.slice(html.indexOf('function addApproval('), html.indexOf('\nfunction scrollDown'));
  runInNewContext(body + ';addApproval("id", hostile, ()=>{}, {target:hostile});', { document, hostile, approvalPreviewText: context.approvalPreviewText, $: () => ({ appendChild() {} }), scrollDown() {} });
  assert.equal(nodes.get('code').textContent, hostile);
  assert.ok(nodes.get('.q').child.textContent.includes(hostile));
  assert.ok(!el.innerHTML.includes(hostile));
});

test('system_control volume/media previews name the action and stay honest about scope', () => {
  const vol = buildActionPreview('system_control', { action: 'set_volume', level: 40 });
  assert.equal(vol.action, 'set_volume');
  assert.equal(vol.target, 'local computer');
  assert.match(vol.effectSummary, /40%/);
  assert.match(vol.effectSummary, /Reversible/);
  for (const level of [500, -1, 50.5, '50-canary']) {
    const bad = buildActionPreview('system_control', { action: 'set_volume', level });
    assert.match(bad.effectSummary, /invalid level \(will be rejected\)/);
    assert.ok(!bad.effectSummary.includes('500') && !bad.effectSummary.includes('canary'), 'an invalid level is never echoed into the preview');
  }
  const media = buildActionPreview('system_control', { action: 'media_play_pause' });
  assert.equal(media.action, 'media_play_pause');
  assert.match(media.effectSummary, /media key|Core Audio/);
  // The destructive-sounding stranger still previews as unknown.
  assert.equal(buildActionPreview('system_control', { action: 'shutdown' }).effectSummary, 'unknown');
});
