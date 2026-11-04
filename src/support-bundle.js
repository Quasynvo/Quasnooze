/** Local-only, opt-in support artifact. Never imports config, stores or probes. */
import * as fs from 'node:fs';
import { release } from 'node:os';
import { createHash } from 'node:crypto';
import { READINESS } from './readiness.js';

export const SUPPORT_LIMITS = Object.freeze({ snapshotBytes: 64 * 1024, telemetryBytes: 1024 * 1024, recordBytes: 8192, records: 200, outputBytes: 16 * 1024, maximumTimingMs: 3_600_000 });
const STATES = new Set(Object.values(READINESS));
const INPUT_STATUSES = new Set(['not-supplied', 'complete', 'partial', 'oversized', 'unavailable', 'malformed']);
const PRIVACY = Object.freeze([
  'Only numeric versions, fixed platform/architecture and readiness enums, aggregate timings and bounded input counters are included.',
  'Prompts, responses, clipboard, audio, memory, profile, tokens, session IDs, model names, endpoints, raw paths, errors and source records are omitted.',
  'Allowlisting is not an anonymity guarantee: versions and timing aggregates can identify characteristics of a machine or workload. Review every field before sharing.',
  'Supplied snapshots may be stale, fabricated or incomplete; no readiness probe, network request, model or hardware check was performed.',
  'Telemetry aggregates describe only the bounded prefix supplied, not the full log or a controlled performance benchmark. Input files may contain personal data but no raw records are copied.',
  'No upload occurs. Saving locally is not permission to send the artifact to anyone. Existing personal export behavior is unchanged.',
]);
const state = value => STATES.has(value) ? value : 'unavailable';
const status = value => INPUT_STATUSES.has(value) ? value : 'unavailable';
const version = value => typeof value === 'string' ? /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})(?:[-+][0-9A-Za-z.-]{1,64})?$/.exec(value)?.[1] || null : null;
const numericRelease = value => typeof value === 'string' ? /^(\d{1,4}(?:\.\d{1,4}){0,3})(?:[^\d.]|$)/.exec(value)?.[1] || null : null;

function environmentFields(input) {
  return {
    appVersion: version(input.appVersion), nodeVersion: version(input.nodeVersion),
    os: ['linux', 'win32', 'darwin', 'freebsd', 'openbsd', 'aix', 'sunos', 'android'].includes(input.platform) ? input.platform : null,
    osVersion: numericRelease(input.osRelease),
    architecture: ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'].includes(input.arch) ? input.arch : null,
  };
}
function readinessFields(snapshot, inputStatus) {
  const ready = snapshot?.schema_version === 1 ? snapshot.readiness : undefined;
  return { inputStatus: status(inputStatus), source: ready && typeof ready === 'object' ? 'supplied-snapshot-unverified' : 'unavailable',
    state: state(ready?.state), text: state(ready?.surfaces?.text?.state), voice: state(ready?.surfaces?.voice?.state) };
}
const timing = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= SUPPORT_LIMITS.maximumTimingMs;
function aggregate(values) {
  if (!values.length) return { samples: 0, meanMs: null, p50Ms: null, p95Ms: null };
  values.sort((a, b) => a - b);
  const pct = p => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  return { samples: values.length, meanMs: Math.round(values.reduce((sum, n) => sum + n, 0) / values.length * 1000) / 1000, p50Ms: pct(0.5), p95Ms: pct(0.95) };
}

/** No raw row, arbitrary string or unknown key is returned. */
export function aggregateSupportTelemetry(buffer = Buffer.alloc(0), inputStatus = 'not-supplied') {
  if (!Buffer.isBuffer(buffer) || buffer.length > SUPPORT_LIMITS.telemetryBytes) throw new Error('Invalid bounded telemetry input');
  const text = buffer.toString('utf8'), durations = [], firstText = [];
  let cursor = 0, scanned = 0, malformed = 0, oversized = 0, ignored = 0, turns = 0, partialRecordDiscarded = false;
  while (cursor < text.length && scanned < SUPPORT_LIMITS.records) {
    const end = text.indexOf('\n', cursor), stop = end < 0 ? text.length : end;
    if (end < 0 && inputStatus === 'partial') { partialRecordDiscarded = true; break; }
    scanned++;
    // Buffer input is already byte-bounded; check each row before parsing it.
    const line = text.slice(cursor, stop); cursor = end < 0 ? text.length : end + 1;
    if (Buffer.byteLength(line) > SUPPORT_LIMITS.recordBytes) { oversized++; continue; }
    let row;
    try { row = JSON.parse(line); } catch { malformed++; continue; }
    if (!row || row.kind !== 'turn') { ignored++; continue; }
    turns++;
    if (timing(row.ms)) durations.push(row.ms);
    if (timing(row.firstTextMs)) firstText.push(row.firstTextMs);
  }
  return { inputStatus: status(inputStatus), bytesRead: buffer.length, scannedRecords: scanned, observedTurns: turns,
    malformedRecords: malformed, oversizedRecords: oversized, ignoredRecords: ignored,
    recordLimitReached: scanned >= SUPPORT_LIMITS.records && cursor < text.length, partialRecordDiscarded,
    duration: aggregate(durations), firstText: aggregate(firstText) };
}

/** File type/size and reads use one descriptor; no path check-then-open race. */
function readInput(path, kind, io) {
  if (!path) return { status: 'not-supplied', data: Buffer.alloc(0) };
  let fd;
  try {
    fd = io.openSync(path, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0) | (io.constants.O_NONBLOCK || 0));
    const before = io.fstatSync(fd), limit = kind === 'snapshot' ? SUPPORT_LIMITS.snapshotBytes : SUPPORT_LIMITS.telemetryBytes;
    if (!before.isFile()) return { status: 'unavailable', data: Buffer.alloc(0) };
    if (kind === 'snapshot' && before.size > limit) return { status: 'oversized', data: Buffer.alloc(0) };
    const buffer = Buffer.alloc(Math.min(before.size, limit) + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = io.readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = io.fstatSync(fd);
    const changed = before.size !== after.size || before.mtimeMs !== after.mtimeMs;
    if (kind === 'snapshot' && (changed || length > limit)) return { status: 'unavailable', data: Buffer.alloc(0) };
    return { status: changed || before.size > limit || length > limit || length < Math.min(before.size, limit) ? 'partial' : 'complete', data: buffer.subarray(0, Math.min(length, limit)) };
  } catch { return { status: 'unavailable', data: Buffer.alloc(0) }; }
  finally { if (fd !== undefined) io.closeSync(fd); }
}

export function prepareSupportBundle({ snapshotPath, telemetryPath, appVersion, environment = {
  appVersion, nodeVersion: process.versions.node, platform: process.platform, osRelease: release(), arch: process.arch,
}, io = fs } = {}) {
  const snapshotInput = readInput(snapshotPath, 'snapshot', io), telemetryInput = readInput(telemetryPath, 'telemetry', io);
  let snapshot;
  if (snapshotInput.status === 'complete') {
    try { snapshot = JSON.parse(snapshotInput.data.toString('utf8')); }
    catch { snapshotInput.status = 'malformed'; }
  }
  const bundle = { kind: 'quasnooze-local-support', schemaVersion: 1, localOnly: true,
    environment: environmentFields(environment), readiness: readinessFields(snapshot, snapshotInput.status),
    timings: aggregateSupportTelemetry(telemetryInput.data, telemetryInput.status),
    limits: { ...SUPPORT_LIMITS }, privacy: [...PRIVACY] };
  const text = JSON.stringify(bundle, null, 2) + '\n', bytes = Buffer.byteLength(text);
  if (bytes > SUPPORT_LIMITS.outputBytes) throw new Error('Support artifact exceeds output bound');
  return Object.freeze({ text, bytes, sha256: createHash('sha256').update(text).digest('hex') });
}

/** Save exactly the reviewed bytes, no overwrite, no implicit directories/upload.
 * A write failure may leave a partial new file: never delete an unrelated path
 * during rollback or report the partial file as a successful bundle.
 */
export function writeSupportBundle(preview, { destination, confirmation, io = fs } = {}) {
  if (!preview || typeof preview.text !== 'string' || Buffer.byteLength(preview.text) > SUPPORT_LIMITS.outputBytes ||
      confirmation !== preview.sha256 || createHash('sha256').update(preview.text).digest('hex') !== confirmation) throw new Error('Exact preview confirmation required');
  if (typeof destination !== 'string' || !destination.trim()) throw new Error('Choose a destination file');
  let fd;
  try {
    fd = io.openSync(destination, 'wx', 0o600);
    io.writeFileSync(fd, preview.text, 'utf8');
    io.fsyncSync(fd);
  } catch { throw new Error('Bundle was not saved successfully. Existing files are never overwritten; a newly created partial file may need inspection.'); }
  finally { if (fd !== undefined) io.closeSync(fd); }
  return { saved: true, bytes: Buffer.byteLength(preview.text), sha256: preview.sha256 };
}
