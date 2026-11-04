#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { resolveStatePaths } from '../src/state-paths.js';
import { previewMigration, migrateState } from '../src/state-migration.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  const { stateHome } = resolveStatePaths({ root, clone: false });
  const plan = previewMigration(root, stateHome);
  console.log(`Offline migration preview (stop all running instances first):\nSource: ${plan.source}\nDestination: ${plan.target}\nCopy: ${plan.entries.join(', ')}\nOriginals will be preserved. No contents or secrets are printed.`);
  if (process.argv.includes('--apply')) {
    if (!process.stdin.isTTY) throw new Error('Interactive confirmation required; run without --apply for preview');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try { answer = await rl.question('Confirm all instances are stopped. Type COPY to proceed: '); }
    finally { rl.close(); }
    if (answer !== 'COPY') throw new Error('Migration cancelled');
    migrateState(root, stateHome, { confirmed: true });
    console.log('Copy complete. Originals retained. For a checkout, set QUASNOOZE_STATE_HOME to the destination before restarting.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
