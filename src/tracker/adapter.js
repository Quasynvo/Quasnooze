/**
 * tracker/adapter.js — the narrow interface a ticket tracker has to satisfy.
 *
 * Four operations, no more: `list`, `read`, `draft`, `describe`. Everything a
 * caller is allowed to know about a tracker is decided here, so the local
 * Markdown implementation and any future remote one cannot drift into
 * different behaviour or different validation.
 *
 * Two rules shape the whole module:
 *
 *   1. **Nothing from disk is trusted.** A ticket file is a file: its name,
 *      its metadata and its body all came from somewhere this process does not
 *      control. Every field is bounded, type-checked and refused rather than
 *      repaired, because a "repaired" ticket is a ticket whose contents are no
 *      longer what the human wrote.
 *   2. **A write needs a human, not a model.** `draft` will not create a file
 *      unless the caller hands it an approval that only the approval gate can
 *      mint (`assertWriteApproval`). A tool argument cannot forge it, because
 *      the token is an object identity minted in-process, not a boolean read
 *      out of the model's JSON.
 *
 * This module is deliberately dependency-free (node builtins only) so the
 * sandbox and the parsers can be unit-tested without booting the agent.
 */
import { homedir } from 'node:os';
import { join, isAbsolute, relative, resolve, sep } from 'node:path';

/* ───────────────────────────── bounds ──────────────────────────────────── */

/**
 * Every number here is a refusal point, not a suggestion. The ticket format is
 * human-authored Markdown, so these are generous for prose and tight for
 * anything a parser has to walk.
 */
export const TRACKER_LIMITS = Object.freeze({
  tickets: 500,          // files considered in one directory listing
  fileBytes: 256 * 1024, // one ticket file, read whole, never streamed
  bodyChars: 20_000,     // body text after front matter
  titleChars: 200,
  labelCount: 10,
  labelChars: 40,
  idChars: 64,
  summaryChars: 400,     // what a list row may show
  metaLines: 16,         // front-matter lines accepted
});

/** Ticket ids become filenames, so the alphabet is deliberately tiny. */
export const TICKET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/* ───────────────────────────── errors ──────────────────────────────────── */

/**
 * One error type with a stable `code`, so callers can distinguish "the owner
 * has not set this up" from "someone tried to escape the directory" without
 * matching on English.
 */
export class TrackerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
  }
}

export const TRACKER_CODES = Object.freeze({
  DISABLED: 'TRACKER_DISABLED',       // not enabled in configuration
  UNCONFIGURED: 'TRACKER_UNCONFIGURED', // enabled, but no repo selected yet
  NO_CONSENT: 'TRACKER_NO_CONSENT',   // owner consent missing for this change
  NO_APPROVAL: 'TRACKER_NO_APPROVAL', // a write without a human approval
  UNSAFE_PATH: 'TRACKER_UNSAFE_PATH', // traversal, symlink or absolute escape
  INVALID: 'TRACKER_INVALID',         // malformed ticket, ticket not written
  EXISTS: 'TRACKER_EXISTS',           // drafting never overwrites
});

/* ─────────────────────── text and metadata hygiene ─────────────────────── */

/** C0/C1 controls (except tab and newline) and bidi overrides change meaning. */
export function hasUnsafeChars(value) {
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (code === 9 || code === 10) continue;
    if (code < 32 || code === 127) return true;
    if (code >= 0x202a && code <= 0x202e) return true;
    if (code >= 0x2066 && code <= 0x2069) return true;
  }
  return false;
}

function requireString(value, field, max) {
  if (typeof value !== 'string') {
    throw new TrackerError(TRACKER_CODES.INVALID, `${field} must be text.`);
  }
  if (hasUnsafeChars(value)) {
    throw new TrackerError(TRACKER_CODES.INVALID, `${field} contains control or bidirectional characters.`);
  }
  if (value.length > max) {
    throw new TrackerError(TRACKER_CODES.INVALID, `${field} is longer than ${max} characters.`);
  }
  return value;
}

/**
 * A ticket id is a filename. `..`, a slash, a backslash, a leading dot or a
 * Windows device name would each turn one id into a different file, so the
 * pattern is checked before any path is built and never relaxed to "sanitise".
 */
export function assertTicketId(id) {
  const value = String(id ?? '');
  if (!TICKET_ID.test(value)) {
    throw new TrackerError(
      TRACKER_CODES.UNSAFE_PATH,
      `"${String(id).slice(0, 40)}" is not a ticket id. Use lowercase letters, digits and single dashes.`,
    );
  }
  return value;
}

/* ──────────────────────── the ticket contract ──────────────────────────── */

/**
 * Normalise a ticket draft into the one shape every adapter must accept and
 * return. Bounds are applied here so a local file and a remote API payload are
 * validated by the same code.
 */
export function normalizeTicket(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TrackerError(TRACKER_CODES.INVALID, 'A ticket must be an object.');
  }
  const title = requireString(input.title ?? '', 'title', TRACKER_LIMITS.titleChars).trim();
  if (!title) throw new TrackerError(TRACKER_CODES.INVALID, 'A ticket needs a title.');
  const body = requireString(input.body ?? '', 'body', TRACKER_LIMITS.bodyChars);
  const id = input.id === undefined || input.id === '' ? null : assertTicketId(input.id);

  const rawLabels = input.labels === undefined ? [] : input.labels;
  if (!Array.isArray(rawLabels) || rawLabels.length > TRACKER_LIMITS.labelCount) {
    throw new TrackerError(TRACKER_CODES.INVALID, `labels must be an array of at most ${TRACKER_LIMITS.labelCount} entries.`);
  }
  const labels = [];
  for (const label of rawLabels) {
    // A label is a word, not a sentence: commas separate front-matter values,
    // so a comma inside one would silently become two labels on the way back.
    const clean = requireString(label, 'a label', TRACKER_LIMITS.labelChars).trim();
    if (!clean) throw new TrackerError(TRACKER_CODES.INVALID, 'a label cannot be empty.');
    if (/[,\r\n]/.test(clean)) {
      throw new TrackerError(TRACKER_CODES.INVALID, 'a label cannot contain a comma or a line break.');
    }
    if (!labels.includes(clean)) labels.push(clean);
  }
  return Object.freeze({ id, title, labels: Object.freeze(labels), body });
}

/**
 * The one-line description shown in an approval prompt. Deliberately short:
 * the exact bytes live in the preview, not in the question.
 */
export function describeDraft(ticket) {
  const t = normalizeTicket(ticket);
  const labels = t.labels.length ? `  [${t.labels.join(', ')}]` : '';
  return `draft ticket "${t.title}"${labels} (${Buffer.byteLength(t.body, 'utf8')} byte body)`;
}

/** Deterministic serialisation: the same draft always produces the same bytes. */
export function renderTicketMarkdown(ticket, { created } = {}) {
  const t = normalizeTicket(ticket);
  const stamp = typeof created === 'string' && !Number.isNaN(Date.parse(created))
    ? new Date(created).toISOString()
    : new Date().toISOString();
  const lines = ['---', `title: ${t.title}`, `created: ${stamp}`];
  if (t.labels.length) lines.push(`labels: ${t.labels.join(', ')}`);
  lines.push('---', '');
  return `${lines.join('\n')}\n${t.body}\n`;
}

/**
 * Parse the bounded front matter subset this format allows.
 *
 * The grammar is intentionally not YAML: `key: value`, one line, fixed keys.
 * A general YAML parser is a large attack surface for a file whose only job is
 * to say "title" and "labels", and nesting or anchors would let a ticket file
 * describe a structure the renderer never promised to handle.
 */
export function parseTicketMarkdown(text) {
  if (typeof text !== 'string') {
    throw new TrackerError(TRACKER_CODES.INVALID, 'A ticket file must be UTF-8 text.');
  }
  const lines = text.split('\n');
  if (lines[0] !== '---') {
    throw new TrackerError(TRACKER_CODES.INVALID, 'A ticket must start with a "---" front-matter line.');
  }
  const meta = {};
  let index = 1;
  let closed = false;
  for (; index < lines.length && index <= TRACKER_LIMITS.metaLines; index++) {
    const line = lines[index];
    if (line === '---') { closed = true; index++; break; }
    if (!line.trim()) continue;
    const at = line.indexOf(':');
    if (at <= 0) {
      throw new TrackerError(TRACKER_CODES.INVALID, `front-matter line ${index + 1} is not "key: value".`);
    }
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (!['title', 'created', 'labels'].includes(key)) {
      throw new TrackerError(TRACKER_CODES.INVALID, `unknown front-matter key "${key.slice(0, 32)}".`);
    }
    if (key in meta) {
      throw new TrackerError(TRACKER_CODES.INVALID, `front-matter key "${key}" appears twice.`);
    }
    meta[key] = value;
  }
  if (!closed) {
    throw new TrackerError(TRACKER_CODES.INVALID, 'front matter is not closed before the metadata limit.');
  }
  const body = lines.slice(index).join('\n').replace(/^\n+/, '');
  if (body.length > TRACKER_LIMITS.bodyChars) {
    throw new TrackerError(TRACKER_CODES.INVALID, `body is longer than ${TRACKER_LIMITS.bodyChars} characters.`);
  }
  if (hasUnsafeChars(body)) {
    throw new TrackerError(TRACKER_CODES.INVALID, 'body contains control or bidirectional characters.');
  }
  const labels = meta.labels === undefined || meta.labels === ''
    ? []
    : meta.labels.split(',').map((s) => s.trim()).filter(Boolean);
  return normalizeTicket({ title: meta.title ?? '', labels, body });
}

/** A list row: bounded, and never the whole body. */
export function summarizeTicket(ticket, { source } = {}) {
  const t = normalizeTicket(ticket);
  const body = t.body.replace(/\s+/g, ' ').trim();
  return Object.freeze({
    id: t.id,
    title: t.title,
    labels: t.labels,
    summary: body.slice(0, TRACKER_LIMITS.summaryChars),
    truncated: body.length > TRACKER_LIMITS.summaryChars,
    ...(source ? { source } : {}),
  });
}

/* ───────────────────────────── approvals ───────────────────────────────── */

const minted = new WeakSet();

/**
 * Mint a write approval.
 *
 * Called only by the code path that has just put a prompt in front of a human
 * and received a yes. The returned object is the capability: an adapter checks
 * its identity, so a model cannot approve its own write by setting
 * `approved: true` in tool arguments — arguments are JSON, and JSON cannot
 * carry object identity.
 */
export function mintWriteApproval({ tool, sessionId, turnId } = {}) {
  const token = Object.freeze({
    kind: 'tracker-write-approval',
    tool: String(tool ?? ''),
    sessionId: String(sessionId ?? ''),
    turnId: String(turnId ?? ''),
    at: new Date().toISOString(),
  });
  minted.add(token);
  return token;
}

/** Throws unless `token` came from `mintWriteApproval` and matches the tool. */
export function assertWriteApproval(token, tool) {
  if (!token || typeof token !== 'object' || !minted.has(token)) {
    throw new TrackerError(
      TRACKER_CODES.NO_APPROVAL,
      'Writing a ticket needs an explicit approval from the owner. Nothing was written.',
    );
  }
  if (tool && token.tool !== tool) {
    throw new TrackerError(
      TRACKER_CODES.NO_APPROVAL,
      `That approval was granted for "${token.tool}", not "${tool}". Nothing was written.`,
    );
  }
  return token;
}

/* ────────────────────────────── the adapter ────────────────────────────── */

/**
 * Validate an adapter's shape once, at construction, so a missing method is a
 * startup error instead of a surprise at the first write.
 */
export function defineAdapter(spec = {}) {
  if (!spec || typeof spec !== 'object') {
    throw new TrackerError(TRACKER_CODES.INVALID, 'An adapter must be an object.');
  }
  const kind = requireString(spec.kind ?? '', 'adapter kind', 40).trim();
  if (!kind) throw new TrackerError(TRACKER_CODES.INVALID, 'An adapter needs a kind.');
  for (const method of ['list', 'read', 'draft']) {
    if (typeof spec[method] !== 'function') {
      throw new TrackerError(TRACKER_CODES.INVALID, `adapter "${kind}" is missing ${method}().`);
    }
  }
  return Object.freeze({
    kind,
    describe: typeof spec.describe === 'function' ? spec.describe : () => `${kind} tracker`,
    list: spec.list,
    read: spec.read,
    draft: spec.draft,
  });
}

/* ───────────────────────── path safety for the root ────────────────────── */

/**
 * Credential stores are refused as tracker roots even when they are inside the
 * owner's own home directory — the same judgement `tools.js` makes for the
 * workspace, applied to the one directory this feature writes into. Kept as a
 * separate list on purpose: `test/tracker-local.test.js` asserts the two lists
 * agree, so drift between them fails a test instead of opening a door.
 */
export const PROTECTED_TRACKER_ROOTS = Object.freeze([
  '.ssh', '.aws', '.gnupg', '.kube', '.netrc', '.git-credentials',
  '.npmrc', '.pypirc', '.config/gh', '.config/gcloud', '.config/pip',
  '.docker/config.json', '.azure', 'Library/Keychains',
].map((p) => join(homedir(), p)));

export function isProtectedTrackerRoot(target) {
  const value = String(target);
  return PROTECTED_TRACKER_ROOTS.some(
    (p) => value === p || value.startsWith(p + sep) || value.startsWith(p + '/'),
  );
}

/**
 * Refuse a root that is not an absolute path, is a credential store, or is the
 * filesystem root itself. `canonical` must already be a real path (no symlink
 * left to resolve) — callers resolve first, then ask.
 */
export function assertTrackerRoot(canonical) {
  const value = String(canonical ?? '');
  if (!isAbsolute(value)) {
    throw new TrackerError(TRACKER_CODES.UNSAFE_PATH, 'The tracker directory must be an absolute path.');
  }
  if (value === resolve('/')) {
    throw new TrackerError(TRACKER_CODES.UNSAFE_PATH, 'The filesystem root cannot be a tracker directory.');
  }
  if (isProtectedTrackerRoot(value)) {
    throw new TrackerError(
      TRACKER_CODES.UNSAFE_PATH,
      `${value} is a credential store, not a tracker directory.`,
    );
  }
  return value;
}

/** True when `target` is `root` or inside it. Lexical; canonicalise first. */
export function isInside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
