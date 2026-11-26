/**
 * metrics.js — the arithmetic behind the numbers we print.
 *
 * `braincheck` reports throughput, and its first version got the unit wrong:
 * it divided words by *milliseconds* and multiplied by 60000, which is words
 * per minute-of-milliseconds — 60× too high. On this machine that turned a
 * real ~12 words/s into "~757 words/s", i.e. a CPU-only laptop reporting
 * datacentre numbers on the one line the script exists to provide ("how fast
 * is it"). A number nobody can trust is worse than no number, so the formula
 * lives here with tests rather than inline in a script.
 */

/** Words per second from a finished reply and the wall-clock milliseconds. */
export function wordsPerSecond(text, ms) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
  if (!words) return 0;
  // A zero or negative elapsed time is a stopwatch error, not infinite speed.
  const elapsed = Number.isFinite(Number(ms)) && Number(ms) > 0 ? Number(ms) : 1;
  return Math.round((words / elapsed) * 1000);
}
