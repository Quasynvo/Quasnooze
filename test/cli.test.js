/**
 * smoke tests for bin/quasnooze.js — the entry point every user touches first.
 * CLI invocations use argv arrays; fixed npm commands use cmd.exe on Windows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const bin = fileURLToPath(new URL("../bin/quasnooze.js", import.meta.url));
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const pinch = (...args) =>
  new Promise((resolve) =>
    execFile(process.execPath, [bin, ...args], { timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }),
    ),
  );

test("--version exits 0 and prints the version from package.json", async () => {
  const r = await pinch("--version");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), version);
});

test("an unknown verb exits non-zero, names the verb and prints usage", async () => {
  const r = await pinch("definitely-not-a-verb");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Unknown command: definitely-not-a-verb/);
  assert.match(r.stdout, /quasnooze doctor/);
});

test("help exits 0 and lists real verbs", async () => {
  const r = await pinch("help");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /quasnooze doctor/);
  assert.match(r.stdout, /quasnooze audit/);
});

// Exercise npm's real packlist, including ignored/untracked local state.
// Only fixed npm arguments go through cmd.exe on Windows (npm.cmd requires it).
const { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { promisify } = await import('node:util');
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npmPack = async (cwd, dryRun = true) => {
  const { stdout } = await execute(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', ...(dryRun ? ['--dry-run'] : []), '--json', '--ignore-scripts'],
    { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' });
  return JSON.parse(stdout)[0];
};
function checkPackage(pack) {
  assert.equal(pack.name, '@quasynvo/quasnooze');
  assert.ok(pack.size > 0 && pack.size < 1_000_000, `tarball is ${pack.size} bytes`);
  const paths = pack.files.map(file => file.path);
  for (const path of paths) {
    assert.ok(!/(^|\/)(data|test|\.github)(\/|$)/.test(path), `local/development state bundled: ${path}`);
    assert.ok(!/(^|\/)\.env(?:\.|$)/.test(path), `environment file bundled: ${path}`);
    assert.ok(!path.includes('pack-canary'), `canary leaked: ${path}`);
    assert.ok(path === 'package.json' || metadata.files.filter(item => !item.startsWith('!')).some(item =>
      item.endsWith('/') ? path.startsWith(item) : path === item), `outside files allowlist: ${path}`);
  }
  // Every statically dispatched CLI script must exist in the packed artifact.
  const entry = readFileSync(bin, 'utf8');
  for (const [, target] of entry.matchAll(/run\("([^"]+)"/g)) assert.ok(paths.includes(target), `missing CLI target: ${target}`);
  for (const target of ['bin/quasnooze.js', 'src/config.js', 'public/index.html', 'desktop/windows.ps1', 'desktop/Companion.cs', 'desktop/SpeechDoctor.cs', 'desktop/startup.ps1', 'LICENSE', 'README.md']) {
    assert.ok(paths.includes(target), `missing runtime file: ${target}`);
  }
}
test('npm publish metadata uses @quasynvo/quasnooze, a public package, and an explicit files allowlist', () => {
  assert.equal(metadata.name, '@quasynvo/quasnooze');
  assert.notEqual(metadata.private, true);
  assert.equal(metadata.publishConfig.access, 'public');
  assert.equal(metadata.bin.quasnooze, './bin/quasnooze.js');
  assert.ok(Array.isArray(metadata.files) && metadata.files.length > 0);
});
test('npm pack dry-run excludes local state and stays below 1 MB', async () => {
  checkPackage(await npmPack(root));
});
test('seeded package excludes nested secrets/state and extracted CLI works offline', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'pinch-pack-'));
  try {
    for (const path of ['package.json', 'LICENSE', 'README.md', 'bin', 'src', 'public', 'scripts', 'desktop']) {
      cpSync(join(root, path), join(fixture, path), { recursive: true });
    }
    for (const prefix of ['', 'src/', 'bin/', 'public/']) {
      for (const path of ['.env', '.env.local', 'data/pack-canary.json', 'data/pack-canary.js', 'test/pack-canary.js', '.github/pack-canary.yml']) {
        const target = join(fixture, prefix + path);
        mkdirSync(join(target, '..'), { recursive: true });
        writeFileSync(target, 'synthetic pack-canary; not a real secret');
      }
    }
    writeFileSync(join(fixture, 'scripts', 'pack-canary.js'), 'not an approved runtime script');
    checkPackage(await npmPack(fixture));
    const packed = await npmPack(fixture, false);
    checkPackage(packed);
    const extracted = join(fixture, 'extracted');
    mkdirSync(extracted);
    await execute('tar', ['-xzf', join(fixture, packed.filename), '-C', extracted], { timeout: 10_000 });
    const packedBin = join(extracted, 'package', 'bin', 'quasnooze.js');
    const versionResult = await execute(process.execPath, [packedBin, '--version'], { timeout: 10_000 });
    assert.equal(versionResult.stdout.trim(), version);
    const legacyVersion = await execute(process.execPath, [join(extracted, 'package', 'bin', 'pinch.js'), '--version'], { timeout: 10_000 });
    assert.equal(legacyVersion.stdout.trim(), version);
    const growthURL = pathToFileURL(join(extracted, 'package', 'scripts', 'growth.js')).href;
    await execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(growthURL)})`], { timeout: 10_000 });

    const answer = await execute(process.execPath, [packedBin, 'ask', 'hello'], {
      timeout: 10_000,
      env: { ...process.env, LLM_PROVIDER: 'mock', PINCH_DATA: join(fixture, 'state'), PINCH_WORKSPACE: fixture, PINCH_KEY: '' },
    });
    assert.ok(answer.stdout.trim().length > 0);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
