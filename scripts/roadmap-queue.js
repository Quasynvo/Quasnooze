#!/usr/bin/env node
/** Pure queue selection; network writes remain in the least-privilege workflow. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const marker = body => [...String(body || '').matchAll(/<!-- roadmap:([^\s]+) -->/g)].map(match => match[1]);
export function isContributorIssue(issue) {
  if (issue.pull_request || String(issue.state).toLowerCase() !== 'open') return false;
  const labels = (issue.labels || []).map(label => typeof label === 'string' ? label : label.name);
  return marker(issue.body).length > 0 || String(issue.body || '').includes('<!-- growth:fingerprint:') || labels.some(label => ['growth', 'help wanted', 'good first issue'].includes(label));
}
export function countContributorIssues(issues) { return issues.filter(isContributorIssue).length; }
export function selectQueue(roadmap, issues, today = new Date().toISOString().slice(0, 10)) {
  const history = issues.filter(issue => !issue.pull_request);
  const seen = new Set(history.flatMap(issue => marker(issue.body)));
  const open = history.filter(issue => String(issue.state).toLowerCase() === 'open' && marker(issue.body).length);
  const items = roadmap.items || [];
  let count = countContributorIssues(history);
  let easy = open.filter(issue => marker(issue.body).some(id => items.some(item => item.id === id && item.difficulty === 'easy'))).length;
  const totalCap = roadmap.meta?.open_curated_cap ?? 4, easyCap = roadmap.meta?.open_easy_cap ?? 3;
  const picked = [];
  for (const status of ['ready', 'backlog']) {
    for (const item of items) {
      if (item.status !== status || item.auto_file === false || seen.has(item.id)) continue;
      // Optional rollout gates are deliberately fail-closed. Legacy entries without
      // these fields retain their existing behavior. Dates are UTC calendar dates.
      if (item.not_before !== undefined && (typeof item.not_before !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.not_before) || !Number.isFinite(Date.parse(item.not_before)) || new Date(item.not_before).toISOString().slice(0, 10) !== item.not_before || item.not_before > today)) continue;
      if (item.depends_on !== undefined && (!Array.isArray(item.depends_on) || !item.depends_on.every(id => typeof id === 'string' && items.some(dep => dep.id === id && dep.status === 'shipped')))) continue;
      if (!['## Context', '## Acceptance criteria', '## How to verify', '## Time estimate'].every(section => String(item.body || '').includes(section)) || !item.files?.length || !item.verify) continue;
      if (count >= totalCap || (item.difficulty === 'easy' && easy >= easyCap)) continue;
      picked.push(item);seen.add(item.id);count++;if (item.difficulty === 'easy') easy++;
    }
  }
  return picked;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifest, history] = process.argv.slice(2);
  console.log(JSON.stringify(selectQueue(JSON.parse(readFileSync(manifest, 'utf8')), JSON.parse(readFileSync(history, 'utf8')))));
}
