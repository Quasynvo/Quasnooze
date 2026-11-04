import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { prepareSupportBundle, writeSupportBundle, aggregateSupportTelemetry, SUPPORT_LIMITS } from '../src/support-bundle.js';
const CANARY = 'private-canary-token-never-share';
function fixture(fn) {
  const root = fs.mkdtempSync(join(tmpdir(), 'quas-support-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const environment = { appVersion: '1.0.0', nodeVersion: 'v22.22.3', platform: 'linux', osRelease: '6.1.0-local-canary', arch: 'x64', hostname: CANARY, username: CANARY, env: { TOKEN: CANARY } };
const unpack = preview => JSON.parse(preview.text);

test('allowlists versions, readiness enums and aggregate timings; drops canaries at every level', () => fixture(root => {
  const snapshotPath = join(root, 'snapshot.json'), telemetryPath = join(root, 'telemetry.ndjson');
  fs.writeFileSync(snapshotPath, JSON.stringify({ schema_version: 1, owner: CANARY, model: CANARY, routing: { endpoint: CANARY }, tokens: CANARY,
    readiness: { state: 'ready', next_action: CANARY, provider: CANARY, surfaces: { text: { state: 'ready', next_action: CANARY }, voice: { state: 'mic-muted', detail: CANARY } } },
    clipboard: CANARY, audio: CANARY, memory: CANARY, profile: CANARY, checks: [{ detail: CANARY }], workspace: [root] }));
  fs.writeFileSync(telemetryPath, [10, 20, 30].map(ms => JSON.stringify({ kind: 'turn', ms, firstTextMs: ms / 2, sessionId: CANARY, prompt: CANARY, response: CANARY, model: CANARY, path: root, token: CANARY })).join('\n') + '\n');
  const preview = prepareSupportBundle({ snapshotPath, telemetryPath, environment });
  assert.ok(Object.isFrozen(preview));
  assert.ok(preview.bytes <= SUPPORT_LIMITS.outputBytes);
  assert.ok(!preview.text.includes(CANARY)); assert.ok(!preview.text.includes(root));
  assert.ok(!preview.text.includes('local-canary'));
  const bundle = unpack(preview);
  assert.deepEqual(bundle.environment, { appVersion: '1.0.0', nodeVersion: '22.22.3', os: 'linux', osVersion: '6.1.0', architecture: 'x64' });
  assert.equal(bundle.readiness.state, 'ready');
  assert.equal(bundle.readiness.voice, 'mic-muted');
  assert.equal(bundle.readiness.source, 'supplied-snapshot-unverified');
  assert.deepEqual(bundle.timings.duration, { samples: 3, meanMs: 20, p50Ms: 20, p95Ms: 30 });
  assert.deepEqual(bundle.timings.firstText, { samples: 3, meanMs: 10, p50Ms: 10, p95Ms: 15 });
  assert.deepEqual(Object.keys(bundle), ['kind', 'schemaVersion', 'localOnly', 'environment', 'readiness', 'timings', 'limits', 'privacy']);
}));

test('missing snapshots and unknown/malicious values never imply observed readiness', () => fixture(root => {
  const missing = unpack(prepareSupportBundle({ environment }));
  assert.equal(missing.readiness.state, 'unavailable');
  assert.equal(missing.readiness.inputStatus, 'not-supplied');
  assert.equal(missing.timings.inputStatus, 'not-supplied');
  const file = join(root, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, readiness: { state: CANARY, surfaces: { text: { state: CANARY }, voice: { state: CANARY } } } }));
  const preview = prepareSupportBundle({ snapshotPath: file, environment: Object.fromEntries(Object.keys(environment).map(key => [key, CANARY])) });
  assert.ok(!preview.text.includes(CANARY));
  assert.equal(unpack(preview).readiness.state, 'unavailable');
  assert.ok(Object.values(unpack(preview).environment).every(value => value === null));
}));

test('malformed and oversized snapshots are bounded and do not leak contents or errors', () => fixture(root => {
  const file = join(root, 'snapshot.json');
  fs.writeFileSync(file, `{${CANARY}`);
  assert.equal(unpack(prepareSupportBundle({ snapshotPath: file, environment })).readiness.inputStatus, 'malformed');
  fs.writeFileSync(file, CANARY.repeat(Math.ceil(SUPPORT_LIMITS.snapshotBytes / CANARY.length) + 1));
  let reads = 0;
  const io = { ...fs, readSync(...args) { reads++; return fs.readSync(...args); } };
  const preview = prepareSupportBundle({ snapshotPath: file, environment, io });
  assert.equal(reads, 0);
  assert.equal(unpack(preview).readiness.inputStatus, 'oversized');
  assert.ok(!preview.text.includes(CANARY));
  assert.equal(unpack(prepareSupportBundle({ snapshotPath: join(root, CANARY), environment })).readiness.inputStatus, 'unavailable');
}));

test('telemetry enforces byte, record and row limits with malformed data and invalid numbers', () => fixture(root => {
  const text = [CANARY, JSON.stringify({ kind: 'turn', ms: '100', firstTextMs: -1 }),
    JSON.stringify({ kind: 'turn', ms: Infinity, firstTextMs: SUPPORT_LIMITS.maximumTimingMs + 1 }),
    JSON.stringify({ kind: 'other', ms: 999, prompt: CANARY }), JSON.stringify({ kind: 'turn', ms: 50, firstTextMs: 0 }),
    'x'.repeat(SUPPORT_LIMITS.recordBytes + 1)].join('\n') + '\n';
  const result = aggregateSupportTelemetry(Buffer.from(text), 'complete');
  assert.equal(result.malformedRecords, 1); assert.equal(result.oversizedRecords, 1); assert.equal(result.ignoredRecords, 1);
  assert.deepEqual(result.duration, { samples: 1, meanMs: 50, p50Ms: 50, p95Ms: 50 });
  assert.equal(result.firstText.samples, 1);
  const many = aggregateSupportTelemetry(Buffer.from((JSON.stringify({ kind: 'turn', ms: 1 }) + '\n').repeat(500)), 'complete');
  assert.equal(many.scannedRecords, SUPPORT_LIMITS.records); assert.equal(many.duration.samples, SUPPORT_LIMITS.records); assert.equal(many.recordLimitReached, true);
  const file = join(root, 'oversized.ndjson');
  fs.writeFileSync(file, 'x'.repeat(SUPPORT_LIMITS.telemetryBytes + 100));
  const bundle = unpack(prepareSupportBundle({ telemetryPath: file, environment }));
  assert.equal(bundle.timings.inputStatus, 'partial');
  assert.equal(bundle.timings.bytesRead, SUPPORT_LIMITS.telemetryBytes);
  assert.equal(bundle.timings.partialRecordDiscarded, true);
  assert.equal(bundle.timings.duration.samples, 0);
  assert.throws(() => aggregateSupportTelemetry(Buffer.alloc(SUPPORT_LIMITS.telemetryBytes + 1)), /bounded/);
}));

test('preview performs no writes/probes and opens only explicitly supplied inputs', () => fixture(root => {
  const path = join(root, 'status.json'); fs.writeFileSync(path, '{}');
  const allowed = new Set(['constants', 'openSync', 'fstatSync', 'readSync', 'closeSync']), opens = [];
  const io = new Proxy(fs, { get(target, key) {
    assert.ok(allowed.has(key), `unexpected filesystem operation ${String(key)}`);
    if (key === 'openSync') return (...args) => { assert.equal(args[1] & fs.constants.O_WRONLY, 0); opens.push(args[0]); return fs.openSync(...args); };
    return target[key];
  } });
  const originalFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('network forbidden'); };
  try {
    const preview = prepareSupportBundle({ snapshotPath: path, environment, io });
    assert.deepEqual(opens, [path]); assert.equal(unpack(preview).readiness.state, 'unavailable');
  } finally { globalThis.fetch = originalFetch; }
  assert.deepEqual(fs.readdirSync(root), ['status.json']);
  assert.equal(fs.readFileSync(path, 'utf8'), '{}');
}));

test('save requires exact-preview confirmation and writes only the chosen exclusive destination', () => fixture(root => {
  const preview = prepareSupportBundle({ environment }), destination = join(root, 'chosen.json');
  assert.throws(() => writeSupportBundle(preview, { destination }), /confirmation/);
  assert.throws(() => writeSupportBundle(preview, { destination, confirmation: 'wrong' }), /confirmation/);
  assert.deepEqual(fs.readdirSync(root), []);
  const changed = { ...preview, text: preview.text + ' ' };
  assert.throws(() => writeSupportBundle(changed, { destination, confirmation: preview.sha256 }), /confirmation/);
  const result = writeSupportBundle(preview, { destination, confirmation: preview.sha256 });
  assert.equal(result.saved, true);
  assert.equal(fs.readFileSync(destination, 'utf8'), preview.text);
  assert.throws(() => writeSupportBundle(preview, { destination, confirmation: preview.sha256 }), /never overwritten/);
  assert.equal(fs.readFileSync(destination, 'utf8'), preview.text);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    const alias = join(root, 'alias'); fs.symlinkSync(destination, alias);
    assert.throws(() => writeSupportBundle(preview, { destination: alias, confirmation: preview.sha256 }), /never overwritten/);
  }
}));

test('write failures are honest and never delete/overwrite another file', () => fixture(root => {
  const preview = prepareSupportBundle({ environment }), destination = join(root, 'partial.json');
  const io = { ...fs, writeFileSync() { throw new Error(CANARY); } };
  assert.throws(() => writeSupportBundle(preview, { destination, confirmation: preview.sha256, io }), error => !error.message.includes(CANARY) && error.message.includes('partial file'));
  // A partial new file is deliberately left for inspection, not reported saved.
  assert.deepEqual(fs.readdirSync(root), ['partial.json']);
}));

test('CLI previews by default, rejects unattended save/auto-yes and never loads personal export', () => fixture(root => {
  const destination = join(root, 'chosen.json');
  const env = { ...process.env, OPENAI_API_KEY: CANARY, PINCH_DATA: join(root, CANARY) };
  const preview = spawnSync(process.execPath, ['bin/quasnooze.js', 'support-bundle', '--out', destination], { env, encoding: 'utf8' });
  assert.equal(preview.status, 0); assert.equal(JSON.parse(preview.stdout).kind, 'quasnooze-local-support');
  assert.ok(!preview.stdout.includes(CANARY)); assert.ok(!preview.stderr.includes(destination));
  assert.deepEqual(fs.readdirSync(root), []);
  const rejected = spawnSync(process.execPath, ['scripts/support-bundle.js', '--write', '--out', destination], { input: 'SAVE\n', env, encoding: 'utf8' });
  assert.equal(rejected.status, 1); assert.deepEqual(fs.readdirSync(root), []);
  const auto = spawnSync(process.execPath, ['scripts/support-bundle.js', '--yes'], { env, encoding: 'utf8' });
  assert.equal(auto.status, 1); assert.deepEqual(fs.readdirSync(root), []);
}));


test('confirmed save uses frozen preview bytes without re-reading modified inputs', () => fixture(root => {
  const source = join(root, 'status.json'), destination = join(root, 'bundle.json');
  fs.writeFileSync(source, JSON.stringify({ schema_version: 1, readiness: { state: 'mic-muted' } }));
  const preview = prepareSupportBundle({ snapshotPath: source, environment });
  fs.writeFileSync(source, JSON.stringify({ schema_version: 1, readiness: { state: 'ready' }, token: CANARY }));
  writeSupportBundle(preview, { destination, confirmation: preview.sha256 });
  const saved = fs.readFileSync(destination, 'utf8');
  assert.equal(saved, preview.text);
  assert.equal(JSON.parse(saved).readiness.state, 'mic-muted');
  assert.ok(!saved.includes(CANARY));
}));

test('unknown schemas, non-regular inputs and read errors are reported unavailable', () => fixture(root => {
  const path = join(root, 'status.json');
  fs.writeFileSync(path, JSON.stringify({ schema_version: 999, readiness: { state: 'ready' } }));
  assert.equal(unpack(prepareSupportBundle({ snapshotPath: path, environment })).readiness.state, 'unavailable');
  assert.equal(unpack(prepareSupportBundle({ snapshotPath: root, environment })).readiness.inputStatus, 'unavailable');
  const failed = prepareSupportBundle({ snapshotPath: path, environment, io: { ...fs, readSync() { throw new Error(CANARY); } } });
  assert.equal(unpack(failed).readiness.inputStatus, 'unavailable');
  assert.ok(!failed.text.includes(CANARY));
  if (fs.constants.O_NOFOLLOW) {
    const link = join(root, 'alias'); fs.symlinkSync(path, link);
    assert.equal(unpack(prepareSupportBundle({ snapshotPath: link, environment })).readiness.inputStatus, 'unavailable');
  }
}));
