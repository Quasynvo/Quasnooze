/**
 * killswitch.js — one file on disk that stops every tool.
 *
 * An agent that can shell, write files and talk to MCP needs a way to freeze
 * without a restart. This is that way: a JSON latch in data/, owner-written,
 * process-readable. While it is armed, tool execution returns a typed refusal
 * and never reaches `run()`. Approvals already in flight still resolve as
 * denials at the gate; they cannot sneak past a latch that was armed after
 * they were shown.
 *
 * The model cannot arm or disarm this. Only the owner (CLI, env, HTTP with
 * the access key) can. That is the whole point of an incident control.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.js";

const FILE = () => join(config.dataDir, "killswitch.json");

function empty() {
  return { armed: false, reason: null, at: null, by: null };
}

export function killswitchPath() {
  return FILE();
}

export function readKillswitch() {
  const path = FILE();
  if (!existsSync(path)) return empty();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty();
    return {
      armed: raw.armed === true,
      reason: typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim().slice(0, 400) : null,
      at: typeof raw.at === "string" ? raw.at : null,
      by: typeof raw.by === "string" ? raw.by.slice(0, 80) : null,
    };
  } catch {
    // A corrupt latch must fail closed: treat as armed so a half-written
    // incident file cannot leave tools runnable.
    return { armed: true, reason: "killswitch.json unreadable — failing closed", at: null, by: "parser" };
  }
}

export function isArmed() {
  if (/^(1|true|yes|on)$/i.test(String(process.env.QUASNOOZE_KILL_SWITCH || ""))) return true;
  return readKillswitch().armed === true;
}

function atomicWrite(path, obj) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function armKillswitch({ reason = "owner freeze", by = "owner" } = {}) {
  const state = {
    armed: true,
    reason: String(reason || "owner freeze").slice(0, 400),
    at: new Date().toISOString(),
    by: String(by || "owner").slice(0, 80),
  };
  atomicWrite(FILE(), state);
  return state;
}

export function disarmKillswitch({ by = "owner" } = {}) {
  const state = { armed: false, reason: null, at: new Date().toISOString(), by: String(by || "owner").slice(0, 80) };
  atomicWrite(FILE(), state);
  return state;
}

/** Refusal text fed back to the model. Never looks like a successful tool. */
export function freezeMessage(state = readKillswitch()) {
  const why = state.reason || "owner freeze";
  return `Refused: kill switch is armed (${why}). No tool may run until the owner disarms it.`;
}
