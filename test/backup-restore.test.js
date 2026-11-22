/**
 * backup-restore.test.js — the F10b acceptance suite (issue #211).
 *
 * The claims under test:
 *
 *   1. Backup → wipe → restore round-trips at 100% with zero silent loss.
 *   2. Corrupt, oversized, tampered or conflicting payloads leave live state
 *      completely unchanged — validation happens before any write.
 *   3. Restore refuses: traversal ids, symlink destinations, config/credential/
 *      plugin content, and — above all — imported approval grants. Skills come
 *      back unapproved or not at all.
 *   4. Reminders and schedules restore *disabled* until the owner deliberately
 *      re-enables them.
 *   5. Restore first writes a pre-restore backup of the live state, so an
 *      interrupted restore is recoverable, not a silent half-write.
 *
 * The system of record is real (store.js, registry.js, a sandbox data dir).
 * Everything is offline and deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-backup-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-backup-data-"));
process.env.PINCH_AUTO_APPROVE = "false";
process.env.LLM_PROVIDER = "ollama";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // nothing listens; nothing may call it

const {
  BACKUP_VERSION,
  buildBackup,
  writeBackup,
  readBackup,
  previewRestore,
  restoreBackup,
  BackupError,
} = await import("../src/backup.js");
const {
  remember, forget, saveTask, loadMemory, loadTasks, addReminder, loadReminders, pendingReminders,
  updateReminder, saveSchedule, loadSchedules, appendMessage, loadSession, invalidate,
} = await import("../src/store.js");
const { saveSkill, loadSkill } = await import("../src/skills/registry.js");
const { validateSkill, SKILL_KIND, SKILL_SCHEMA_VERSION } = await import("../src/skills/manifest.js");

const DATA = process.env.PINCH_DATA;

function skillManifest(name, text = "a fact worth keeping") {
  const manifest = {
    kind: SKILL_KIND,
    schema_version: SKILL_SCHEMA_VERSION,
    name,
    description: "backup fixture",
    compiled_from: { utterance: "written by the test" },
    steps: [
      { tool: "remember", args: { fact: text } },
      { tool: "remember", args: { fact: `${text} (2)` } },
    ],
  };
  validateSkill(manifest);
  return manifest;
}

/** Fill every state kind the backup promises to carry. Wipes first so the
 *  fixed fixture ids are unique — the suite shares one sandbox data dir. */
function seedWorld() {
  wipeWorld();
  remember("deploys happen on Fridays");
  saveTask({ id: "t1", title: "water the plants", done: false, at: "2026-11-22T08:00:00.000Z" });
  saveTask({ id: "t2", title: "file the report", done: true, at: "2026-11-22T08:01:00.000Z" });
  addReminder({ id: "r1", text: "stretch", at: "2026-11-22T18:00:00.000Z", address: "web:main", fired: false, cancelled: false });
  saveSchedule({
    id: "sch1",
    task: "check CI",
    when: "daily at 09:00",
    cadence: { kind: "daily", minuteOfDay: 540, label: "daily at 09:00" },
    address: "web:main",
    runs: 0,
  });
  appendMessage("s-backup-1", { role: "user", content: "hello" });
  appendMessage("s-backup-1", { role: "assistant", content: "hi" });
  saveSkill(skillManifest("keep-facts"));
}

/** Wipe every state kind — the "reinstall" side of the round trip. */
function wipeWorld() {
  for (const f of loadMemory().facts) forget(f.text);
  invalidate();
  for (const f of ["tasks.json", "reminders.json", "schedules.json", "memory.json"]) rmSync(join(DATA, f), { force: true, recursive: true });
  rmSync(join(DATA, "sessions"), { recursive: true, force: true });
  rmSync(join(DATA, "skills"), { recursive: true, force: true });
  invalidate();
}

function assertWorldIsThere() {
  assert.ok(loadMemory().facts.some((f) => /Fridays/i.test(f.text)), "memory fact survives");
  const tasks = loadTasks();
  assert.deepEqual(tasks.map((t) => t.id).sort(), ["t1", "t2"], "tasks survive");
  assert.equal(loadReminders().length, 1, "the reminder row survives");
  assert.equal(loadSchedules().length, 1, "the schedule row survives");
  const session = loadSession("s-backup-1");
  assert.equal(session.messages.length, 2, "the session survives");
  assert.equal(loadSkill("keep-facts").manifest.steps.length, 2, "the skill survives");
}


/** Re-checksum a tampered payload so the intended rule refuses, not the checksum. */
function rechecksum(doc) {
  doc.checksum = createHash("sha256").update(JSON.stringify(doc.payload)).digest("hex");
  return doc;
}

/* ───────────────────────────── the payload ───────────────────────────── */

test("a backup carries the state that matters and never an approval grant", () => {
  seedWorld();
  const doc = buildBackup();
  assert.equal(doc.$schema, "quasnooze-backup/2");
  assert.equal(doc.version, BACKUP_VERSION);
  assert.equal(typeof doc.checksum, "string");
  assert.match(doc.checksum, /^[0-9a-f]{64}$/, "the payload is checksummed");
  assert.ok(doc.payload.memory.facts.length >= 1);
  assert.equal(doc.payload.tasks.length, 2);
  assert.equal(doc.payload.reminders.length, 1);
  assert.equal(doc.payload.schedules.length, 1);
  assert.equal(doc.payload.sessions.length, 1);
  assert.equal(doc.payload.skills.length, 1);
  const json = JSON.stringify(doc);
  assert.equal(/approval/i.test(json), false, "a backup never carries approval grants");
  assert.equal(/api[_-]?key|secret|password/i.test(json), false, "a backup never carries credentials");
});

/* ──────────────────────────── the round trip ─────────────────────────── */

test("backup → wipe → restore round-trips at 100% with zero silent loss", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  assert.equal(loadTasks().length, 0, "the world is gone");
  const result = restoreBackup(backup, { mode: "merge" });
  assert.equal(result.ok, true);
  assertWorldIsThere();
});

test("replace mode restores the exact backed-up collections", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  saveTask({ id: "local-only", title: "not in the backup", done: false, at: "2026-11-22T09:00:00.000Z" });
  const result = restoreBackup(backup, { mode: "replace" });
  assert.equal(result.ok, true);
  assertWorldIsThere();
  assert.equal(loadTasks().some((t) => t.id === "local-only"), false, "replace removes what the backup does not hold");
});

/* ─────────────────────── refusals leave state untouched ───────────────── */

function stateFingerprint() {
  return JSON.stringify({
    memory: loadMemory(),
    tasks: loadTasks(),
    reminders: loadReminders(),
    schedules: loadSchedules(),
  });
}

test("a tampered payload is refused before anything is written", () => {
  seedWorld();
  const backup = buildBackup();
  const before = stateFingerprint();
  const tampered = JSON.parse(JSON.stringify(backup));
  tampered.payload.tasks.push({ id: "evil", title: "injected", done: false, at: "x" });
  assert.throws(() => readBackup(tampered), (err) => err instanceof BackupError && err.reason === "checksum");
  assert.throws(() => restoreBackup(tampered, { mode: "merge" }), BackupError);
  invalidate();
  assert.equal(stateFingerprint(), before, "live state is unchanged");
});

test("corrupt and version-mismatched payloads are refused", () => {
  assert.throws(() => readBackup("this is not json"), (err) => err instanceof BackupError && err.reason === "corrupt");
  const doc = buildBackup();
  const future = { ...doc, version: 99, checksum: doc.checksum };
  assert.throws(() => readBackup(future), (err) => err instanceof BackupError && err.reason === "version");
});

test("oversized payloads are refused", () => {
  const doc = buildBackup();
  const big = JSON.parse(JSON.stringify(doc));
  big.payload.memory.facts.push({ text: "x".repeat(2_000_000) });
  rechecksum(big); // the size rule, not the checksum rule, must refuse
  assert.throws(() => readBackup(big), (err) => err instanceof BackupError && err.reason === "oversized");
});

test("a payload with conflicting duplicate ids is refused", () => {
  const doc = buildBackup();
  const clash = JSON.parse(JSON.stringify(doc));
  clash.payload.skills.push({ ...clash.payload.skills[0] });
  rechecksum(clash);
  assert.throws(() => readBackup(clash), (err) => err instanceof BackupError && err.reason === "conflict");
});

test("restore refuses imported approval grants, by any hand", () => {
  const doc = buildBackup();
  const smuggled = JSON.parse(JSON.stringify(doc));
  smuggled.payload.approvals = { "keep-facts": { digest: "deadbeef", approved_at: "2026-11-22" } };
  rechecksum(smuggled);
  assert.throws(() => readBackup(smuggled), (err) => err instanceof BackupError && err.reason === "approvals");
});

test("restore refuses config, credential and plugin content", () => {
  for (const forbidden of ["env", "config", "plugins", "mcp", "credentials"]) {
    const doc = buildBackup();
    const smuggled = JSON.parse(JSON.stringify(doc));
    smuggled.payload[forbidden] = { anything: true };
    rechecksum(smuggled);
    assert.throws(() => readBackup(smuggled), (err) => err instanceof BackupError && err.reason === "schema",
      `${forbidden} must be refused as unknown schema`);
  }
});

test("restored skills arrive unapproved — grants never travel", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  restoreBackup(backup, { mode: "merge" });
  const loaded = loadSkill("keep-facts");
  assert.equal(loaded.approval.approved, false, "a restored skill is not owner-approved");
});

test("traversal ids are refused", () => {
  const doc = buildBackup();
  const evil = JSON.parse(JSON.stringify(doc));
  evil.payload.sessions[0] = { ...evil.payload.sessions[0], id: "../evil" };
  rechecksum(evil);
  assert.throws(() => readBackup(evil), (err) => err instanceof BackupError && err.reason === "traversal");
});

test("a symlink waiting at the destination refuses the restore", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  // the attacker swapped a skill file for a link pointing elsewhere
  mkdirSync(join(DATA, "skills"), { recursive: true });
  writeFileSync(join(DATA, "outside-target.txt"), "not yours\n");
  symlinkSync(join(DATA, "outside-target.txt"), join(DATA, "skills", "keep-facts.json"));
  assert.throws(() => restoreBackup(backup, { mode: "merge" }), (err) => err instanceof BackupError && err.reason === "symlink");
  assert.equal(readFileSync(join(DATA, "outside-target.txt"), "utf8"), "not yours\n", "the symlink target is untouched");
});

/* ───────────────────── disabled until deliberately re-enabled ─────────── */

test("reminders and schedules restore disabled until the owner re-enables them", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  const result = restoreBackup(backup, { mode: "merge" });
  assert.equal(result.ok, true);
  assert.equal(loadReminders().length, 1, "the data is kept");
  assert.equal(pendingReminders().length, 0, "but nothing is pending — restore disabled it");
  const [reminder] = loadReminders();
  assert.equal(reminder.enabled, false);
  updateReminder(reminder.id, { enabled: true });
  assert.equal(pendingReminders().length, 1, "deliberate re-enabling brings it back");
  const [schedule] = loadSchedules();
  assert.equal(schedule.enabled, false, "schedules restore disabled too");
});

/* ─────────────────── the pre-restore copy and interruptions ───────────── */

test("restore writes a pre-restore backup of the live state first", () => {
  seedWorld();
  const backup = buildBackup();
  // new live state the backup does not know about
  remember("a fact added after the backup");
  const result = restoreBackup(backup, { mode: "merge" });
  assert.equal(result.ok, true);
  assert.ok(result.preRestore, "a pre-restore copy path is reported");
  const copy = JSON.parse(readFileSync(result.preRestore, "utf8"));
  assert.ok(copy.payload.memory.facts.some((f) => /added after/i.test(f.text)), "the pre-restore copy holds the prior live state");
});

test("an interrupted restore reports honestly and keeps the pre-restore copy", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  // a directory squatting where tasks.json must go: the write cannot land
  rmSync(join(DATA, "tasks.json"), { force: true, recursive: true });
  mkdirSync(join(DATA, "tasks.json"), { recursive: true });
  const result = restoreBackup(backup, { mode: "merge" });
  assert.equal(result.ok, false, "the failure is reported, not swallowed");
  assert.ok(result.preRestore && existsSync(result.preRestore), "the pre-restore copy is there for recovery");
  assert.match(result.error, /refusing to restore|EISDIR|not a regular file/i);
});

/* ──────────────────────────── preview and merge ───────────────────────── */

test("preview describes the effect without touching live state", () => {
  seedWorld();
  const backup = buildBackup();
  const before = stateFingerprint();
  const plan = previewRestore(backup, { mode: "merge" });
  assert.ok(plan.adds.length >= 0 && plan.updates.length >= 0);
  assert.ok(plan.disabled.reminders >= 1, "the preview says reminders will restore disabled");
  invalidate();
  assert.equal(stateFingerprint(), before, "preview is read-only");
});

test("merge keeps local wins on conflicts and adds what is missing", () => {
  seedWorld();
  const backup = buildBackup();
  wipeWorld();
  saveTask({ id: "t1", title: "water the plants — locally edited", done: true, at: "2026-11-22T10:00:00.000Z" });
  restoreBackup(backup, { mode: "merge" });
  const t1 = loadTasks().find((t) => t.id === "t1");
  assert.match(t1.title, /locally edited/, "merge does not clobber local changes");
  assert.ok(loadTasks().some((t) => t.id === "t2"), "merge adds what is missing");
});

/* ───────────────────────── writing a backup file ──────────────────────── */

test("writeBackup puts a readable, owner-only file at the asked path", () => {
  seedWorld();
  const out = join(process.env.PINCH_WORKSPACE, "backups", "state.json");
  const written = writeBackup({ path: out });
  assert.equal(written.path, out);
  const doc = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(doc.$schema, "quasnooze-backup/2");
  assert.equal((statSync(out).mode & 0o777), 0o600, "owner-only");
});
