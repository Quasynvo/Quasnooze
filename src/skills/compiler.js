/**
 * src/skills/compiler.js — conversation → verified, replayable program.
 *
 * The input is one turn's recorded outcomes: the user's utterance and the
 * tool calls the agent actually made, with their results and independent
 * read-backs. Only a turn that *succeeded* compiles: every call applied, no
 * contradiction, nothing denied. A skill is the memory of work that was
 * already done and checked — not a wish list of what to try next time.
 *
 * Compilation cannot widen anything (plan-is-not-authority):
 *   - only tools in the current registry may appear (a skill cannot invent
 *     or grant tools);
 *   - shell commands must pass today's risk screen to compile at all;
 *   - required arguments per the tool's schema must be present;
 *   - the manifest schema carries no permission fields (manifest.js refuses
 *     them by name).
 * At replay, every step is re-checked against *current* policy again
 * (replay.js) — the recorded tier is not trusted, because policy moves.
 */
import { TOOL_MAP } from "../tools.js";
import { classifyCommand, BLOCKED } from "../risk.js";
import {
  SkillError,
  SKILL_KIND,
  SKILL_SCHEMA_VERSION,
  MIN_STEPS,
  MAX_STEPS,
  validateSkill,
} from "./manifest.js";

/**
 * Compile one successful multi-step turn into a skill manifest.
 *
 * @param {object} input
 * @param {string} input.name skill name (lowercase letters, digits, dashes)
 * @param {string} [input.description]
 * @param {string} [input.utterance] the user request the turn answered
 * @param {Array<{tool: string, args: object, result?: {ok?: boolean}, denied?: boolean, verification?: {status?: string}|null}>} input.calls
 *   the turn's recorded tool outcomes, in the order they ran
 * @returns {object} a deep-frozen, validated manifest
 */
export function compileSkill({ name, description = "", utterance = "", calls = [] } = {}) {
  if (!Array.isArray(calls)) throw new SkillError("calls must be the turn's recorded tool outcomes, in order");
  if (calls.length < MIN_STEPS) {
    throw new SkillError(
      `a skill compiles from a successful multi-step turn — at least ${MIN_STEPS} tool calls, found ${calls.length}`,
    );
  }
  if (calls.length > MAX_STEPS) {
    throw new SkillError(`a turn of ${calls.length} calls is too long to compile — a skill holds at most ${MAX_STEPS} steps`);
  }

  const steps = calls.map((call, i) => {
    const where = `call ${i + 1}`;
    const toolName = String(call?.tool ?? "");
    const tool = TOOL_MAP.get(toolName);
    if (!tool) {
      throw new SkillError(`${where}: "${toolName}" is not a tool in the current registry — a skill cannot invent tools`);
    }
    if (call?.denied) {
      throw new SkillError(`${where} (${toolName}) was denied in the recorded turn — refused work does not compile into a skill`);
    }
    if (!call?.result || call.result.ok !== true) {
      throw new SkillError(`${where} (${toolName}) did not succeed in the recorded turn — only successful work compiles`);
    }
    if (call?.verification?.status === "contradicted") {
      throw new SkillError(
        `${where} (${toolName}) was contradicted by its read-back in the recorded turn — a contradicted step must never become a skill`,
      );
    }
    const args = call.args ?? {};
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      throw new SkillError(`${where} (${toolName}): arguments must be a plain JSON object`);
    }
    // Required-argument check against the tool's own schema: a recorded call
    // always satisfied it, so a mismatch means this manifest was assembled by
    // hand from something that never ran.
    const required = Array.isArray(tool.parameters?.required) ? tool.parameters.required : [];
    for (const key of required) {
      if (!(key in args)) throw new SkillError(`${where} (${toolName}): missing required argument "${key}"`);
    }
    if (toolName === "shell") {
      const verdict = classifyCommand(String(args.command ?? ""), {});
      if (verdict.tier === BLOCKED) {
        throw new SkillError(
          `${where}: refused to compile a blocked command (${verdict.why}) — a skill may not remember what the screen will not run`,
        );
      }
    }
    // JSON round-trip: the recorded arguments, exactly as recorded — key
    // order and values preserved (JSON.parse(JSON.stringify) keeps both).
    // The byte-identity contract at replay compares against this form.
    return { tool: toolName, args: JSON.parse(JSON.stringify(args)) };
  });

  return validateSkill({
    kind: SKILL_KIND,
    schema_version: SKILL_SCHEMA_VERSION,
    name: String(name ?? ""),
    description: String(description ?? ""),
    compiled_from: { utterance: String(utterance ?? "") },
    steps,
  });
}
