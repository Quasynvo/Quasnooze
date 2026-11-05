/**
 * telemetry.js — a local record of what each turn actually did.
 *
 * "Local" is the whole point: one append-only NDJSON file in data/, readable
 * with `tail`, never sent anywhere. There was no instrumentation at all before,
 * so "it got slow" and "it lied to me" had no artefact to look at — and the
 * honesty guard's false-positive rate, which decides whether the guard survives
 * contact with real users, could not be measured.
 *
 * What is recorded per turn: duration, rounds, tool count, approximate tokens,
 * guard flags, error class, and — since the voice budget became enforceable —
 * a `stages` object saying *where* the turn spent its time. Not the message
 * text — a log of everything you ever asked is a second copy of your
 * conversations with none of the protections.
 */
import { appendFileSync, existsSync, statSync, renameSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

const FILE = join(config.dataDir, "telemetry.ndjson");
const ROTATE_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const RING = 200;

/**
 * The five stages of one spoken turn, in the order they happen.
 *
 * Every value is a duration in whole milliseconds. Two anchors are in play and
 * that is deliberate: a browser and a server do not share a clock, so pretending
 * they do would produce a number nobody could defend. The client stages are
 * offsets from its own turn start (the microphone opening); `firstTokenMs` is
 * offset from the moment the request reached this server, which is the only
 * instant both sides can agree on.
 *
 * `captureEndMs` is the utterance length, not a latency: it is here so a long
 * sentence is not mistaken for a slow turn. It therefore has no target, which is
 * why the docs table says so in words instead of inventing one.
 */
export const STAGES = Object.freeze(["captureEndMs", "endpointMs", "transcriptMs", "firstTokenMs", "firstAudioMs"]);

/**
 * The budget this instrumentation exists to hold. Targets come from the voice
 * roadmap: endpoint and final transcript after the speaker stops, first token on
 * a local model, and first audio from the end of speech. `docs/VOICE.md` carries
 * the same table and a test asserts the two agree — a budget that only lives in
 * a doc is a wish.
 */
export const VOICE_BUDGET = Object.freeze({
  captureEndMs: { targetMs: null, from: "microphone opened", to: "speaker stopped", note: "utterance length, the anchor the client stages are measured from" },
  endpointMs: { targetMs: 300, from: "speaker stopped", to: "endpoint decided (utterance closed, final transcript accepted)" },
  transcriptMs: { targetMs: 300, from: "endpoint decided", to: "request written to the server" },
  firstTokenMs: { targetMs: 700, from: "request reached the server", to: "first assistant text ready to write" },
  firstAudioMs: { targetMs: 1200, from: "speaker stopped", to: "first local audio started" },
});

/**
 * Coerce whatever a client sent into the stage object, or into nothing.
 *
 * Rules, in order of how much damage the alternative does:
 *   - unknown keys are dropped, so a bug in one client cannot widen the schema
 *     and cannot smuggle text into the log;
 *   - a missing or non-numeric mark is `null`, never `0`, because a fabricated
 *     zero is a perfect score;
 *   - a real `0` is kept, because "the fast path answered in under a millisecond"
 *     is a measurement and a bench that cannot say zero is a bench that lies.
 */
export function normalizeStages(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const stage of STAGES) {
    const value = source[stage];
    out[stage] = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  return out;
}

/** Merge marks into a stage object, first real mark wins. Never invents a zero. */
export function mergeStages(into, from) {
  for (const stage of STAGES) {
    if (into[stage] === null && Number.isFinite(from?.[stage])) into[stage] = Math.round(from[stage]);
  }
  return into;
}

/** The last few hundred records, kept in memory so /api/health is a read of RAM. */
const ring = [];
let loaded = false;

function loadTail() {
  if (loaded) return;
  loaded = true;

  // Open first, then fstat the descriptor. Asking the path how big it is and
  // then opening it is a check-then-use window: the file can change in between,
  // and the read offset is then computed from a size that is no longer true.
  let fd;
  try {
    fd = openSync(FILE, "r");
  } catch {
    return; // no file yet, which is the normal first run
  }
  try {
    const size = fstatSync(fd).size;
    if (!size) return;
    const start = Math.max(0, size - 64 * 1024);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // The first line is very likely a partial record after a tail read.
    for (const line of lines.slice(start === 0 ? 0 : 1).slice(-RING)) {
      try {
        ring.push(JSON.parse(line));
      } catch {
        /* a torn final line from a crash — skip it, it is not a fact */
      }
    }
  } catch {
    /* telemetry is never worth failing a turn over */
  } finally {
    try {
      closeSync(fd);
    } catch {}
  }
}

function rotate() {
  try {
    if (!existsSync(FILE) || statSync(FILE).size < ROTATE_BYTES) return;
    for (let i = KEEP; i > 1; i--) {
      const from = `${FILE}.${i - 1}`;
      const to = `${FILE}.${i}`;
      if (existsSync(from)) renameSync(from, to);
    }
    renameSync(FILE, `${FILE}.1`);
  } catch {
    /* if rotation fails we just keep appending */
  }
}

/** Record one turn. Never throws: instrumentation must not break the product. */
export function record(event) {
  const entry = { at: new Date().toISOString(), ...event };
  // Normalise at the door. Every other layer can be careless about shape; this
  // one cannot, because this is the object that reaches the disk.
  if (Object.hasOwn(event, "stages")) entry.stages = normalizeStages(event.stages);
  ring.push(entry);
  if (ring.length > RING) ring.shift();
  try {
    rotate();
    appendFileSync(FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    /* a full disk is the user's problem, not this turn's */
  }
  return entry;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

/**
 * Per-stage p50/p95 over the records that actually carry that stage.
 *
 * The sample count is part of the answer, not a detail: a p95 over four turns is
 * four turns, and a reader who cannot see that will believe the number. A stage
 * with no samples reports `null` percentiles rather than zeroes for the same
 * reason a missing mark does.
 */
export function stageStats(records) {
  const rows = Array.isArray(records) ? records : null;
  const source = rows ?? (loadTail(), ring);
  const out = {};
  for (const stage of STAGES) {
    const budget = VOICE_BUDGET[stage];
    const values = [];
    for (const record of source) {
      if (record?.kind !== "turn") continue;
      const value = record.stages?.[stage];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) values.push(value);
    }
    values.sort((a, b) => a - b);
    out[stage] = {
      samples: values.length,
      p50: pct(values, 50),
      p95: pct(values, 95),
      targetMs: budget.targetMs,
      // How often the budget was missed. A target nobody counts against is a
      // slogan; this is the count.
      overTarget: budget.targetMs === null ? null : values.filter((value) => value > budget.targetMs).length,
      from: budget.from,
      to: budget.to,
    };
  }
  return out;
}

/** The block `quasnooze health --json` prints. Local measurements, one machine. */
export function latencyReport() {
  loadTail();
  return {
    source: "data/telemetry.ndjson (in-memory ring of the last 200 records)",
    scope: "local measurements from this machine; not a cross-device benchmark",
    stages: stageStats(),
  };
}

/**
 * A summary small enough to sit in /api/health.
 *
 * p50/p95 of the last turns, plus the two rates that matter operationally: how
 * often a turn errors, and how often the honesty guard raises a flag (a number
 * that is worthless if it is always 0 and useless if it is always 1).
 */
export function stats() {
  loadTail();
  const turns = ring.filter((r) => r.kind === "turn");
  if (!turns.length) return { turns: 0 };

  const durations = turns.map((t) => t.ms).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const guards = turns.filter((t) => (t.guardFlags || 0) > 0).length;
  const errors = turns.filter((t) => t.error).length;

  return {
    turns: turns.length,
    p50Ms: pct(durations, 50),
    p95Ms: pct(durations, 95),
    errorRate: Number((errors / turns.length).toFixed(3)),
    guardFlagRate: Number((guards / turns.length).toFixed(3)),
    avgRounds: Number((turns.reduce((n, t) => n + (t.rounds || 0), 0) / turns.length).toFixed(2)),
    // How many shell commands ran without a prompt because the risk tier proved
    // them read-only. If this stays 0, the tiers are off or unused; if it equals
    // total tool calls, something is wrong with the classifier.
    autoTotal: turns.reduce((n, t) => n + (t.auto || 0), 0),
    avgTokens: Math.round(turns.reduce((n, t) => n + (t.tokens || 0), 0) / turns.length),
    // Where the turn spent its time. Same turns, five rows, each with its own
    // sample count — see stageStats() for why the count travels with the number.
    stages: stageStats(turns),
  };
}

/** For tests and for anyone who wants to start clean. */
export function reset() {
  ring.length = 0;
  loaded = true;
}

export const TELEMETRY_FILE = FILE;
