import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStatePaths, assertNoLegacyState } from '../src/state-paths.js';
import { previewMigration, migrateState } from '../src/state-migration.js';

const paths = (options = {}) => resolveStatePaths({ root: '/pkg', home: '/owner', platform: 'linux', clone: false, env: {}, ...options });
test('platform defaults and overrides remain stable across package updates', () => {
  assert.equal(paths().stateHome, '/owner/.local/state/quasnooze');
  assert.deepEqual(paths({ root: '/new/npx/cache' }), paths());
  assert.equal(paths({ env: { XDG_STATE_HOME: '/state' } }).stateHome, '/state/quasnooze');
  assert.equal(paths({ env: { XDG_STATE_HOME: 'relative' } }).stateHome, paths().stateHome);
  assert.equal(paths({ platform: 'darwin' }).stateHome, '/owner/Library/Application Support/quasnooze');
  assert.equal(paths({ platform: 'win32', home: 'C:\\Users\\owner', env: { LOCALAPPDATA: 'D:\\Local' } }).stateHome, 'D:\\Local\\quasnooze');
  assert.equal(paths({ platform: 'win32', home: 'C:\\Users\\owner' }).stateHome, 'C:\\Users\\owner\\AppData\\Local\\quasnooze');
  assert.equal(paths({ env: { PINCH_DATA: '/nas' } }).dataDir, '/nas');
  assert.equal(paths({ env: { PINCH_DATA: '/old', QUASNOOZE_DATA: '/new' } }).dataDir, '/new');
  assert.equal(paths({ clone: true }).envPath, '/pkg/.env');
  assert.equal(paths({ clone: true, env: { QUASNOOZE_STATE_HOME: '/user' } }).envPath, '/user/.env');
  assert.throws(() => paths({ env: { PINCH_STATE_HOME: 'relative' } }), /absolute/);
});

function fixture(fn) {
  const base = fs.mkdtempSync(join(tmpdir(), 'quas-state-'));
  const source = join(base, 'package'), target = join(base, 'owner');
  fs.mkdirSync(source);
  fs.writeFileSync(join(source, '.env'), 'OPENAI_API_KEY=secret-fixture\n');
  fs.mkdirSync(join(source, 'data'));
  fs.writeFileSync(join(source, 'data', 'memory.json'), '{"personal":"fixture"}');
  try { fn({ base, source, target }); }
  finally { fs.chmodSync(source, 0o700); fs.rmSync(base, { recursive: true, force: true }); }
}

test('clone, read-only global and npx fixtures reproduce legacy roots without writing them', () => fixture(({ base, source, target }) => {
  fs.mkdirSync(join(source, '.git'));
  assert.equal(resolveStatePaths({ root: source }).envPath, join(source, '.env'));
  fs.rmSync(join(source, '.git'), { recursive: true });
  fs.chmodSync(source, 0o555);
  for (const root of [source, join(base, '_npx', 'package')]) {
    const resolved = resolveStatePaths({ root, env: { QUASNOOZE_STATE_HOME: target } });
    assert.equal(resolved.envPath, join(target, '.env'));
  }
  assert.throws(() => assertNoLegacyState(source, { stateHome: target, envPath: join(target, '.env') }), /preview migration/);
  const plan = previewMigration(source, target);
  assert.ok(!JSON.stringify(plan).includes('secret-fixture'));
  assert.ok(!fs.existsSync(target));
  assert.throws(() => migrateState(source, target), /confirmation/);
  migrateState(source, target, { confirmed: true });
  assert.equal(fs.readFileSync(join(target, '.env'), 'utf8'), fs.readFileSync(join(source, '.env'), 'utf8'));
  assert.equal(fs.readFileSync(join(target, 'data', 'memory.json'), 'utf8'), '{"personal":"fixture"}');
  fs.writeFileSync(join(target, 'data', 'restart.json'), '{}');
  assert.doesNotThrow(() => assertNoLegacyState(source, { stateHome: target, envPath: join(target, '.env') }));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(fs.statSync(join(target, '.env')).mode & 0o777, 0o600);
  }
  assert.throws(() => migrateState(source, target, { confirmed: true }), /already exists/);
}));

test('failure injection at every mutating copy step rolls back and keeps originals', () => fixture(({ source, target }) => {
  for (const operation of ['writeFileSync', 'copyFileSync', 'chmodSync', 'unlinkSync']) {
    const io = { ...fs, [operation]: () => { throw new Error('ACL denied secret-fixture'); } };
    assert.throws(() => migrateState(source, target, { confirmed: true, io }), error => {
      assert.ok(!error.message.includes('secret-fixture'));
      return /originals preserved/.test(error.message);
    });
    assert.ok(!fs.existsSync(target));
    assert.equal(fs.readFileSync(join(source, '.env'), 'utf8'), 'OPENAI_API_KEY=secret-fixture\n');
  }
  assert.throws(() => migrateState(source, target, { confirmed: true, io: { ...fs, mkdirSync: () => { throw new Error('EACCES'); } } }), /EACCES/);
  assert.ok(!fs.existsSync(target));
}));

test('conflicts, overlap, symlinks and incomplete migration are refused', () => fixture(({ source, target }) => {
  assert.throws(() => previewMigration(source, join(source, 'user')), /overlap/);
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, '.env'), 'keep');
  assert.throws(() => previewMigration(source, target), /already exists/);
  assert.equal(fs.readFileSync(join(target, '.env'), 'utf8'), 'keep');
  fs.writeFileSync(join(target, '.migration-in-progress'), '');
  assert.throws(() => assertNoLegacyState(source, { stateHome: target }), /incomplete/);
  fs.rmSync(target, { recursive: true });
  if (process.platform !== 'win32') {
    fs.symlinkSync(join(source, '.env'), join(source, 'data', 'link'));
    assert.throws(() => migrateState(source, target, { confirmed: true }), /rolled back/);
    assert.ok(!fs.existsSync(target));
  }
}));

test('ACL cleanup denial preserves originals and leaves an explicit incomplete marker', () => fixture(({ source, target }) => {
  const io = { ...fs, copyFileSync: () => { throw new Error('denied'); }, rmSync: () => { throw new Error('denied'); } };
  assert.throws(() => migrateState(source, target, { confirmed: true, io }), /cleanup needs owner attention/);
  assert.ok(fs.existsSync(join(source, '.env')));
  assert.throws(() => assertNoLegacyState(source, { stateHome: target }), /incomplete/);
}));


test('packaged runtime reads user config and persists data across restart and package replacement', () => fixture(({ base, target }) => {
  fs.mkdirSync(target);
  fs.writeFileSync(join(target, '.env'), 'OWNER_NAME=durable-owner\nPINCH_KEY=secret-fixture\n');
  const marker = join(target, 'data', 'persistent.json');
  fs.mkdirSync(join(target, 'data'));
  fs.writeFileSync(marker, 'retained', { flag: 'wx' });
  const repo = fileURLToPath(new URL('../', import.meta.url));
  for (const install of ['global-v1', 'npx-v2', 'global-v1']) {
    const root = join(base, install);
    fs.mkdirSync(join(root, 'src'), { recursive: true });
    fs.writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    for (const name of ['config.js', 'brand-config.js', 'state-paths.js', 'providers.js', 'store.js']) {
      fs.copyFileSync(join(repo, 'src', name), join(root, 'src', name));
    }
    const code = `const {config}=await import(${JSON.stringify(pathToFileURL(join(root, 'src/config.js')).href)});
      const {ensureData}=await import(${JSON.stringify(pathToFileURL(join(root, 'src/store.js')).href)});
      ensureData(); console.log(JSON.stringify({owner:config.ownerName,data:config.dataDir,profile:config.profilePath}));`;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PINCH_') && !key.startsWith('QUASNOOZE_')));
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...env, QUASNOOZE_STATE_HOME: target }, encoding: 'utf8',
    });
    assert.ok(!output.includes('secret-fixture'));
    assert.deepEqual(JSON.parse(output), { owner: 'durable-owner', data: join(target, 'data'), profile: join(target, 'data/profile.md') });
    // Read directly: a missing or changed marker must fail, not be recreated.
    assert.equal(fs.readFileSync(marker, 'utf8'), 'retained');
    assert.ok(!fs.existsSync(join(root, 'data')));
    assert.ok(!fs.existsSync(join(root, '.env')));
  }
}));
