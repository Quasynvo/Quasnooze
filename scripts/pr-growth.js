#!/usr/bin/env node
/** Compare tracked text at the merge base and PR head without checking out or
 * executing PR code. Percentages measure line-count changes, not user growth,
 * implementation quality, test coverage or business impact. */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const AREAS = ['Product runtime', 'Tests & fixtures', 'Documentation', 'Automation & CI', 'Other'];
export function areaOf(path) {
  if (/^(?:src|bin|desktop)\//.test(path)) return AREAS[0];
  if (/^(?:test|test-fixtures)\//.test(path)) return AREAS[1];
  if (/^docs\//.test(path) || (!path.includes('/') && /\.(?:md|rst|txt)$/i.test(path))) return AREAS[2];
  if (/^(?:scripts|\.github)\//.test(path)) return AREAS[3];
  return AREAS[4];
}
const empty = () => Object.fromEntries(AREAS.map(area => [area, 0]));
function git(repo, args, allowEmpty = false) {
  try { return execFileSync('git', args, { cwd: repo, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (err) { if (allowEmpty && err.status === 1) return Buffer.alloc(0); throw err; }
}
function sha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new Error('Expected full commit SHA.');
  return value;
}

/** git grep -z produces <commit>:<path> NUL <count> LF. NUL rather than LF
 * delimits paths, so even adversarial filenames cannot create table rows. */
function countTextLines(repo, commit) {
  const output = git(repo, ['grep', '-I', '-c', '-z', '--no-textconv', '^', commit, '--'], true);
  const counts = empty(); let pos = 0;
  while (pos < output.length) {
    const nul = output.indexOf(0, pos), end = output.indexOf(10, nul + 1);
    if (nul < 0 || end < 0) throw new Error('Malformed git grep output.');
    const path = output.subarray(pos, nul).toString('utf8');
    const prefix = commit + ':';
    if (!path.startsWith(prefix)) throw new Error('Unexpected git grep tree.');
    const number = output.subarray(nul + 1, end).toString('ascii');
    if (!/^\d+$/.test(number)) throw new Error('Malformed line count.');
    counts[areaOf(path.slice(prefix.length))] += Number(number);
    pos = end + 1;
  }
  return counts;
}
function changedPaths(repo, base, head) {
  const output = git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, head, '--']);
  const counts = empty();
  for (const path of output.toString('utf8').split('\0')) if (path) counts[areaOf(path)]++;
  return counts;
}
export function percent(before, after) {
  if (before === 0) return null;
  return (after - before) * 100 / before;
}
export function compare(repo, baseSha, headSha) {
  const base = sha(baseSha), head = sha(headSha);
  const mergeBase = sha(git(repo, ['merge-base', base, head]).toString('utf8').trim());
  const before = countTextLines(repo, mergeBase), after = countTextLines(repo, head), changed = changedPaths(repo, mergeBase, head);
  const rows = AREAS.map(area => ({ area, before: before[area], after: after[area], changed: changed[area], percent: percent(before[area], after[area]) }));
  const sum = key => rows.reduce((n, row) => n + row[key], 0);
  const total = { area: 'Overall', before: sum('before'), after: sum('after'), changed: sum('changed') };
  total.percent = percent(total.before, total.after);
  return { mergeBase, head, rows: [...rows, total] };
}
const number = n => n.toLocaleString('en-US');
function signed(n, decimals = 0) { return `${n > 0 ? '+' : ''}${n.toFixed(decimals)}`; }
export function render(report) {
  const lines = [
    '<!-- pr-growth-metrics -->',
    '### PR change by project area',
    '',
    `Compared with merge base \`${report.mergeBase.slice(0, 12)}\` at PR head \`${report.head.slice(0, 12)}\`.`,
    '',
    '| Area | Changed paths | Text lines before | Text lines after | Net lines | Net change |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of report.rows) {
    const delta = row.after - row.before;
    const label = row.area === 'Overall' ? '**Overall**' : row.area;
    const change = row.percent === null ? 'N/A (zero baseline)' : `${signed(row.percent, 2)}%`;
    lines.push(`| ${label} | ${number(row.changed)} | ${number(row.before)} | ${number(row.after)} | ${signed(delta)} | ${change} |`);
  }
  lines.push('', '**How to read this:** Net change is (after − before) ÷ before × 100 for each area. Text lines are Git-tracked non-binary lines, including blank lines and comments; changed paths count both sides of a rename. Binary files, submodules and untracked files are excluded from line counts.', '', '**These are repository size and change indicators, not measured project growth or improvement.** More lines do not imply better functionality, security, quality, adoption, revenue, performance or test coverage; negative changes may be improvements. For outcomes, attach area-specific before/after measurements and verification in the PR.');
  return lines.join('\n') + '\n';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [base, head] = process.argv.slice(2);
    process.stdout.write(render(compare(process.cwd(), base, head)));
  } catch (err) { console.error(`PR metrics unavailable: ${err.message}`); process.exitCode = 1; }
}
