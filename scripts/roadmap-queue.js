#!/usr/bin/env node
/** Pure queue selection; network writes remain in the least-privilege workflow. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const marker = body => [...String(body || '').matchAll(/<!-- roadmap:([^\s]+) -->/g)].map(match => match[1]);
export function selectQueue(roadmap, issues) {
  const history = issues.filter(issue => !issue.pull_request);
  const seen = new Set(history.flatMap(issue => marker(issue.body)));
  const open = history.filter(issue => String(issue.state).toLowerCase() === 'open' && marker(issue.body).length);
  const items = roadmap.items || [];
  let count = open.length;
  let easy = open.filter(issue => marker(issue.body).some(id => items.some(item => item.id === id && item.difficulty === 'easy'))).length;
  const totalCap = roadmap.meta?.open_curated_cap ?? 4, easyCap = roadmap.meta?.open_easy_cap ?? 3;
  const picked = [];
  for (const status of ['ready', 'backlog']) {
    for (const item of items) {
      if (item.status !== status || item.auto_file === false || seen.has(item.id)) continue;
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
