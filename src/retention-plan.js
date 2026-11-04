/** Read-only file-metadata inventory, not a deletion plan or a record parser. */
import * as fs from 'node:fs';
import { resolve } from 'node:path';

export const RETENTION_CATEGORIES = Object.freeze(['sessions', 'memory', 'reminders', 'schedules', 'telemetry']);
const DAY = 86_400_000;
const LIMITATIONS = Object.freeze([
  'Counts are files, not messages, facts, reminders, schedules or telemetry records. No file contents are read.',
  'Sizes are logical file lengths, not allocated disk space or recoverable bytes; hard links may be counted more than once.',
  'Age uses file modification time, not record age, completion status, last access or legal retention requirements.',
  'Shared memory/reminder/schedule stores and active telemetry are excluded from candidates even when a policy is enabled.',
  'This is a bounded, non-atomic snapshot. Concurrent changes, inaccessible metadata and scan limits can make it incomplete.',
  'Unrecognized files, profiles, credentials, tasks, attachments, backups and external paths are outside this preview; they are not safe-to-delete claims.',
  'Safe descriptor traversal is required; Windows/unsupported platforms report unavailable, not a symlink-following fallback.',
  'No deletion, scheduler, policy persistence, network call or content read is performed. Directory access timestamps may be updated by the operating system.',
]);

export function retentionPolicies(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Policies must be a category-to-days object.');
  for (const key of Object.keys(input)) if (!RETENTION_CATEGORIES.includes(key)) throw new Error('Unknown retention policy category.');
  return Object.fromEntries(RETENTION_CATEGORIES.map(category => {
    const days = input[category] ?? null;
    if (days !== null && (!Number.isInteger(days) || days < 1 || days > 36500)) throw new Error('Policy days must be an integer from 1 to 36500, or null (off).');
    return [category, days];
  }));
}

/** Descriptor-anchored traversal prevents parent/path replacement from escaping
 * the selected root. Node has no portable openat: fail closed where this safe
 * mechanism is unavailable rather than fall back to symlink-following walks.
 * `io` and `now` are injectable for deterministic read-only/failure tests.
 */
export function buildRetentionPlan({ dataDir, policies = {}, now = () => Date.now(), maxEntries = 2000,
  maxDurationMs = 1000, clock = () => performance.now(), platform = process.platform, io = fs } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('A configured data directory is required.');
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000 || !Number.isFinite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 5000) throw new Error('Invalid scan bounds.');
  const policy = retentionPolicies(policies), at = Number(now());
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) throw new Error('Invalid preview clock.');
  const report = { schemaVersion: 1, readOnly: true, generatedAt: new Date(at).toISOString(), status: 'complete',
    bounds: { maxEntries, maxDurationMs }, scannedEntries: 0, truncated: false,
    categories: Object.fromEntries(RETENTION_CATEGORIES.map(category => [category, {
      policy: { enabled: policy[category] !== null, olderThanDays: policy[category] },
      observedFiles: 0, approximateBytes: 0, ageEligibleFiles: 0, candidateFiles: 0, candidateApproximateBytes: 0, exclusions: {},
    }])), exclusions: {}, limitations: [...LIMITATIONS] };
  const exclude = (reason, row = report) => { row.exclusions[reason] = (row.exclusions[reason] || 0) + 1; };
  const base = platform === 'linux' ? '/proc/self/fd' : platform === 'darwin' ? '/dev/fd' : null;
  if (!base || !io.constants.O_NOFOLLOW || !io.constants.O_DIRECTORY) {
    report.status = 'unavailable'; exclude('safe-descriptor-traversal-unavailable'); return report;
  }
  const started = clock();
  function bounded() {
    if (report.scannedEntries >= maxEntries || clock() - started >= maxDurationMs) {
      report.truncated = true; report.status = 'partial'; return false;
    }
    return true;
  }
  function measure(path, category, protectedReason) {
    const row = report.categories[category];
    let stat;
    try { stat = io.lstatSync(path); }
    catch { exclude('metadata-unavailable', row); report.status = 'partial'; return; }
    if (stat.isSymbolicLink()) { exclude('symbolic-link', row); return; }
    if (!stat.isFile()) { exclude('not-a-regular-file', row); return; }
    row.observedFiles++; row.approximateBytes += stat.size;
    const age = at - stat.mtimeMs;
    const enabled = row.policy.enabled;
    if (enabled && Number.isFinite(age) && age >= policy[category] * DAY) row.ageEligibleFiles++;
    if (protectedReason) { exclude(protectedReason, row); return; }
    if (!enabled) { exclude('policy-off', row); return; }
    if (!Number.isFinite(age) || age < 0) { exclude('unknown-or-future-modification-time', row); return; }
    if (age < policy[category] * DAY) { exclude('within-retention-window', row); return; }
    row.candidateFiles++; row.candidateApproximateBytes += stat.size;
  }
  function walk(fd, sessions = false) {
    let directory;
    try {
      // Only the OS-owned descriptor alias is followed, never a data symlink.
      directory = io.opendirSync(`${base}/${fd}`);
      while (bounded()) {
        const entry = directory.readSync();
        if (!entry) break;
        report.scannedEntries++;
        const path = `${base}/${fd}/${entry.name}`;
        if (sessions) {
          if (/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,99}\.json$/.test(entry.name)) measure(path, 'sessions');
          else exclude('unrecognized-session-entry');
        } else if (entry.name === 'sessions') {
          let child;
          try {
            child = io.openSync(path, io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);
            walk(child, true);
          } catch { exclude('session-directory-unavailable-or-link'); report.status = 'partial'; }
          finally { if (child !== undefined) io.closeSync(child); }
        } else if (['memory.json', 'reminders.json', 'schedules.json'].includes(entry.name)) {
          measure(path, entry.name.slice(0, -5), 'shared-record-store-protected');
        } else if (/^telemetry\.ndjson(?:\.[123])?$/.test(entry.name)) {
          measure(path, 'telemetry', entry.name === 'telemetry.ndjson' ? 'active-telemetry-protected' : undefined);
        } else exclude('outside-inventory');
      }
    } catch { exclude('directory-inventory-unavailable'); report.status = 'partial'; }
    finally { directory?.closeSync(); }
  }
  let root;
  try {
    root = io.openSync(resolve(dataDir), io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW);
    walk(root);
  } catch (error) {
    report.status = error.code === 'ENOENT' ? 'missing' : 'unavailable';
    exclude(error.code === 'ENOENT' ? 'data-root-missing' : 'data-root-unavailable-or-link');
  } finally { if (root !== undefined) io.closeSync(root); }
  return report;
}

export function renderRetentionPlan(report) {
  return [`Retention preview: ${report.status} (read-only; no deletion)`,
    `Scanned ${report.scannedEntries} entries; counts are files, not records.`,
    ...RETENTION_CATEGORIES.map(name => {
      const row = report.categories[name];
      return `${name}: ${row.observedFiles} file(s), ~${row.approximateBytes} bytes; policy ${row.policy.enabled ? `${row.policy.olderThanDays} days` : 'off'}; ${row.ageEligibleFiles} age-eligible; ${row.candidateFiles} candidate(s), ~${row.candidateApproximateBytes} bytes; exclusions ${JSON.stringify(row.exclusions)}`;
    }), `Other exclusions: ${JSON.stringify(report.exclusions)}`, ...report.limitations.map(line => `Note: ${line}`)].join('\n');
}
