/**
 * src/agent/ledger.js — the append-only run ledger (issue #145, seeded for F08).
 *
 * One line per event, JSON, inside <data>/ like every other piece of state,
 * mode 0600. The ledger records what happened to a run — drift, repair, stop —
 * with the before/after state at the moment it happened, never a summary
 * written later. Nothing here can approve, run, or undo anything; it is the
 * record the owner reads to answer "what actually happened?".
 *
 * F08 writes drift events here (skill replay found the world different from
 * what the compiled step assumed). #145 grows the same file into the full
 * task ledger; the format is one JSON object per line so later writers cannot
 * invalidate earlier ones.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const LEDGER_FILE = join(config.dataDir, "ledger.jsonl");
const MAX_LINE = 4_096;

/** Append one event. The event is frozen with a timestamp; throws never
 *  bubble into a run — a broken ledger must not stop honest work — but a
 *  write that fails is visible on the next read (the line is absent). */
export function recordLedgerEvent(event) {
  const record = Object.freeze({
    at: new Date().toISOString(),
    ...event,
  });
  const line = JSON.stringify(record);
  if (line.length <= MAX_LINE) {
    try {
      appendFileSync(LEDGER_FILE, `${line}\n`, { mode: 0o600 });
    } catch {
      /* the ledger is a record, not a dependency */
    }
  }
  return record;
}

/** Read events back, newest last. `kind` filters (e.g. "drift", "repair"). */
export function ledgerEvents({ kind = null, limit = 200 } = {}) {
  let raw = "";
  try {
    raw = readFileSync(LEDGER_FILE, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (kind === null || event.kind === kind) out.push(event);
    } catch {
      /* a torn last line is a crash, not corruption of what came before */
    }
  }
  return out.slice(-Math.max(1, limit));
}
