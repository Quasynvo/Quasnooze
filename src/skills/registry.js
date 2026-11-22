/**
 * src/skills/registry.js — where compiled skills live, and the owner's review.
 *
 * The same discipline as the tool registry (docs/TOOL-INVENTORY.md): no
 * marketplace, no auto-install, no self-approval. A skill becomes runnable
 * only when the owner approves *its content* — approval is recorded against
 * the manifest's sha256, not its filename. Edit the skill after approval and
 * the approval goes stale: the loader says so and replay refuses until the
 * owner reviews again. Revoking is one command and never deletes the file.
 *
 * Storage: <data>/skills/<name>.json plus <data>/skills/approvals.json —
 * local files under PINCH_DATA like every other piece of state, mode 0600.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { config } from "../config.js";
import { SkillError, NAME_PATTERN, validateSkill, skillDigest } from "./manifest.js";

const SKILLS_DIR = join(config.dataDir, "skills");

export function skillsDir() {
  return SKILLS_DIR;
}

function approvalsPath() {
  return join(SKILLS_DIR, "approvals.json");
}

/** Skill names become file names — allowlist the shape, then prove containment.
 *
 *  The containment proof is load-bearing twice: once for safety (a name may
 *  never select a file outside the skills directory) and once for static
 *  analysis (CodeQL's path-injection barrier recognizes exactly this shape —
 *  resolve to a normalized absolute path, then guard with a positive
 *  `startsWith(root)` before the value flows to any file sink).
 */
function skillPath(name) {
  const raw = String(name ?? "");
  if (!NAME_PATTERN.test(raw)) {
    throw new SkillError(`invalid skill name ${JSON.stringify(raw)} — names match ${NAME_PATTERN}`);
  }
  if (raw === "approvals") {
    throw new SkillError('invalid skill name "approvals" — reserved for the approval records file');
  }
  const file = resolve(join(SKILLS_DIR, `${raw}.json`));
  if (file.startsWith(resolve(SKILLS_DIR) + sep)) return file;
  throw new SkillError("invalid skill name");
}

/** Approvals are keyed by skill name: build a null-prototype map and copy only
 *  allowlisted keys, so no stored content can ever reach Object.prototype. */
function readApprovals() {
  const out = Object.create(null);
  try {
    const doc = JSON.parse(readFileSync(approvalsPath(), "utf8"));
    if (doc && typeof doc === "object" && !Array.isArray(doc)) {
      for (const key of Object.keys(doc)) {
        if (NAME_PATTERN.test(key)) out[key] = doc[key];
      }
    }
  } catch {
    /* no approvals yet */
  }
  return out;
}

function writeApprovals(doc) {
  mkdirSync(SKILLS_DIR, { recursive: true });
  writeFileSync(approvalsPath(), `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
}

/** Read a skill file the careful way: a regular file, not a symlink out. */
function readSkillFile(name) {
  const file = skillPath(name);
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new SkillError(`refusing to load ${file}: not a regular file`);
  }
  return readFileSync(file, "utf8");
}

/**
 * Save a compiled (or re-validated) manifest. Saving never approves: the
 * approval gate is a separate, deliberate owner action.
 */
export function saveSkill(manifest) {
  const skill = validateSkill(manifest);
  mkdirSync(SKILLS_DIR, { recursive: true });
  writeFileSync(skillPath(skill.name), `${JSON.stringify(skill, null, 2)}\n`, { mode: 0o600 });
  return { name: skill.name, digest: skillDigest(skill) };
}

/**
 * Load a skill with its approval state.
 *
 * @returns {{manifest: object, digest: string, approval: {approved: boolean, stale: boolean, approved_at: string|null}}}
 *   `approved` is true only when the owner approved *this exact content*;
 *   `stale` marks content that changed after approval (approved: false for
 *   it as well — a stale approval is not an approval).
 */
export function loadSkill(name) {
  const raw = readSkillFile(name);
  if (raw === null) throw new SkillError(`no such skill: ${String(name ?? "")}`);
  const manifest = validateSkill(JSON.parse(raw));
  const digest = skillDigest(manifest);
  const record = readApprovals()[manifest.name];
  const matches = Boolean(record) && record.digest === digest;
  return {
    manifest,
    digest,
    approval: {
      approved: matches,
      stale: Boolean(record) && !matches,
      approved_at: matches ? (record.approved_at ?? null) : null,
    },
  };
}

/** List skills with their approval state. Never throws on one bad file: a
 *  corrupt skill is reported, not allowed to hide the healthy ones. */
export function listSkills() {
  let entries;
  try {
    entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "approvals.json") continue;
    const name = entry.name.slice(0, -5);
    if (!NAME_PATTERN.test(name)) continue;
    try {
      const loaded = loadSkill(name);
      rows.push({
        name,
        description: loaded.manifest.description,
        steps: loaded.manifest.steps.length,
        approved: loaded.approval.approved,
        stale: loaded.approval.stale,
      });
    } catch (err) {
      rows.push({ name, error: err.message });
    }
  }
  return rows;
}

/**
 * The owner's review: approve the *content* currently stored under this name.
 * Re-approving after an edit is the same call — review the diff first
 * (`quasnooze skills show`), then approve.
 */
export function approveSkill(name) {
  const raw = readSkillFile(name);
  if (raw === null) throw new SkillError(`no such skill: ${String(name ?? "")}`);
  const manifest = validateSkill(JSON.parse(raw));
  const digest = skillDigest(manifest);
  const approvals = readApprovals();
  approvals[manifest.name] = { digest, approved_at: new Date().toISOString() };
  writeApprovals(approvals);
  return { name: manifest.name, digest };
}

/** Revoke the approval, keep the file. Replay stops immediately. */
export function revokeSkill(name) {
  const safe = String(name ?? "");
  if (!NAME_PATTERN.test(safe)) throw new SkillError(`invalid skill name ${JSON.stringify(safe)}`);
  const approvals = readApprovals();
  const existed = Boolean(approvals[safe]);
  delete approvals[safe];
  writeApprovals(approvals);
  return { name: safe, revoked: existed };
}

/** Remove the skill and its approval record. */
export function deleteSkill(name) {
  const file = skillPath(name);
  const { revoked } = revokeSkill(name);
  let deleted = false;
  if (existsSync(file)) {
    unlinkSync(file);
    deleted = true;
  }
  return { name: String(name), deleted, approvalRevoked: revoked };
}
