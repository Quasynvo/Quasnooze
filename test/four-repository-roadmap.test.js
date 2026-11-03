import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectQueue } from '../scripts/roadmap-queue.js';

const manifest = JSON.parse(readFileSync('.github/roadmap.json', 'utf8'));
const doc = readFileSync('docs/FOUR-REPOSITORY-AGENT-AUDIT.md', 'utf8');
const proposed = manifest.items.filter(item => item.id.startsWith('harness-'));

test('four-repository issues have actionable structured fields and mirrored bodies', () => {
  assert.equal(proposed.length, 16);
  for (const item of proposed) {
    assert.ok(item.title && item.problem_statement && item.upgraded_design_spec, item.id);
    assert.ok(item.labels.length && item.affected_files.length && item.acceptance_criteria.length, item.id);
    assert.ok(item.verify && item.body.includes('## How to verify'), item.id);
    assert.ok(doc.includes(item.title) && doc.includes(item.problem_statement) && doc.includes(item.body), item.id);
    for (const dependency of item.depends_on) {
      assert.ok(manifest.items.some(other => other.id === dependency), `${item.id}: ${dependency}`);
    }
  }
});

test('four-repository issues obey their release date and shipped prerequisite gates', () => {
  // Isolate one proposed item from the global queue to test gates regardless of cap.
  const item = proposed.find(i => i.id === 'harness-02-config-scan');
  const dep = { ...manifest.items.find(i => i.id === item.depends_on[0]), status: 'backlog' };
  const queue = { meta: { open_curated_cap: 10 }, items: [dep, item] };
  assert.ok(!selectQueue(queue, [], '2026-11-02').some(i => i.id === item.id));
  assert.ok(!selectQueue(queue, [], '2026-11-03').some(i => i.id === item.id));
  dep.status = 'shipped';
  assert.ok(selectQueue(queue, [], '2026-11-03').some(i => i.id === item.id));
  assert.ok(!selectQueue(queue, [{ state: 'closed', body: `<!-- roadmap:${item.id} -->` }], '2026-11-03').some(i => i.id === item.id));
});
