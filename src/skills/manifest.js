/**
 * src/skills/manifest.js — what a compiled skill *is*: data, not authority.
 *
 * A skill is the executable memory of one successful conversation turn: an
 * ordered list of tool calls with their exact arguments, compiled from a run
 * that already happened and was verified. Everything else a manifest could
 * try to say — permissions, grants, policy, "allow": true — is refused at
 * parse time, because a file that can grant itself power is a file an
 * attacker can write.
 *
 * Identity is content: `skillDigest` hashes the canonical form of the
 * manifest, so the owner approves *this* skill — not this filename. Edit the
 * content and the approval no longer matches (see registry.js).
 */
import { createHash } from "node:crypto";

export const SKILL_KIND = "quasnooze-skill";
export const SKILL_SCHEMA_VERSION = 1;

/** A one-call "skill" is a replay of a single tool call. The fast path and the
 *  tool list already do that; a skill earns its name by being a program. */
export const MIN_STEPS = 2;
/** A plan longer than this is a wall, not a program (mirrors PLAN_MAX_STEPS). */
export const MAX_STEPS = 12;

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_DESCRIPTION = 400;
export const MAX_UTTERANCE = 2000;

/** The manifest schema is closed on purpose: these keys, in any order, and
 *  nothing else. An unknown key is not "extra metadata" — it is the first
 *  thing a malicious skill would add. */
export const MANIFEST_KEYS = Object.freeze([
  "kind",
  "schema_version",
  "name",
  "description",
  "compiled_from",
  "steps",
]);

export const STEP_KEYS = Object.freeze(["tool", "args"]);
export const COMPILED_FROM_KEYS = Object.freeze(["utterance"]);

export class SkillError extends Error {
  constructor(message) {
    super(message);
    this.name = "SkillError";
  }
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Canonical JSON: object keys sorted at every depth. Two manifests with the
 * same content hash the same whatever order they were assembled in, while
 * `JSON.stringify` (used for the byte-identity contract) keeps the recorded
 * key order untouched.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(",")}]`;
  if (isPlainObject(value)) {
    const parts = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] ?? null)}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(value ?? null) ?? "null";
}

/** The content identity of a skill: sha256 over its canonical form. */
export function skillDigest(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function deepFreeze(value) {
  if (isPlainObject(value) || Array.isArray(value)) {
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return Object.freeze(value);
}

/** Arguments must be plain JSON — no functions, no cycles, no dangerous keys. */
function validateArgs(args, where) {
  const seen = new Set();
  const walk = (node, path) => {
    if (node === null) return;
    const t = typeof node;
    if (t === "string" || t === "boolean") return;
    if (t === "number") {
      if (!Number.isFinite(node)) throw new SkillError(`${where}: arguments must be plain JSON, found ${node} at ${path}`);
      return;
    }
    if (t !== "object") throw new SkillError(`${where}: arguments must be plain JSON, found ${t} at ${path}`);
    if (seen.has(node)) throw new SkillError(`${where}: arguments must be plain JSON, found a cycle at ${path}`);
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else {
      const proto = Object.getPrototypeOf(node);
      if (proto !== Object.prototype && proto !== null) {
        throw new SkillError(`${where}: arguments must be plain JSON objects, found ${proto?.constructor?.name ?? "a custom object"} at ${path}`);
      }
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_KEYS.has(key)) throw new SkillError(`${where}: argument key "${key}" is refused — a skill's data must not be able to reach the prototype chain`);
        walk(node[key], `${path}.${key}`);
      }
    }
    seen.delete(node);
  };
  walk(args, "$");
}

function unknownKeyError(kind, key) {
  return new SkillError(
    `a skill is data, not authority: ${kind} "${key}" is not part of the manifest schema and will not be honoured`,
  );
}

/**
 * Validate a manifest and return it deep-frozen. Throws SkillError with a
 * message a human can act on. The schema is closed: anything not listed in
 * MANIFEST_KEYS is refused by name, so a manifest cannot carry grants,
 * permissions, approvals or policy — those live in code and in the owner's
 * decisions, never in skill content.
 */
export function validateSkill(manifest) {
  if (!isPlainObject(manifest)) throw new SkillError("a skill manifest must be a plain JSON object");
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KEYS.includes(key)) throw unknownKeyError("manifest field", key);
    if (FORBIDDEN_KEYS.has(key)) throw new SkillError(`manifest key "${key}" is refused`);
  }
  if (manifest.kind !== SKILL_KIND) throw new SkillError(`manifest kind must be "${SKILL_KIND}", found ${JSON.stringify(manifest.kind)}`);
  if (manifest.schema_version !== SKILL_SCHEMA_VERSION) {
    throw new SkillError(`manifest schema_version must be ${SKILL_SCHEMA_VERSION}, found ${JSON.stringify(manifest.schema_version)}`);
  }
  if (typeof manifest.name !== "string" || !NAME_PATTERN.test(manifest.name)) {
    throw new SkillError(`skill name must match ${NAME_PATTERN} (lowercase letters, digits and dashes), found ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.description !== undefined && (typeof manifest.description !== "string" || manifest.description.length > MAX_DESCRIPTION)) {
    throw new SkillError(`description must be a string of at most ${MAX_DESCRIPTION} characters`);
  }
  const from = manifest.compiled_from;
  if (!isPlainObject(from)) throw new SkillError("compiled_from must be an object with the utterance this skill came from");
  for (const key of Object.keys(from)) {
    if (!COMPILED_FROM_KEYS.includes(key)) throw unknownKeyError("compiled_from field", key);
  }
  if (typeof from.utterance !== "string" || from.utterance.length > MAX_UTTERANCE) {
    throw new SkillError(`compiled_from.utterance must be a string of at most ${MAX_UTTERANCE} characters`);
  }
  const steps = manifest.steps;
  if (!Array.isArray(steps)) throw new SkillError("steps must be an array of tool calls");
  if (steps.length < MIN_STEPS) {
    throw new SkillError(`a skill needs at least ${MIN_STEPS} steps — a single call is a tool call, not a program`);
  }
  if (steps.length > MAX_STEPS) throw new SkillError(`a skill may hold at most ${MAX_STEPS} steps`);
  steps.forEach((step, i) => {
    const where = `steps[${i}]`;
    if (!isPlainObject(step)) throw new SkillError(`${where} must be an object with exactly the keys ${STEP_KEYS.join(", ")}`);
    for (const key of Object.keys(step)) {
      if (!STEP_KEYS.includes(key)) throw unknownKeyError(`${where} field`, key);
    }
    if (typeof step.tool !== "string" || !step.tool.trim()) throw new SkillError(`${where}.tool must be a non-empty string`);
    if (!isPlainObject(step.args)) throw new SkillError(`${where}.args must be a plain JSON object`);
    validateArgs(step.args, `${where}.args`);
  });
  return deepFreeze({
    kind: manifest.kind,
    schema_version: manifest.schema_version,
    name: manifest.name,
    description: manifest.description ?? "",
    compiled_from: { utterance: from.utterance },
    steps: steps.map((step) => ({ tool: step.tool, args: step.args })),
  });
}
