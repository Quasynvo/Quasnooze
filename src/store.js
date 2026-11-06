/**
 * store.js — Quasnooze's memory, on disk, in plain JSON.
 *
 * No database, no cloud, no telemetry: data/ is yours. Files are
 * written atomically (tmp + fsync + rename) so a crash mid-write cannot
 * corrupt your conversation history.
 *
 * Reads are cached in-process. A turn used to read and re-parse the session and
 * the memory file four times, synchronously, on the main thread — measured at
 * ~2 ms per turn on an SSD and 20-100 ms on a Pi's SD card, blocking the SSE
 * stream and every other channel while it happened. The cache removes those
 * re-reads; writes are still synchronous and still atomic, because a debounced
 * write trades durability for a millisecond and this is someone's chat history.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, unlinkSync, openSync, fsyncSync, closeSync, lstatSync, realpathSync, fstatSync, readSync, copyFileSync, chmodSync, constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { MEMORY_VERSION, memoryScope, migrateMemory, validFact, createFact } from "./memory/provenance.js";

const DATA = config.dataDir;

export function ensureData() {
  mkdirSync(DATA, { recursive: true, mode: 0o700 });
  mkdirSync(join(DATA, "sessions"), { recursive: true, mode: 0o700 });
}

/**
 * The single choke point where anything reaches disk.
 *
 * Everything written here ultimately came off a socket (a chat message, a
 * memory fact, a reminder), so this is the one function worth being paranoid
 * in: the destination must resolve inside data/, and the payload must be JSON
 * that parses back. A caller that gets either wrong fails here, loudly, instead
 * of writing something unexpected somewhere unexpected.
 */
function atomicWrite(path, text) {
  const target = resolve(String(path));
  if (!isInside(resolve(DATA), target)) {
    throw new Error(`refusing to write outside the data directory: ${target}`);
  }
  if (typeof text !== "string") throw new TypeError("atomicWrite expects a string");

  // Round-trip the payload when it claims to be JSON. Cheap, and it means a
  // half-serialised object can never reach disk.
  if (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) {
    JSON.parse(text);
  }

  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  // Without the fsync, a power cut between write and rename can leave a
  // zero-length file where a conversation used to be: the rename is durable,
  // the data behind it is not.
  try {
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* some filesystems refuse to fsync; the rename is still atomic */
  }
  renameSync(tmp, target);
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Parsed-file cache, keyed by absolute path.
 *
 * Every entry is handed out as a deep copy, so a caller that mutates what it
 * read cannot corrupt the cache for the next caller — the same guarantee the
 * old read-every-time behaviour gave for free.
 */
const cache = new Map();

function readCached(path, fallback) {
  if (cache.has(path)) return structuredClone(cache.get(path));
  const parsed = readJson(path, fallback);
  cache.set(path, parsed);
  return structuredClone(parsed);
}

/** Called by every writer so the next reader sees what was just written. */
function writeCached(path, value, text) {
  atomicWrite(path, text);
  cache.set(path, value);
}

export function invalidate(path) {
  if (path) cache.delete(path);
  else cache.clear();
}

/* ───────────────────────────── memory (facts) ──────────────────────────── */

const MEMORY_FILE = join(DATA, "memory.json");

// Read without silently overwriting corrupt or future-version state. Invalid
// individual records are retained on disk but excluded from recall.
function memoryState() {
  const raw = readCached(MEMORY_FILE, null);
  if (raw === null && !existsSync(MEMORY_FILE)) return { version: MEMORY_VERSION, facts: [], profile: {}, updatedAt: null };
  return migrateMemory(raw);
}
function writeMemory(state) {
  // Back up the exact original once, before the first legacy migration. Never
  // overwrite an existing backup: it may be the owner's only rollback copy.
  if (existsSync(MEMORY_FILE)) {
    const original = readCached(MEMORY_FILE, null);
    if (original && original.version !== MEMORY_VERSION) {
      const backup = MEMORY_FILE + '.v1.bak';
      try { copyFileSync(MEMORY_FILE, backup, constants.COPYFILE_EXCL); chmodSync(backup, 0o600); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
  }
  state.version = MEMORY_VERSION;
  state.updatedAt = new Date().toISOString();
  writeCached(MEMORY_FILE, state, JSON.stringify(state, null, 2));
  return state;
}
/** Scope comes from trusted local configuration or an owner-only caller. */
export function loadMemory({ scope = config.memoryScope } = {}) {
  const selected = memoryScope(scope);
  let state;
  try { state = memoryState(); }
  catch { return { facts: [], profile: {}, updatedAt: null, warning: "memory.json is malformed or unsupported; it was not changed." }; }
  return { ...state, facts: state.facts.filter(f => validFact(f) && f.scope === selected && !f.supersededBy), profile: state.profile || {}, updatedAt: state.updatedAt || null };
}
/** Full owner export, including other scopes and correction history. */
export function exportMemory() { return memoryState(); }

// Existing profile updates must not replace hidden scopes or correction history.
export function saveMemory(memory) {
  const state = memoryState();
  state.profile = memory.profile || {};
  writeMemory(state);
  return loadMemory();
}

export function remember(text, tag = "general", { scope = config.memoryScope, source } = {}) {
  const selected = memoryScope(scope);
  const state = memoryState();
  const clean = String(text || "").trim().slice(0, 500);
  if (!clean) return loadMemory({ scope: selected });
  if (!state.facts.some(f => validFact(f) && f.scope === selected && !f.supersededBy && f.text.toLowerCase() === clean.toLowerCase())) {
    state.facts.push(createFact(clean, tag, selected, source));
    writeMemory(state);
  }
  return loadMemory({ scope: selected });
}

/** Replace one active fact, keeping its provenance and linking its history. */
export function correctMemory(id, text, { scope = config.memoryScope, source } = {}) {
  const selected = memoryScope(scope), state = memoryState();
  const original = state.facts.find(f => validFact(f) && f.scope === selected && f.id === id && !f.supersededBy);
  if (!original) throw new Error('Active fact not found in this scope.');
  const replacement = createFact(text, original.tag, selected, source);
  original.supersededBy = replacement.id;
  state.facts.push(replacement);
  writeMemory(state);
  return replacement;
}

export function forget(text, { scope = config.memoryScope } = {}) {
  const selected = memoryScope(scope), state = memoryState();
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return { memory: loadMemory({ scope: selected }), removed: 0 };
  // Delete the complete correction chain, including stale versions, if any
  // member matches. Never touch another scope or opaque malformed records.
  const records = state.facts.filter(f => validFact(f) && f.scope === selected);
  const ids = new Set(records.filter(f => f.text.toLowerCase().includes(needle)).map(f => f.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of records) if (f.supersededBy && (ids.has(f.id) || ids.has(f.supersededBy))) {
      if (!ids.has(f.id)) { ids.add(f.id); changed = true; }
      if (!ids.has(f.supersededBy)) { ids.add(f.supersededBy); changed = true; }
    }
  }
  const removed = records.filter(f => ids.has(f.id)).length;
  if (removed) { state.facts = state.facts.filter(f => !(validFact(f) && f.scope === selected && ids.has(f.id))); writeMemory(state); }
  return { memory: loadMemory({ scope: selected }), removed };
}

/* ──────────────────────────── sessions (chats) ─────────────────────────── */

const SESSIONS = join(DATA, "sessions");

/**
 * A session id comes straight off an HTTP request, so it is the one piece of
 * user input that decides a file path. Allowlist the shape, refuse anything
 * that could walk out of `data/sessions`, then assert the result really is
 * inside it — belt, braces, and a check that does not depend on my regex being
 * perfect forever.
 */
export function sessionPath(id) {
  const raw = String(id ?? "");
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100).replace(/^\.+/, "_");
  const file = join(SESSIONS, `${safe}.json`);
  if (!resolve(file).startsWith(resolve(SESSIONS) + sep)) {
    throw new Error("invalid session id");
  }
  return file;
}

/** Search persisted user/assistant turns, never the stale parsed-file cache.
 * Literal, case-insensitive substring search; newest message timestamp first.
 * Empty queries return before any filesystem access. No query becomes a path.
 * Root/file symlinks are refused; O_NOFOLLOW guards the final component when
 * supported. Like the rest of this store, this is not a sandbox against a local
 * process concurrently replacing parent directories.
 */
export function searchSessions(query, { limit = 10 } = {}) {
  if (typeof query !== "string" || !query.trim()) return [];
  const needle = query.trim().toLowerCase();
  if (needle.length > 1000) return [];
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
  let root, entries;
  try {
    if (!lstatSync(SESSIONS).isDirectory()) return [];
    root = realpathSync(SESSIONS);
    entries = readdirSync(SESSIONS, { withFileTypes: true });
  } catch { return []; }
  const hits = [];
  // Stable ordering for equal/missing timestamps, independent of filesystem order.
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,99}\.json$/.test(entry.name)) continue;
    const file = join(SESSIONS, entry.name);
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
      const info = fstatSync(fd);
      // Validate the opened descriptor, not a pre-open path check. On platforms
      // without O_NOFOLLOW, reject links after opening and before reading bytes.
      const current = lstatSync(file);
      if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino || dirname(realpathSync(file)) !== root) continue;
      const maxBytes = 2 * 1024 * 1024;
      if (!info.isFile() || info.size > maxBytes) continue;
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0, n;
      while (size < buffer.length && (n = readSync(fd, buffer, size, buffer.length - size, null))) size += n;
      if (size > maxBytes) continue;
      const session = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      if (!Array.isArray(session?.messages)) continue;
      // Derive identity from the confined filename, never an untrusted JSON id.
      const sessionId = entry.name.slice(0, -5);
      for (const message of session.messages) {
        if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") continue;
        const at = message.content.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        const text = message.content;
        const start = Math.max(0, at - 60);
        const prefix = start ? "…" : "";
        const available = 240 - prefix.length;
        let snippet = prefix + text.slice(start, start + available);
        if (start + available < text.length) snippet = snippet.slice(0, 239) + "…";
        const date = typeof message.at === "string" ? Date.parse(message.at) : NaN;
        const ts = Number.isFinite(date) ? new Date(date).toISOString() : null;
        hits.push({ sessionId, role: message.role, snippet, ts });
        hits.sort((a, b) => (b.ts === null ? -Infinity : Date.parse(b.ts)) - (a.ts === null ? -Infinity : Date.parse(a.ts)));
        if (hits.length > count) hits.length = count;
      }
    } catch { /* malformed, unreadable, deleted or replaced file: skip */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return hits;
}

export function loadSession(id) {
  return readCached(sessionPath(id), { id, messages: [], createdAt: new Date().toISOString() });
}

export function saveSession(id, session) {
  session.updatedAt = new Date().toISOString();
  // Keep the tail bounded: 200 messages is plenty of context and keeps
  // the file small enough to read on a Raspberry Pi.
  if (session.messages.length > 200) session.messages = session.messages.slice(-200);
  writeCached(sessionPath(id), session, JSON.stringify(session, null, 2));
  sessionIndex.set(session.id || String(id), {
    id: session.id || String(id),
    messages: session.messages.length,
    updatedAt: session.updatedAt,
    preview: previewOf(session),
  });
  return session;
}

export function appendMessage(id, message) {
  const session = loadSession(id);
  session.messages.push({ at: new Date().toISOString(), ...message });
  return saveSession(id, session);
}

function previewOf(session) {
  const last = [...(session.messages || [])].reverse().find((m) => m.role === "user");
  return last ? String(last.content).slice(0, 80) : "—";
}

/** Sidebar metadata, built once, then maintained by saveSession(). */
const sessionIndex = new Map();
let indexBuilt = false;

export function listSessions() {
  if (!existsSync(SESSIONS)) return [];
  if (!indexBuilt) {
    // One scan at boot. After this the panel reads memory, not 200 files.
    for (const file of readdirSync(SESSIONS)) {
      if (!file.endsWith(".json")) continue;
      const full = join(SESSIONS, file);
      const s = readJson(full, null);
      if (!s) continue;
      cache.set(full, s);
      sessionIndex.set(s.id || file.replace(/\.json$/, ""), {
        id: s.id || file.replace(/\.json$/, ""),
        messages: (s.messages || []).length,
        updatedAt: s.updatedAt || s.createdAt,
        preview: previewOf(s),
      });
    }
    indexBuilt = true;
  }
  return [...sessionIndex.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function deleteSession(id) {
  const path = sessionPath(id);
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  cache.delete(path);
  sessionIndex.delete(String(id));
}

/* ─────────────────────────── reminders/timers ──────────────────────────── */

const REMINDERS_FILE = join(DATA, "reminders.json");

export function loadReminders() {
  return readJson(REMINDERS_FILE, []);
}

function writeReminders(list) {
  atomicWrite(REMINDERS_FILE, JSON.stringify(list.slice(-500), null, 2));
  return list;
}

export function addReminder(reminder) {
  const list = loadReminders();
  list.push(reminder);
  writeReminders(list);
  return reminder;
}

export function updateReminder(id, patch) {
  const list = loadReminders();
  const index = list.findIndex((r) => r.id === id);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch };
  writeReminders(list);
  return list[index];
}

export function removeReminder(id) {
  const list = loadReminders();
  const next = list.filter((r) => r.id !== id);
  writeReminders(next);
  return list.length - next.length;
}

export function pendingReminders() {
  return loadReminders().filter((r) => !r.fired && !r.cancelled);
}

/* ──────────────────────── schedules (unattended runs) ──────────────────── */

const SCHEDULES_FILE = join(DATA, "schedules.json");

export function loadSchedules() {
  const list = readJson(SCHEDULES_FILE, []);
  return Array.isArray(list) ? list : [];
}

function writeSchedules(list) {
  writeCached(SCHEDULES_FILE, list.slice(0, 50), JSON.stringify(list.slice(0, 50), null, 2));
  return list;
}

export function saveSchedule(schedule) {
  const list = loadSchedules();
  const index = list.findIndex((s) => s.id === schedule.id);
  if (index === -1) list.push(schedule);
  else list[index] = schedule;
  writeSchedules(list);
  return schedule;
}

export function updateSchedule(id, patch) {
  const list = loadSchedules();
  const index = list.findIndex((s) => s.id === id);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch };
  writeSchedules(list);
  return list[index];
}

export function removeSchedule(id) {
  const list = loadSchedules();
  const next = list.filter((s) => s.id !== id);
  writeSchedules(next);
  return list.length - next.length;
}

/* ─────────────────────────── tasks (agent queue) ───────────────────────── */

const TASKS_FILE = join(DATA, "tasks.json");

export function loadTasks() {
  return readJson(TASKS_FILE, []);
}

export function saveTask(task) {
  const tasks = loadTasks();
  const i = tasks.findIndex((t) => t.id === task.id);
  if (i === -1) tasks.unshift(task);
  else tasks[i] = task;
  atomicWrite(TASKS_FILE, JSON.stringify(tasks.slice(0, 100), null, 2));
  return task;
}

/* ─────────────────── saved style personas (not security policy) ───────── */
const PERSONAS_FILE = join(DATA, 'personas.json');
const emptyPersonas = () => ({ version: 1, personas: [], selections: [] });
function personaName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(value) || value === 'default') throw new Error('Use a lowercase persona name (1–40 letters/digits/_/-), other than default.');
  return value;
}
function personaSession(id) {
  // Same identity as the session store, not a second namespace with aliases.
  return sessionPath(id).slice(SESSIONS.length + 1, -5);
}
function validPersonaState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.personas) || !Array.isArray(value.selections) || value.personas.length > 50 || value.selections.length > 1000 || Object.keys(value).some(k => !['version','personas','selections'].includes(k))) return false;
  const names = new Set(), sessions = new Set();
  for (const p of value.personas) {
    if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['name','instructions'].includes(k))) return false;
    try { personaName(p.name); } catch { return false; }
    if (names.has(p.name) || typeof p.instructions !== 'string' || !p.instructions.trim() || p.instructions.length > 2000) return false;
    names.add(p.name);
  }
  for (const s of value.selections) {
    if (!s || typeof s.sessionId !== 'string' || s.sessionId !== personaSession(s.sessionId) || !names.has(s.name) || sessions.has(s.sessionId) || Object.keys(s).some(k => !['sessionId','name'].includes(k))) return false;
    sessions.add(s.sessionId);
  }
  return true;
}
export function loadPersonas({ strict = false } = {}) {
  // Reload this small bounded registry: CLI/other processes can update presets.
  const value = readJson(PERSONAS_FILE, null);
  if (value === null && !existsSync(PERSONAS_FILE)) return emptyPersonas();
  if (validPersonaState(value)) return value;
  if (strict) throw new Error('personas.json is malformed or unsupported; repair/back it up before editing. It was not overwritten.');
  return { ...emptyPersonas(), warning: 'personas.json is malformed or unsupported; default persona is in use.' };
}
function savePersonaState(state) {
  if (!validPersonaState(state)) throw new Error('Invalid persona library.');
  writeCached(PERSONAS_FILE, structuredClone(state), JSON.stringify(state, null, 2));
  return state;
}
export function savePersona(name, instructions) {
  personaName(name);
  if (typeof instructions !== 'string' || !instructions.trim() || instructions.length > 2000) throw new Error('Persona instructions must contain 1–2000 characters.');
  const state = loadPersonas({ strict: true });
  const index = state.personas.findIndex(p => p.name === name);
  const preset = { name, instructions: instructions.trim() };
  if (index < 0) state.personas.push(preset); else state.personas[index] = preset;
  savePersonaState(state); return structuredClone(preset);
}
export function selectPersona(sessionId, name) {
  if (name !== 'default') personaName(name);
  const state = loadPersonas({ strict: true });
  if (name !== 'default' && !state.personas.some(p => p.name === name)) throw new Error('Persona not found. Use /persona list.');
  const id = personaSession(sessionId);
  state.selections = state.selections.filter(s => s.sessionId !== id);
  if (name !== 'default') state.selections.push({sessionId:id,name});
  savePersonaState(state); return name;
}
export function activePersona(sessionId) {
  const state = loadPersonas();
  const selection = state.selections.find(s => s.sessionId === personaSession(sessionId));
  return state.personas.find(p => p.name === selection?.name) || null;
}
export function removePersona(name) {
  personaName(name); const state = loadPersonas({ strict:true });
  if (!state.personas.some(p => p.name === name)) throw new Error('Persona not found.');
  state.personas = state.personas.filter(p => p.name !== name);
  state.selections = state.selections.filter(s => s.name !== name);
  savePersonaState(state);
}
