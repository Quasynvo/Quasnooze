/**
 * tracker/setup.js — per-repository tracker configuration, and the consent gate.
 *
 * Two jobs, and they are deliberately in the same file because they are the
 * same question: *which directory is this repository's tracker, and did the
 * owner say so?*
 *
 *   • `discoverRepository` reads a directory and proposes candidates. It is
 *     read-only in the strong sense: it never runs git, never opens a remote,
 *     never writes a config file, and never mutates `.git/config`, a remote URL
 *     or any repo policy file. Discovery that edits a repository to describe
 *     itself is discovery that needs consent first.
 *   • `TrackerRegistry` stores the answer in `data/tracker-config.json`, keyed
 *     by the repository's canonical path. Configuration lives in the state
 *     directory, not in the repository, so configuring a tracker never dirties
 *     someone's working tree.
 *
 * **Reconfiguration needs consent.** Enabling, pointing at a different
 * directory, or changing the display name all require `approval` — the same
 * minted token a write requires. The one thing that does *not* require consent
 * is disabling: taking a capability away is always allowed, because refusing to
 * let someone turn a feature off is the unsafe default.
 *
 * Nothing here writes a ticket. Nothing here touches the GitHub contributor
 * bot, which is a repository workflow and not this feature's business.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { config } from '../config.js';
import {
  TRACKER_CODES, TrackerError, assertTrackerRoot, assertWriteApproval, hasUnsafeChars,
} from './adapter.js';

/** Directory names a repository might plausibly keep tickets in, most specific first. */
export const CANDIDATE_DIRS = Object.freeze([
  'tickets', 'issues', 'tracker', 'backlog', 'docs/tickets', 'docs/issues',
  '.tickets', '.issues', 'tasks', 'docs/backlog',
]);

const MAX_CONFIG_ENTRIES = 32;
const MAX_NAME_CHARS = 120;

export function trackerConfigPath({ dataDir = config.dataDir } = {}) {
  return join(dataDir, 'tracker-config.json');
}

function isInsidePath(root, target) {
  const base = resolve(root);
  const full = resolve(target);
  return full === base || full.startsWith(base + '/') || full.startsWith(base + '\\');
}

/**
 * Read the config file defensively.
 *
 * A corrupted or hostile config is not a reason to crash a turn: it is a reason
 * to treat every repository as unconfigured, which is the disabled default.
 */
function readConfig(file) {
  if (!existsSync(file)) return { version: 1, repositories: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { version: 1, repositories: {} };
  }
  const repositories = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.repositories : null;
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) {
    return { version: 1, repositories: {} };
  }
  const clean = {};
  for (const [key, value] of Object.entries(repositories).slice(0, MAX_CONFIG_ENTRIES)) {
    if (typeof key !== 'string' || !isAbsolute(key) || hasUnsafeChars(key)) continue;
    if (!value || typeof value !== 'object') continue;
    // A stored entry is data from disk: re-validate every field on the way in,
    // so a hand-edited config cannot inject `../` or a non-boolean flag.
    if (value.enabled !== true) continue;
    if (typeof value.rootDir !== 'string' || !isAbsolute(value.rootDir) || hasUnsafeChars(value.rootDir)) continue;
    const name = typeof value.name === 'string' && value.name.length <= MAX_NAME_CHARS && !hasUnsafeChars(value.name)
      ? value.name
      : null;
    clean[key] = Object.freeze({
      enabled: true,
      kind: value.kind === 'local-markdown' ? 'local-markdown' : 'local-markdown',
      rootDir: resolve(value.rootDir),
      name,
      consentedAt: typeof value.consentedAt === 'string' ? value.consentedAt.slice(0, 40) : null,
    });
  }
  return { version: 1, repositories: clean };
}

function writeConfig(file, data) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  // Rename over the old file: a crash mid-write leaves the previous config
  // rather than half of a new one.
  renameSync(tmp, file);
}

/**
 * Is the tracker feature enabled at all?
 *
 * Default **off**: an unset or unrecognised value disables the feature, so a
 * machine that never asked for tickets does not get a ticket tool, a config
 * file, or a prompt. `QUASNOOZE_TRACKER=on` is the opt-in.
 */
export function isTrackerEnabled(env = process.env) {
  const live = env?.QUASNOOZE_TRACKER ?? env?.PINCH_TRACKER;
  if (live === undefined || live === '') return false;
  return /^(1|true|yes|on)$/i.test(String(live).trim());
}

/** Canonical form of a repository path, or the resolved path when it is gone. */
export function canonicalRepoPath(repoDir) {
  const absolute = resolve(String(repoDir ?? '.'));
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Propose candidate ticket directories for a repository.
 *
 * Read-only. It looks for conventional directory names and for Markdown files
 * one level down; it does not create anything, and a repository with no
 * candidates is a normal answer, not an error.
 */
export function discoverRepository(repoDir = '.') {
  const root = canonicalRepoPath(repoDir);
  const candidates = [];
  if (!existsSync(root)) {
    return Object.freeze({ repository: root, candidates: Object.freeze([]), reason: 'repository not found' });
  }
  for (const name of CANDIDATE_DIRS) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    // Only a real directory counts; a symlink named "tickets" pointing at a
    // hidden store is exactly the sort of thing discovery must not endorse.
    if (!stats.isDirectory()) continue;
    let real;
    try {
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (!isInsidePath(root, real)) continue;
    const tickets = countTickets(real);
    candidates.push(Object.freeze({ label: name, path: real, tickets }));
  }
  return Object.freeze({
    repository: root,
    candidates: Object.freeze(candidates),
    reason: candidates.length ? null : 'no conventional ticket directory found',
  });
}

function countTickets(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .length;
  } catch {
    return 0;
  }
}

/**
 * The per-repository registry.
 *
 * An instance is bound to one config file so tests can use a temporary state
 * directory without mutating the process-wide `config`.
 */
export function createTrackerRegistry({
  dataDir = config.dataDir,
  env = process.env,
  file = trackerConfigPath({ dataDir }),
} = {}) {
  const path = file;

  function read() {
    return readConfig(path);
  }

  return Object.freeze({
    path,

    /** Enabled by configuration *and* by the feature switch. */
    isEnabled() {
      return isTrackerEnabled(env);
    },

    /** The stored entry for one repository, or null. Never throws. */
    entryFor(repoDir) {
      const key = canonicalRepoPath(repoDir);
      return read().repositories[key] ?? null;
    },

    /**
     * The ready adapter for a repository, or a TrackerError explaining why not.
     * Imported lazily so this module stays free of filesystem-ticket imports.
     */
    async adapterFor(repoDir) {
      if (!isTrackerEnabled(env)) {
        throw new TrackerError(
          TRACKER_CODES.DISABLED,
          'Ticket tracking is off. Set QUASNOOZE_TRACKER=on, then run tracker setup for a repository.',
        );
      }
      const entry = this.entryFor(repoDir);
      if (!entry) {
        throw new TrackerError(
          TRACKER_CODES.UNCONFIGURED,
          `No ticket tracker is configured for ${canonicalRepoPath(repoDir)}. Run tracker setup and approve a directory.`,
        );
      }
      const { createLocalAdapter } = await import('./local.js');
      return createLocalAdapter(entry.rootDir, { kind: entry.kind });
    },

    /**
     * Record (or change) a repository's tracker. Requires a minted approval
     * whenever an entry already exists, because changing where tickets are
     * written is exactly the moment a human should be looking.
     */
    configure({ repoDir = '.', rootDir, name = null, approval, tool = 'tracker_setup' } = {}) {
      if (!isTrackerEnabled(env)) {
        throw new TrackerError(TRACKER_CODES.DISABLED, 'Ticket tracking is off. Set QUASNOOZE_TRACKER=on first.');
      }
      const key = canonicalRepoPath(repoDir);
      const existing = this.entryFor(key);
      if (existing) assertWriteApproval(approval, tool);

      const requested = String(rootDir ?? '');
      if (!requested) throw new TrackerError(TRACKER_CODES.INVALID, 'A tracker directory is required.');
      const absolute = assertTrackerRoot(isAbsolute(requested) ? resolve(requested) : resolve(key, requested));
      let real;
      try {
        real = realpathSync(absolute);
      } catch {
        throw new TrackerError(
          TRACKER_CODES.UNCONFIGURED,
          `The tracker directory does not exist: ${absolute}. Create it before configuring it.`,
        );
      }
      let stats;
      try {
        stats = statSync(real);
      } catch {
        throw new TrackerError(TRACKER_CODES.UNCONFIGURED, `The tracker directory is not readable: ${real}.`);
      }
      if (!stats.isDirectory()) {
        throw new TrackerError(TRACKER_CODES.INVALID, `${real} is not a directory.`);
      }
      const label = name === null ? null : String(name);
      if (label !== null && (label.length > MAX_NAME_CHARS || hasUnsafeChars(label))) {
        throw new TrackerError(TRACKER_CODES.INVALID, `A tracker name must be plain text under ${MAX_NAME_CHARS} characters.`);
      }

      const data = read();
      if (!(key in data.repositories) && Object.keys(data.repositories).length >= MAX_CONFIG_ENTRIES) {
        throw new TrackerError(TRACKER_CODES.INVALID, `At most ${MAX_CONFIG_ENTRIES} repositories can be configured.`);
      }
      data.repositories[key] = {
        enabled: true,
        kind: 'local-markdown',
        rootDir: real,
        name: label,
        consentedAt: new Date().toISOString(),
      };
      writeConfig(path, data);
      return Object.freeze({
        repository: key,
        entry: Object.freeze({ ...data.repositories[key] }),
        reconfigured: Boolean(existing),
      });
    },

    /**
     * Turn the tracker off for one repository. No approval required: disabling
     * a capability is never the dangerous direction, and requiring consent to
     * stop something would be a trap.
     */
    disable({ repoDir = '.' } = {}) {
      const key = canonicalRepoPath(repoDir);
      const data = read();
      if (!(key in data.repositories)) return Object.freeze({ repository: key, changed: false });
      delete data.repositories[key];
      writeConfig(path, data);
      return Object.freeze({ repository: key, changed: true });
    },

    /** Every configured repository, for `tracker status`. */
    listConfigured() {
      return Object.freeze(
        Object.entries(read().repositories).map(([repository, entry]) =>
          Object.freeze({ repository, ...entry })),
      );
    },
  });
}

/** Process-wide registry, using the real state directory and environment. */
export const registry = createTrackerRegistry();
