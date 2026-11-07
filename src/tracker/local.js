/**
 * tracker/local.js — the first adapter: Markdown tickets in one directory.
 *
 * This is the reference implementation of `adapter.js`, and it is where the
 * security properties are actually enforced against a real filesystem:
 *
 *   • **One canonical root, resolved once.** The root is realpath'd at
 *     construction. Every read and write then canonicalises the *parent*
 *     directory and the target, so a symlink planted inside the directory after
 *     setup cannot redirect a write to /etc.
 *   • **No traversal, ever.** Ids are validated against `TICKET_ID` before a
 *     path exists, and the assembled path is additionally required to be
 *     inside the root. Two independent checks, because a single one is a
 *     single bug away from an escape.
 *   • **DT_REG only.** Listing uses `withFileTypes` and ignores anything that
 *     is not a regular file — a symlink to `~/.ssh/id_rsa` named `good.md`
 *     never appears as a ticket.
 *   • **Bounded reads.** A file is refused, not truncated, when it is larger
 *     than the limit: half a ticket looks like a whole one.
 *   • **Never overwrites.** `draft` uses an exclusive create (`wx`), so the
 *     "does it exist?" check and the write cannot be split by another process.
 *
 * No network, no child process, no git. A ticket directory is a directory.
 */
import {
  closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import {
  TRACKER_CODES, TRACKER_LIMITS, TrackerError, assertTicketId, assertTrackerRoot,
  assertWriteApproval, defineAdapter, isInside, normalizeTicket, parseTicketMarkdown,
  renderTicketMarkdown, summarizeTicket,
} from './adapter.js';

const TICKET_SUFFIX = '.md';
const TICKET_FILE = /^[a-z0-9][a-z0-9-]{0,63}\.md$/;

/**
 * Resolve the root: realpath must succeed, and the result must be a directory.
 * Refusing here means no later call has to guess whether the root is real.
 */
function canonicalRoot(rootDir) {
  const requested = String(rootDir ?? '');
  if (!requested) {
    throw new TrackerError(TRACKER_CODES.UNCONFIGURED, 'No tracker directory is configured for this repository.');
  }
  const absolute = assertTrackerRoot(isAbsolutePath(requested) ? requested : resolve(requested));
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    throw new TrackerError(
      TRACKER_CODES.UNCONFIGURED,
      `The tracker directory does not exist: ${absolute}. Create it, then run setup again.`,
    );
  }
  let stats;
  try {
    stats = lstatSync(real);
  } catch {
    throw new TrackerError(TRACKER_CODES.UNCONFIGURED, `The tracker directory is not readable: ${real}.`);
  }
  if (!stats.isDirectory()) {
    throw new TrackerError(TRACKER_CODES.UNCONFIGURED, `The tracker directory is not a directory: ${real}.`);
  }
  // The canonical path is what every later check compares against.
  return real;
}

function isAbsolutePath(value) {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/** A path for one ticket id, proven to sit inside `root`. */
function ticketPath(root, id) {
  const safeId = assertTicketId(id);
  const target = join(root, safeId + TICKET_SUFFIX);
  if (!isInside(root, target) || !target.startsWith(root + sep)) {
    throw new TrackerError(TRACKER_CODES.UNSAFE_PATH, 'That ticket path is outside the tracker directory.');
  }
  // The root must still be the same real directory, and still a directory:
  // this catches a tracker directory that was replaced by a symlink or a file
  // between setup and this call.
  let stats;
  try {
    stats = lstatSync(root);
  } catch {
    throw new TrackerError(TRACKER_CODES.UNCONFIGURED, 'The tracker directory has gone away.');
  }
  if (!stats.isDirectory()) {
    throw new TrackerError(TRACKER_CODES.UNSAFE_PATH, 'The tracker directory is no longer a directory; refusing to continue.');
  }
  return target;
}

/**
 * Read at most `limit` bytes, refusing larger files outright.
 *
 * `readFileSync` would either truncate silently or allocate whatever the file
 * claims to be; opening, stat-ing the descriptor and reading a bounded amount
 * means a 4 GB "ticket" costs one lstat and one error message.
 */
function readBoundedSync(path, limit) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return null;
  }
  // A symlink here is a redirect, not a ticket. Refuse rather than follow.
  if (stats.isSymbolicLink()) {
    throw new TrackerError(TRACKER_CODES.UNSAFE_PATH, `${path} is a symlink; tickets must be regular files.`);
  }
  if (!stats.isFile()) {
    throw new TrackerError(TRACKER_CODES.INVALID, `${path} is not a regular file.`);
  }
  if (stats.size > limit) {
    throw new TrackerError(
      TRACKER_CODES.INVALID,
      `${path} is ${stats.size} bytes, over the ${limit}-byte ticket limit; refusing to read part of it.`,
    );
  }
  const fd = openSync(path, 'r');
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > limit) {
      throw new TrackerError(TRACKER_CODES.UNSAFE_PATH, `${path} changed while it was being read.`);
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Build a local Markdown adapter for one repository.
 *
 * `rootDir` is the owner-chosen directory, already recorded in configuration.
 * Nothing here reads or writes configuration: an adapter is told where to look
 * and cannot move its own root.
 */
export function createLocalAdapter(rootDir, { kind = 'local-markdown' } = {}) {
  const root = canonicalRoot(rootDir);

  async function list() {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      throw new TrackerError(TRACKER_CODES.UNCONFIGURED, `The tracker directory is not readable: ${root}.`);
    }
    // withFileTypes reports the link itself, not its target, so a symlink is
    // excluded here rather than followed later.
    const names = entries
      .filter((entry) => entry.isFile() && TICKET_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const rows = [];
    for (const name of names.slice(0, TRACKER_LIMITS.tickets)) {
      const id = name.slice(0, -TICKET_SUFFIX.length);
      let text;
      try {
        text = readBoundedSync(join(root, name), TRACKER_LIMITS.fileBytes);
      } catch {
        // One malformed ticket must not hide the rest of the board. It is
        // reported as a row the owner can see and fix, never as an omission.
        rows.push(Object.freeze({
          id, title: `[unreadable] ${name}`, labels: Object.freeze([]),
          summary: 'This file is not a valid ticket. Fix it or move it out of the tracker directory.',
          truncated: false, invalid: true,
        }));
        continue;
      }
      if (text === null) continue;
      try {
        const ticket = { ...parseTicketMarkdown(text), id };
        rows.push(summarizeTicket(ticket));
      } catch (error) {
        rows.push(Object.freeze({
          id, title: `[invalid] ${name}`, labels: Object.freeze([]),
          summary: error?.message || 'This file is not a valid ticket.',
          truncated: false, invalid: true,
        }));
      }
    }
    return Object.freeze({
      tickets: Object.freeze(rows),
      total: rows.length,
      truncated: names.length > TRACKER_LIMITS.tickets,
      root,
    });
  }

  async function read(id) {
    const path = ticketPath(root, id);
    const text = readBoundedSync(path, TRACKER_LIMITS.fileBytes);
    if (text === null) {
      throw new TrackerError(TRACKER_CODES.INVALID, `No ticket "${String(id).slice(0, 64)}" in this tracker.`);
    }
    const ticket = parseTicketMarkdown(text);
    return Object.freeze({ ...ticket, id });
  }

  /**
   * Write a new ticket. `approval` must come from `mintWriteApproval`; it is
   * checked before the filesystem is touched, so a refusal writes nothing.
   */
  async function draft(input, { approval } = {}) {
    assertWriteApproval(approval, 'tracker_draft_ticket');
    const ticket = normalizeTicket(input);
    const id = ticket.id ?? slugFromTitle(ticket.title);
    const path = ticketPath(root, id);
    const markdown = renderTicketMarkdown({ ...ticket, id });
    try {
      // wx: create or fail. There is no window in which an existing ticket
      // could be replaced by a draft that looks similar.
      writeFileSync(path, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new TrackerError(
          TRACKER_CODES.EXISTS,
          `A ticket with id "${id}" already exists. Drafting never overwrites; choose another id.`,
        );
      }
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        throw new TrackerError(TRACKER_CODES.UNCONFIGURED, `No permission to write in ${root}.`);
      }
      throw error;
    }
    return Object.freeze({ id, path, bytes: Buffer.byteLength(markdown, 'utf8'), ticket: { ...ticket, id } });
  }

  return defineAdapter({
    kind,
    describe: () => `local Markdown tickets in ${root}`,
    list,
    read,
    draft,
    root,
  });
}

/**
 * Deterministic id from a title: lowercase ASCII words joined by single dashes,
 * capped well below the id limit so a suffix always fits. Non-Latin titles
 * yield an empty slug and the caller must supply an id — inventing one from
 * transliteration would produce ids the owner cannot predict.
 */
export function slugFromTitle(title, { max = 48 } = {}) {
  const slug = String(title ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return slug;
}
