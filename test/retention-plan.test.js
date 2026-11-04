import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildRetentionPlan, retentionPolicies, renderRetentionPlan, RETENTION_CATEGORIES } from '../src/retention-plan.js';
const NOW = Date.parse('2026-11-04T12:00:00Z'), DAY = 86_400_000;
function fixture(fn) {
  const base = fs.mkdtempSync(join(tmpdir(), 'quas-retention-')), root = join(base, 'data');
  fs.mkdirSync(join(root, 'sessions'), { recursive: true });
  const file = (name, age, content = 'secret-message-canary') => {
    const path = join(root, name);
    fs.writeFileSync(path, content);
    fs.utimesSync(path, (NOW - age * DAY) / 1000, (NOW - age * DAY) / 1000);
    return path;
  };
  file('sessions/old.json', 31); file('sessions/recent.json', 2); file('sessions/edge.json', 30);
  file('sessions/future.json', -1);
  file('memory.json', 100); file('reminders.json', 100); file('schedules.json', 100);
  file('telemetry.ndjson', 100); file('telemetry.ndjson.1', 31); file('telemetry.ndjson.2', 2);
  file('.env', 100, 'OPENAI_API_KEY=credential-canary');
  file('profile.md', 100); file('tasks.json', 100); file('telemetry.ndjson.99', 100);
  try { fn({ base, root, file }); }
  finally { fs.rmSync(base, { recursive: true, force: true }); }
}
const plan = (root, opts = {}) => buildRetentionPlan({ dataDir: root, now: () => NOW, ...opts });
const allPolicies = Object.fromEntries(RETENTION_CATEGORIES.map(name => [name, 30]));

test('default policies are off; metadata-only counts separate all five categories', () => fixture(({ root }) => {
  const report = plan(root);
  assert.equal(report.status, 'complete');
  assert.deepEqual(Object.keys(report.categories), RETENTION_CATEGORIES);
  assert.equal(report.categories.sessions.observedFiles, 4);
  assert.equal(report.categories.telemetry.observedFiles, 3);
  for (const name of RETENTION_CATEGORIES) {
    const row = report.categories[name];
    assert.equal(row.policy.enabled, false);
    assert.equal(row.candidateFiles, 0);
    assert.ok(row.approximateBytes > 0);
  }
  assert.equal(report.categories.memory.exclusions['shared-record-store-protected'], 1);
  assert.equal(report.categories.sessions.exclusions['policy-off'], 4);
  const text = JSON.stringify(report) + renderRetentionPlan(report);
  for (const sensitive of ['secret-message-canary', 'credential-canary', 'old.json', root]) assert.ok(!text.includes(sensitive));
  assert.equal(report.exclusions['outside-inventory'], 4);
}));

test('injected clock and explicit ages identify old files but preserve aggregates/active telemetry', () => fixture(({ root }) => {
  const report = plan(root, { policies: allPolicies });
  assert.equal(report.generatedAt, '2026-11-04T12:00:00.000Z');
  const sessions = report.categories.sessions;
  assert.equal(sessions.ageEligibleFiles, 2);
  assert.equal(sessions.candidateFiles, 2);
  assert.equal(sessions.exclusions['unknown-or-future-modification-time'], 1);
  assert.equal(sessions.exclusions['within-retention-window'], 1);
  const telemetry = report.categories.telemetry;
  assert.equal(telemetry.ageEligibleFiles, 2);
  assert.equal(telemetry.candidateFiles, 1);
  assert.equal(telemetry.exclusions['active-telemetry-protected'], 1);
  for (const name of ['memory', 'reminders', 'schedules']) {
    assert.equal(report.categories[name].ageEligibleFiles, 1);
    assert.equal(report.categories[name].candidateFiles, 0);
    assert.equal(report.categories[name].exclusions['shared-record-store-protected'], 1);
  }
  const later = plan(root, { now: () => NOW + 40 * DAY, policies: allPolicies });
  assert.equal(later.categories.sessions.candidateFiles, 4);
  assert.equal(retentionPolicies().sessions, null); // No saved policy or hidden default.
}));

function snapshot(root) {
  const result = {};
  function walk(path, rel = '') {
    // Open first so metadata and contents refer to the same object, even if
    // its pathname is replaced. Snapshot only our private synthetic fixtures.
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      result[rel] = { mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      if (stat.isDirectory()) {
        const directory = `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${fd}`;
        for (const name of fs.readdirSync(directory)) walk(join(directory, name), `${rel}/${name}`);
      } else if (stat.isFile()) result[rel].content = fs.readFileSync(fd).toString('hex');
    } finally {
      fs.closeSync(fd);
    }
  }
  walk(root); return result;
}

test('zero application mutations and no file-content reads, even with enabled policies', () => fixture(({ root }) => {
  const before = snapshot(root), used = [];
  const allowed = new Set(['constants', 'openSync', 'closeSync', 'opendirSync', 'lstatSync']);
  const io = new Proxy(fs, { get(target, key) {
    assert.ok(allowed.has(key), `unexpected filesystem operation ${String(key)}`);
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => {
      used.push(key);
      if (key === 'openSync') assert.ok(args[1] & fs.constants.O_DIRECTORY, 'only directories may be opened');
      return target[key](...args);
    };
  } });
  assert.equal(plan(root, { policies: allPolicies, io }).status, 'complete');
  assert.deepEqual(snapshot(root), before);
  assert.ok(!used.includes('readFileSync'));
}));

test('symlinks, nested directories and unrecognized files are excluded without external traversal', () => fixture(({ base, root }) => {
  const external = join(base, 'outside'); fs.mkdirSync(external);
  fs.writeFileSync(join(external, 'outside-secret.json'), 'external-credential-canary');
  fs.symlinkSync(external, join(root, 'sessions', 'linked.json'));
  fs.symlinkSync(join(external, 'outside-secret.json'), join(root, 'telemetry.ndjson.3'));
  fs.mkdirSync(join(root, 'sessions', 'nested.json'));
  const report = plan(root, { policies: allPolicies });
  assert.equal(report.categories.sessions.observedFiles, 4);
  assert.equal(report.categories.sessions.exclusions['symbolic-link'], 1);
  assert.equal(report.categories.sessions.exclusions['not-a-regular-file'], 1);
  assert.equal(report.categories.telemetry.exclusions['symbolic-link'], 1);
  assert.ok(!JSON.stringify(report).includes('external-credential-canary'));
  fs.renameSync(join(root, 'sessions'), join(base, 'saved-sessions'));
  fs.symlinkSync(external, join(root, 'sessions'));
  const linked = plan(root);
  assert.equal(linked.status, 'partial');
  assert.equal(linked.categories.sessions.observedFiles, 0);
  const alias = join(base, 'alias'); fs.symlinkSync(root, alias);
  assert.equal(plan(alias).status, 'unavailable');
}));

test('descriptor anchoring survives root and session path replacement', () => fixture(({ base, root }) => {
  const external = join(base, 'outside'); fs.mkdirSync(external);
  fs.writeFileSync(join(external, 'stolen.json'), 'external-secret');
  let swapped = false;
  const io = { ...fs, opendirSync(path) {
    if (!swapped) {
      swapped = true;
      fs.renameSync(root, join(base, 'original-root'));
      fs.symlinkSync(external, root);
    }
    return fs.opendirSync(path);
  } };
  const report = plan(root, { io });
  assert.equal(report.status, 'complete');
  assert.equal(report.categories.sessions.observedFiles, 4);
  assert.equal(report.categories.memory.observedFiles, 1);
}));

test('entry/time limits, missing roots, access errors and unsupported traversal report honestly', () => fixture(({ base, root }) => {
  const bounded = plan(root, { maxEntries: 2 });
  assert.equal(bounded.scannedEntries, 2); assert.equal(bounded.truncated, true); assert.equal(bounded.status, 'partial');
  let tick = 0;
  const timed = plan(root, { clock: () => tick++, maxDurationMs: 1 });
  assert.equal(timed.status, 'partial'); assert.equal(timed.truncated, true);
  assert.equal(plan(join(base, 'missing')).status, 'missing');
  assert.ok(!fs.existsSync(join(base, 'missing')));
  const failed = plan(root, { io: { ...fs, lstatSync() { throw new Error('credential-canary EACCES'); } } });
  assert.equal(failed.status, 'partial'); assert.ok(!JSON.stringify(failed).includes('credential-canary'));
  const unsupported = plan(root, { platform: 'win32', io: new Proxy({}, { get() { throw new Error('must not access files'); } }) });
  assert.equal(unsupported.status, 'unavailable');
  assert.equal(unsupported.exclusions['safe-descriptor-traversal-unavailable'], 1);
}));

test('invalid options fail before filesystem access', () => {
  for (const policies of [{ typo: 30 }, { sessions: 0 }, { memory: -1 }, { telemetry: 1.5 }, { sessions: true }, []]) assert.throws(() => retentionPolicies(policies));
  for (const options of [{ now: () => NaN }, { maxEntries: 0 }, { maxEntries: Infinity }, { maxDurationMs: Infinity }]) assert.throws(() => plan('/unused', options));
});

test('CLI uses explicit configured data path, emits no secrets, and rejects mutation options', () => fixture(({ root }) => {
  const before = snapshot(root);
  const env = { ...process.env, PINCH_DATA: root, QUASNOOZE_DATA: root, PINCH_KEY: 'credential-canary', QUASNOOZE_KEY: 'credential-canary' };
  const raw = execFileSync(process.execPath, ['bin/quasnooze.js', 'retention-plan', '--json', '--sessions-days', '30'], { env, encoding: 'utf8' });
  const report = JSON.parse(raw);
  assert.equal(report.categories.sessions.policy.olderThanDays, 30);
  assert.equal(report.categories.sessions.observedFiles, 4);
  assert.ok(!raw.includes(root)); assert.ok(!raw.includes('canary'));
  assert.deepEqual(snapshot(root), before);
  const invalid = spawnSync(process.execPath, ['scripts/retention-plan.js', '--delete'], { env, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes(root));
  assert.deepEqual(snapshot(root), before);
}));


test('an opened session-directory descriptor cannot be redirected by replacement', () => fixture(({ base, root }) => {
  const outside = join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, 'external.json'), 'external-canary');
  let swapped = false;
  const io = { ...fs, openSync(path, flags) {
    const fd = fs.openSync(path, flags);
    if (!swapped && path.endsWith('/sessions')) {
      swapped = true;
      fs.renameSync(join(root, 'sessions'), join(base, 'original-sessions'));
      fs.symlinkSync(outside, join(root, 'sessions'));
    }
    return fd;
  } };
  const report = plan(root, { io });
  assert.equal(swapped, true);
  assert.equal(report.status, 'complete');
  assert.equal(report.categories.sessions.observedFiles, 4);
}));

test('CLI inherits the shared state-home resolver without creating state or saving policies', () => fixture(({ base, root }) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PINCH_') && !key.startsWith('QUASNOOZE_')));
  env.QUASNOOZE_STATE_HOME = base;
  const before = snapshot(base);
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/retention-plan.js', '--json'], { env, encoding: 'utf8' }));
  assert.equal(report.status, 'complete');
  assert.equal(report.categories.sessions.observedFiles, 4);
  assert.equal(report.categories.sessions.policy.enabled, false);
  assert.deepEqual(snapshot(base), before);
}));
