import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Static policy: named dot/bracket reads from process.env or the config `env`
// alias must be documented. Computed keys/pass-through are not new named settings.
// Inspect assignment after consuming the WHOLE identifier to avoid backtracking
// turning `env.PINCH = ...` into a fictitious read of `PINC`.
function envReads(source) {
  const found = new Set();
  const access = /\b(?:process\s*\.\s*)?env\s*(?:\.\s*([A-Za-z_][A-Za-z0-9_]*)|\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\])/g;
  for (const match of source.matchAll(access)) {
    if (/^\s*=(?!=)/.test(source.slice(match.index + match[0].length))) continue;
    found.add(match[1] || match[3]);
  }
  return [...found];
}
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.(?:js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}
test('environment-read scanner recognizes literals and does not invent reads from writes', () => {
  assert.deepEqual(envReads(`process.env.PINCH = '1'; env.OTHER = 1; env['WRITE'] = 2;`), []);
  assert.deepEqual(envReads(`env.PINCH_KEY || ''; process.env['PINCH_DESKTOP'] === '1'; process.env["SystemRoot"]; process.env.PATH; env.PINCH_KEY;`), ['PINCH_KEY', 'PINCH_DESKTOP', 'SystemRoot', 'PATH']);
  assert.deepEqual(envReads(`env[key]; process.env[name];`), []);
  assert.deepEqual(envReads(`env.PINCH_DESKTOP === '1';`), ['PINCH_DESKTOP']);
});
test('every named environment read in src is documented in .env.example', () => {
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  const missing = [];
  const seen = new Set();
  for (const path of sourceFiles(join(root, 'src'))) {
    for (const name of envReads(readFileSync(path, 'utf8'))) {
      seen.add(name);
      if (!new RegExp(`\\b${name}\\b`).test(example)) missing.push(`${name}: ${path}`);
    }
  }
  assert.ok(seen.has('PINCH_DESKTOP'), 'the coverage check must scan the resident flag');
  assert.deepEqual(missing, [], 'Document new variables in .env.example, including launcher/OS-only reads as comments');
});
test('desktop is enabled only by Windows process flag 1, with safety overrides', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pinch-desktop-env-'));
  try {
    mkdirSync(join(fixture, 'src'));
    mkdirSync(join(fixture, '.git'));
    copyFileSync(join(root, 'src', 'state-paths.js'), join(fixture, 'src', 'state-paths.js'));
    copyFileSync(join(root, 'src', 'config.js'), join(fixture, 'src', 'config.js'));
    copyFileSync(join(root, 'src', 'brand-config.js'), join(fixture, 'src', 'brand-config.js'));
    writeFileSync(join(fixture, 'package.json'), '{"type":"module"}');
    writeFileSync(join(fixture, '.env'), 'PINCH_DESKTOP=1\nPINCH_HOST=0.0.0.0\nPINCH_AUTO_APPROVE=true\nPINCH_KEY=\n');
    const inspect = (platform, flag) => {
      const env = { ...process.env, PINCH_HOST: '0.0.0.0', PINCH_AUTO_APPROVE: 'true', PINCH_KEY: '' };
      delete env.PINCH_DESKTOP;
      if (flag !== undefined) env.PINCH_DESKTOP = flag;
      const script = `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});const {config}=await import(${JSON.stringify(pathToFileURL(join(fixture, 'src', 'config.js')).href)});console.log(JSON.stringify({desktop:config.desktopRequested,host:config.host,autoApprove:config.autoApprove,keyLength:config.authKey.length}));`;
      return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8', timeout: 10_000 }));
    };
    assert.deepEqual(inspect('win32', '1'), { desktop: true, host: '127.0.0.1', autoApprove: false, keyLength: 64 });
    for (const [platform, flag] of [['win32', undefined], ['win32', '0'], ['win32', 'true'], ['linux', '1']]) {
      assert.deepEqual(inspect(platform, flag), { desktop: false, host: '0.0.0.0', autoApprove: true, keyLength: 0 });
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
