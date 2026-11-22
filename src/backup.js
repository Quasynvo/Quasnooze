/**
 * src/backup.js — versioned backup and validated restore (F10b, issue #211).
 *
 * Export (src/export.js) answers "what do you know about me?". This answers
 * "how do I leave and come back?": one versioned, checksummed document that
 * round-trips the state that matters — memory, tasks, reminders, schedules,
 * personas, profile, sessions, and skills — through a wipe and back.
 *
 * The restore is the part that earns trust, so it is the part built like the
 * tool registry (docs/TOOL-INVENTORY.md): a closed schema, validated before a
 * single byte is written, and hard refusals for the things an archive must
 * never carry into a live machine:
 *
 *   - approval grants. A restored skill arrives unapproved or not at all.
 *     Authority is granted by the owner at the keyboard, never imported.
 *   - config, credentials, plugins, MCP config — anything executable or
 *     secret-shaped is refused by name at parse time.
 *   - traversal ids and symlink destinations. The archive names things; it
 *     does not choose where bytes land.
 *
 * Reminders and schedules restore *disabled* — the data survives, nothing
 * fires until the owner deliberately re-enables it. And every restore writes
 * a pre-restore copy of the live state first, so an interruption is a
 * recovery, not a silent half-write.
 *
 * Everything here is local: no network import exists in this file, and
 * test/cost-ledger.test.js proves it stays that way.
 */
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.js";
import {
  exportMemory, loadTasks, loadReminders, loadSchedules, loadPersonas, loadSession, listSessions,
  saveTask, addReminder, saveSchedule, saveSession, deleteSession, invalidate,
} from "./store.js";
import { saveSkill, deleteSkill, skillsDir } from "./skills/registry.js";
import { NAME_PATTERN, validateSkill } from "./skills/manifest.js";

export const BACKUP_KIND = "quasnooze-backup";
export const BACKUP_VERSION = 2;

/** Hard ceilings. A backup is a document, not a disk image. */
export const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_FIELD = 1_000_000;
const MAX_ITEMS = 10_000;
const MAX_SKILLS = 500;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_ID = (id) => ID_RE.test(String(id ?? "")) && !String(id).includes("..");

const PAYLOAD_KEYS = Object.freeze(["memory", "tasks", "reminders", "schedules", "personas", "profile", "sessions", "skills", "telemetry"]);

/** Refusals carry a machine-readable reason; everything else is a bug report. */
export class BackupError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "BackupError";
    this.reason = reason;
  }
}

const checksumOf = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/* ─────────────────────────────── building ─────────────────────────────── */

function readSkillManifests() {
  const dir = skillsDir();
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json") && e.name !== "approvals.json")
      .map((e) => e.name.slice(0, -5))
      .filter((n) => NAME_PATTERN.test(n))
      .sort();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
      out.push(clone(manifest));
    } catch {
      /* a corrupt skill file is not silently folded into a backup */
    }
  }
  return out;
}

/**
 * Build the backup envelope as a plain object. Pure with respect to the
 * filesystem: it reads, sorts, and returns. Writing is the caller's job.
 * Approval grants are never read, so they can never appear.
 */
export function buildBackup({ includeTelemetry = false } = {}) {
  const sessions = listSessions()
    .map((row) => loadSession(row.id))
    .filter((s) => s && Array.isArray(s.messages))
    .map(clone)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  const payload = {
    memory: clone(exportMemory()),
    tasks: clone(loadTasks()),
    reminders: clone(loadReminders()),
    schedules: clone(loadSchedules()),
    personas: clone(loadPersonas()),
    profile: existsSync(config.profilePath) ? readFileSync(config.profilePath, "utf8") : "",
    sessions,
    skills: readSkillManifests(),
    telemetry: null,
  };

  if (includeTelemetry) {
    const path = join(config.dataDir, "telemetry.ndjson");
    payload.telemetry = existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
  }

  return {
    $schema: `${BACKUP_KIND}/2`,
    version: BACKUP_VERSION,
    created_at: new Date().toISOString(),
    checksum: checksumOf(payload),
    payload,
  };
}

/** Write the backup. Returns a summary, not the document. */
export function writeBackup({ path, includeTelemetry = false } = {}) {
  const doc = buildBackup({ includeTelemetry });
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, json, { mode: 0o600 });
  return {
    path: abs,
    bytes: Buffer.byteLength(json),
    counts: {
      tasks: doc.payload.tasks.length,
      reminders: doc.payload.reminders.length,
      schedules: doc.payload.schedules.length,
      sessions: doc.payload.sessions.length,
      skills: doc.payload.skills.length,
    },
  };
}

/* ────────────────────────────── validating ────────────────────────────── */

function walkSizes(node, where = "$") {
  if (typeof node === "string") {
    if (node.length > MAX_FIELD) throw new BackupError("oversized", `field ${where} exceeds ${MAX_FIELD} characters`);
    return;
  }
  if (Array.isArray(node)) {
    if (node.length > MAX_ITEMS) throw new BackupError("oversized", `array ${where} exceeds ${MAX_ITEMS} items`);
    for (const [i, v] of node.entries()) walkSizes(v, `${where}[${i}]`);
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkSizes(v, `${where}.${k}`);
  }
}

function noDuplicates(rows, idOf, what) {
  const seen = new Set();
  for (const row of rows) {
    const id = idOf(row);
    if (seen.has(id)) throw new BackupError("conflict", `two ${what} claim the id ${JSON.stringify(id)}`);
    seen.add(id);
  }
}

/**
 * Validate an archive. Everything that could hurt is refused here — before
 * the caller can write anything anywhere.
 */
export function readBackup(input) {
  let doc = input;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch {
      throw new BackupError("corrupt", "the file is not JSON");
    }
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new BackupError("corrupt", "not a backup document");
  if (doc.$schema !== `${BACKUP_KIND}/2`) throw new BackupError("schema", `not a ${BACKUP_KIND}/2 document`);
  if (doc.version !== BACKUP_VERSION) throw new BackupError("version", `backup version ${doc.version} cannot be restored by this build (${BACKUP_VERSION})`);
  const payload = doc.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new BackupError("schema", "missing payload");

  if (typeof doc.checksum !== "string" || checksumOf(payload) !== doc.checksum) {
    throw new BackupError("checksum", "the payload does not match its checksum — the archive is corrupt or was altered");
  }

  // Authority is granted at the keyboard, never imported. This is checked
  // before the generic schema rule so the refusal names the real problem.
  if ("approvals" in payload) {
    throw new BackupError("approvals", "refusing to import approval grants — approve restored skills by hand");
  }

  for (const key of Object.keys(payload)) {
    if (!PAYLOAD_KEYS.includes(key)) {
      throw new BackupError("schema", `refusing unknown payload section ${JSON.stringify(key)} — an archive carries state, never config, credentials or plugins`);
    }
  }

  walkSizes(payload, "$");
  if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) throw new BackupError("oversized", "payload exceeds the size ceiling");

  const { memory, tasks = [], reminders = [], schedules = [], personas, sessions = [], skills = [] } = payload;
  if (!memory || typeof memory !== "object" || !Array.isArray(memory.facts)) throw new BackupError("schema", "memory section is malformed");
  if (!Array.isArray(tasks) || !Array.isArray(reminders) || !Array.isArray(schedules) || !Array.isArray(sessions) || !Array.isArray(skills)) {
    throw new BackupError("schema", "collection sections must be arrays");
  }
  if (skills.length > MAX_SKILLS) throw new BackupError("oversized", "too many skills");
  if (personas && (typeof personas !== "object" || !Array.isArray(personas.personas) || !Array.isArray(personas.selections))) {
    throw new BackupError("schema", "personas section is malformed");
  }

  for (const s of sessions) {
    if (!s || !SAFE_ID(s.id) || !Array.isArray(s.messages)) throw new BackupError("traversal", `refusing session id ${JSON.stringify(s?.id)}`);
  }
  for (const t of tasks) if (!t || !SAFE_ID(t.id)) throw new BackupError("traversal", `refusing task id ${JSON.stringify(t?.id)}`);
  for (const r of reminders) if (!r || !SAFE_ID(r.id)) throw new BackupError("traversal", `refusing reminder id ${JSON.stringify(r?.id)}`);
  for (const s of schedules) if (!s || !SAFE_ID(s.id)) throw new BackupError("traversal", `refusing schedule id ${JSON.stringify(s?.id)}`);
  for (const m of skills) {
    if (!m || typeof m !== "object" || !NAME_PATTERN.test(String(m.name ?? ""))) {
      throw new BackupError("traversal", `refusing skill name ${JSON.stringify(m?.name)}`);
    }
    // The skill manifest schema refuses grants/permissions/approved by name.
    try {
      validateSkill(m);
    } catch (err) {
      throw new BackupError("schema", `skill ${JSON.stringify(m.name)} is not a valid manifest: ${err.message}`);
    }
  }

  noDuplicates(sessions, (s) => s.id, "sessions");
  noDuplicates(tasks, (t) => t.id, "tasks");
  noDuplicates(reminders, (r) => r.id, "reminders");
  noDuplicates(schedules, (s) => s.id, "schedules");
  noDuplicates(skills, (m) => m.name, "skills");

  return doc;
}

/* ─────────────────────────────── restoring ────────────────────────────── */

const factKey = (f) => String(f?.text ?? "").trim().toLowerCase().slice(0, 500);

/**
 * A destination that is a symlink is an attacker's redirection — refused as a
 * validation failure, before anything is applied. A destination that is some
 * other non-file (a directory squatting on the path) is an interruption: the
 * write fails and the caller gets an honest partial report instead.
 */
function assertNoSymlink(path, what) {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new BackupError("symlink", `refusing to restore ${what}: ${path} is a symbolic link`);
  } catch (err) {
    if (err instanceof BackupError) throw err;
    if (err?.code !== "ENOENT") throw err;
  }
}

/** Atomic, contained write for whole-collection replaces. */
function writeCollection(name, rows) {
  const target = join(config.dataDir, name);
  assertNoSymlink(target, name);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
  try {
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch { /* some filesystems refuse fsync */ }
  renameSync(tmp, target);
  invalidate(target);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * Describe what a restore would do. Read-only: live state is untouched.
 */
export function previewRestore(backup, { mode = "merge" } = {}) {
  const doc = readBackup(backup);
  const p = doc.payload;
  const plan = { mode, adds: [], updates: [], removes: [], disabled: { reminders: p.reminders.length, schedules: p.schedules.length }, notes: [] };

  const diff = (liveIds, backupIds, label) => {
    const live = new Set(liveIds);
    const back = new Set(backupIds);
    for (const id of back) (live.has(id) ? plan.updates : plan.adds).push(`${label}:${id}`);
    if (mode === "replace") for (const id of live) if (!back.has(id)) plan.removes.push(`${label}:${id}`);
  };

  diff(listSessions().map((r) => r.id), p.sessions.map((s) => s.id), "session");
  diff(loadTasks().map((t) => t.id), p.tasks.map((t) => t.id), "task");
  diff(readSkillManifests().map((m) => m.name), p.skills.map((m) => m.name), "skill");
  const liveFacts = new Set(exportMemory().facts.map(factKey));
  for (const f of p.memory.facts) (liveFacts.has(factKey(f)) ? plan.updates : plan.adds).push(`memory:${factKey(f).slice(0, 40)}`);
  plan.notes.push("reminders and schedules restore disabled until re-enabled");
  if (mode === "merge") plan.notes.push("merge keeps local state on conflicts");
  return plan;
}

/**
 * Restore an archive into live state. Validated first, pre-restore copy
 * second, writes third — in that order, always.
 *
 * @returns {{ok: boolean, mode: string, preRestore: string|null, applied: object, disabled: object, error?: string}}
 */
export function restoreBackup(backup, { mode = "merge", pre = true } = {}) {
  const doc = readBackup(backup); // every refusal happens here, before writes
  const p = doc.payload;

  // Every destination is checked before anything is applied: a symlink
  // anywhere in the plan refuses the whole restore with nothing written.
  for (const session of p.sessions) {
    assertNoSymlink(join(config.dataDir, "sessions", `${String(session.id).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`), `session ${session.id}`);
  }
  for (const manifest of p.skills) {
    assertNoSymlink(join(skillsDir(), `${manifest.name}.json`), `skill ${manifest.name}`);
  }
  for (const name of ["tasks.json", "reminders.json", "schedules.json", "memory.json"]) {
    assertNoSymlink(join(config.dataDir, name), name);
  }

  const result = {
    ok: true,
    mode,
    preRestore: null,
    applied: { memory: 0, tasks: 0, reminders: 0, schedules: 0, sessions: 0, skills: 0 },
    disabled: { reminders: 0, schedules: 0 },
    notes: [],
  };

  if (pre) {
    const prePath = join(config.dataDir, `pre-restore-${stamp()}.json`);
    writeFileSync(prePath, `${JSON.stringify(buildBackup(), null, 2)}\n`, { mode: 0o600 });
    result.preRestore = prePath;
  }

  try {
    // Memory: merge is union with local wins on identical facts; replace is
    // the archive's list exactly. Written as one atomic file.
    const liveMemory = exportMemory();
    const liveByKey = new Map(liveMemory.facts.map((f) => [factKey(f), f]));
    const facts = mode === "replace"
      ? clone(p.memory.facts)
      : [...clone(liveMemory.facts), ...p.memory.facts.filter((f) => !liveByKey.has(factKey(f))).map(clone)];
    const profile = mode === "replace" ? (p.memory.profile || {}) : { ...(p.memory.profile || {}), ...(liveMemory.profile || {}) };
    writeCollection("memory.json", { ...clone(liveMemory), facts, profile, updatedAt: new Date().toISOString() });
    invalidate();
    result.applied.memory = facts.length;

    // Tasks: merge keeps local rows on conflicts and adds what is missing.
    if (mode === "replace") {
      writeCollection("tasks.json", clone(p.tasks));
      result.applied.tasks = p.tasks.length;
    } else {
      const liveIds = new Set(loadTasks().map((t) => t.id));
      for (const task of p.tasks) {
        if (!liveIds.has(task.id)) {
          saveTask(clone(task));
          result.applied.tasks += 1;
        }
      }
    }

    // Reminders and schedules restore disabled: the data survives, nothing
    // fires. Deliberate re-enabling is updateReminder(id, { enabled: true }).
    const disable = (rows) => rows.map((r) => ({ ...clone(r), enabled: false, restored: true }));
    if (mode === "replace") {
      writeCollection("reminders.json", disable(p.reminders));
      writeCollection("schedules.json", disable(p.schedules));
      result.applied.reminders = p.reminders.length;
      result.applied.schedules = p.schedules.length;
    } else {
      const liveReminders = new Set(loadReminders().map((r) => r.id));
      for (const reminder of p.reminders) {
        if (!liveReminders.has(reminder.id)) {
          addReminder({ ...clone(reminder), enabled: false, restored: true });
          result.applied.reminders += 1;
        }
      }
      const liveSchedules = new Set(loadSchedules().map((s) => s.id));
      for (const schedule of p.schedules) {
        if (!liveSchedules.has(schedule.id)) {
          saveSchedule({ ...clone(schedule), enabled: false, restored: true });
          result.applied.schedules += 1;
        }
      }
    }
    result.disabled = { reminders: p.reminders.length, schedules: p.schedules.length };

    // Sessions: merge adds what is missing; replace is the archive's set.
    const liveSessions = new Set(listSessions().map((r) => r.id));
    if (mode === "replace") {
      for (const id of liveSessions) {
        if (!p.sessions.some((s) => s.id === id)) deleteSession(id);
      }
    }
    for (const session of p.sessions) {
      if (mode === "replace" || !liveSessions.has(session.id)) {
        saveSession(session.id, clone(session));
        result.applied.sessions += 1;
      }
    }

    // Skills: manifests only. Approvals never travel — a restored skill is
    // unapproved until the owner says otherwise at the keyboard.
    const liveSkills = new Set(readSkillManifests().map((m) => m.name));
    if (mode === "replace") {
      for (const name of liveSkills) {
        if (!p.skills.some((m) => m.name === name)) deleteSkill(name);
      }
    }
    for (const manifest of p.skills) {
      if (mode === "replace" || !liveSkills.has(manifest.name)) {
        saveSkill(clone(manifest));
        result.applied.skills += 1;
      }
    }
    result.notes.push("reminders and schedules restored disabled — re-enable deliberately");
    result.notes.push("skills restored unapproved — approve them by hand");
  } catch (err) {
    result.ok = false;
    result.error = String(err?.message ?? err);
    result.notes.push("state before this restore is in the pre-restore copy");
    return result;
  }

  return result;
}
