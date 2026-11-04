#!/usr/bin/env node
import { buildRetentionPlan, renderRetentionPlan, RETENTION_CATEGORIES } from '../src/retention-plan.js';

const args = process.argv.slice(2);
try {
  if (args.includes('--help')) {
    console.log('quasnooze retention-plan [--json] [--sessions-days N] [--memory-days N] [--reminders-days N] [--schedules-days N] [--telemetry-days N]\nRead-only metadata preview. All policies default off; no content reads, deletion, policy saving or scheduler. Shared record stores and active telemetry remain protected. See docs/RETENTION.md.');
  } else {
    const policies = {};
    let json = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--json') { json = true; continue; }
      const category = RETENTION_CATEGORIES.find(name => arg === `--${name}-days`);
      const days = args[++index];
      if (!category || !/^\d+$/.test(days || '')) throw new Error('Invalid retention option; use --help. No changes made.');
      policies[category] = Number(days);
    }
    // Use the same resolved config as runtime/setup, without importing store or
    // telemetry (whose loaders/recorders are unnecessary for a metadata preview).
    const { config } = await import('../src/config.js');
    const report = buildRetentionPlan({ dataDir: config.dataDir, policies });
    console.log(json ? JSON.stringify(report, null, 2) : renderRetentionPlan(report));
    if (['partial', 'unavailable'].includes(report.status)) process.exitCode = 1;
  }
} catch {
  console.error('Retention preview failed. Check options and local permissions; no changes made. See --help and docs/RETENTION.md.');
  process.exitCode = 1;
}
