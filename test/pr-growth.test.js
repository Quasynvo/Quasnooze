import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { areaOf, compare, percent, render } from '../scripts/pr-growth.js';

function fixture(fn) {
  const repo = mkdtempSync(join(tmpdir(), 'pr-metrics-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, contents) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), contents); };
  try {
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fn({ repo, git, put });
  } finally { rmSync(repo, { recursive: true, force: true }); }
}

test('calculates per-area and total changes against the merge base, without executing PR code', () => fixture(({ repo, git, put }) => {
  put('src/app.js', 'one\ntwo\n'); put('docs/guide.md', 'first\nsecond\n'); put('test/a.test.js', 'one\n');
  put('assets/image.bin', Buffer.from([0, 1, 2]));
  git('add', '.'); git('commit', '-qm', 'base'); const base = git('rev-parse', 'HEAD');
  put('src/app.js', 'one\ntwo\nthree\n'); put('test/a.test.js', 'one\ntwo\n'); put('docs/guide.md', 'first\n');
  put('src/odd\n| fake | 999%.js', '#!/bin/sh\ntouch EXECUTED\n');
  put('scripts/added.js', 'throw new Error("must not execute");\n');
  put('assets/image.bin', Buffer.from([0, 3, 4]));
  git('add', '.'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD');
  const report = compare(repo, base, head);
  const byArea = Object.fromEntries(report.rows.map(r => [r.area, r]));
  assert.deepEqual(byArea['Product runtime'], { area: 'Product runtime', before: 2, after: 5, changed: 2, percent: 150 });
  assert.equal(byArea['Tests & fixtures'].percent, 100);
  assert.equal(byArea.Documentation.percent, -50);
  assert.equal(byArea['Automation & CI'].percent, null);
  assert.equal(byArea.Other.before, 0); assert.equal(byArea.Other.after, 0); assert.equal(byArea.Other.changed, 1);
  assert.equal(byArea.Overall.before, 5); assert.equal(byArea.Overall.after, 9);
  const body = render(report);
  assert.match(body, /\| Documentation \| 1 \| 2 \| 1 \| -1 \| -50\.00% \|/);
  assert.match(body, /N\/A \(zero baseline\)/);
  assert.match(body, /not measured project growth or improvement/);
  assert.doesNotMatch(body, /fake \| 999%/);
  assert.throws(() => readFileSync(join(repo, 'EXECUTED')));
}));

test('rename across areas counts both paths and merge-base excludes unrelated base changes', () => fixture(({ repo, git, put }) => {
  put('src/a.txt', 'a\nb\n'); git('add', '.'); git('commit', '-qm', 'common');
  const common = git('rev-parse', 'HEAD');
  mkdirSync(join(repo, 'docs')); renameSync(join(repo, 'src/a.txt'), join(repo, 'docs/a.txt'));
  git('add', '-A'); git('commit', '-qm', 'head'); const head = git('rev-parse', 'HEAD');
  // Create a divergent base commit without checking out a branch.
  const tree = git('rev-parse', `${common}^{tree}`);
  const divergent = git('-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', common, '-m', 'base');
  const r = compare(repo, divergent, head);
  assert.equal(r.mergeBase, common);
  assert.equal(r.rows.find(x => x.area === 'Product runtime').changed, 1);
  assert.equal(r.rows.find(x => x.area === 'Documentation').changed, 1);
  assert.equal(r.rows.at(-1).changed, 2);
  assert.equal(percent(0, 0), null); assert.equal(percent(0, 5), null); assert.equal(percent(4, 2), -50);
}));

test('refuses revision expressions and classifies all paths consistently', () => {
  assert.throws(() => compare('.', 'HEAD', 'HEAD'), /full commit SHA/);
  assert.equal(areaOf('src/x.js'), 'Product runtime'); assert.equal(areaOf('test-fixtures/x'), 'Tests & fixtures');
  assert.equal(areaOf('README.md'), 'Documentation'); assert.equal(areaOf('.github/workflows/test.yml'), 'Automation & CI');
  assert.equal(areaOf('assets/a.png'), 'Other');
});

test('fork-safe workflow executes trusted default-branch code and updates only bot-owned comments', () => {
  const workflow = readFileSync(new URL('../.github/workflows/pr-growth.yml', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /refs\/pull\/\$PR_NUMBER\/head/);
  assert.match(workflow, /\.user\.login == "github-actions\[bot\]"/);
  assert.doesNotMatch(workflow, /pull_request\.head\.(?:sha|ref).*checkout|npm (?:install|ci)|git checkout.*pr-metrics/);
});

test('metrics job grants pull-requests: write, the scope PR comments actually need', () => {
  // PR conversation comments go through POST/PATCH /issues/{n}/comments, but the
  // target object is a pull request, so the write check is against
  // pull-requests. `pull-requests: read` fails with HTTP 403
  // "Resource not accessible by integration" on every run (see #186).
  const workflow = readFileSync(new URL('../.github/workflows/pr-growth.yml', import.meta.url), 'utf8');
  const jobIndex = workflow.search(/^jobs:\s*$/m);
  assert.notEqual(jobIndex, -1, 'workflow must declare a jobs block');
  const job = workflow.slice(jobIndex);
  const jobPermissions = /^ {4}permissions:\s*\n((?: {6}.+\n)+)/m.exec(job);
  assert.ok(jobPermissions, 'metrics job must declare its own permissions block');
  assert.match(jobPermissions[1], /^ {6}pull-requests: write$/m);
  assert.match(jobPermissions[1], /^ {6}issues: write$/m);
  assert.doesNotMatch(jobPermissions[1], /^ {6}pull-requests: read$/m);
  // The workflow-level token stays read-only; the write scopes live on the job.
  const header = workflow.slice(0, jobIndex);
  assert.match(header, /^permissions:\s*\n {2}contents: read$/m);
});
