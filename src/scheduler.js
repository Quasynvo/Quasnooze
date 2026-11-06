/**
 * scheduler.js — wakes up at the right second and says the thing.
 *
 * Deliberately dumb and durable: one timer, a scan of reminders.json, a
 * deliver-and-mark loop. If the machine was asleep when a reminder was due,
 * it fires on the next tick and says it was late rather than pretending the
 * time is still then.
 */
import { pendingReminders, updateReminder, loadSchedules, updateSchedule } from "./store.js";
import { runScout, formatScoutDigest } from "./agent/scout.js";
import { dueSchedules, markRun } from "./schedules.js";
import { sendTo } from "./outbound.js";
import { formatClock } from "./timeparse.js";
import { config } from "./config.js";

const TICK_MS = 15_000;
const LATE_GRACE_MS = 60_000;

let timer = null;
let log = console;

let inFlight = false;

export async function tick(now = new Date(), { scoutFetch } = {}) {
  // setInterval does not wait for the previous tick. A channel that takes
  // longer than 15 s to accept a message (a Telegram retry, a WhatsApp
  // reconnect) used to let the next tick see the same reminder still pending —
  // and deliver it again, because `fired` is only written after the send.
  if (inFlight) return 0;
  inFlight = true;
  try {
    return await deliverDue(now, { scoutFetch });
  } finally {
    inFlight = false;
  }
}

async function deliverDue(now, { scoutFetch } = {}) {
  const reminders = await deliverReminders(now);
  const runs = await runSchedules(now, { scoutFetch });
  return reminders + runs;
}

/**
 * Fire every schedule that is due.
 *
 * Each one is an agent turn with autonomy: "unattended" — no approvals, and
 * every dangerous tool is refused. The transcript is written to its own session
 * so "what did it do at 3am" has an answer, and the answer is delivered to the
 * channel the schedule was created from.
 */
async function runSchedules(now, { scoutFetch } = {}) {
  if (config.scheduledRuns === false) return 0;
  let ran = 0;

  for (const schedule of dueSchedules(now)) {
    if (schedule.kind === "scout") {
      await runScheduledScout(schedule, now, scoutFetch);
      ran++;
      continue;
    }
    const sessionId = `sched-${schedule.id}`;
    const started = Date.now();
    let report;
    let ok = true;

    try {
      const { runAgent } = await import("./agent.js");
      const result = await runAgent({
        sessionId,
        text: schedule.task,
        channel: schedule.channel || "web",
        target: schedule.address,
        autonomy: "unattended",
        allowSchedule: false,
      });
      report = result.text;
    } catch (err) {
      ok = false;
      report = `✦ That scheduled task failed: ${err.message}`;
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    const header = `⏱️ **Scheduled · ${schedule.cadence?.label || schedule.when}** — ${schedule.task}\n\n`;
    const footer = `\n\n_(run #${(schedule.runs || 0) + 1}, ${seconds}s${ok ? "" : ", failed"}; tools needing approval were refused)_`;

    const delivery = await sendTo(schedule.address, header + report + footer);
    if (!delivery.ok) {
      log.warn?.(`schedule ${schedule.id}: could not deliver to ${schedule.address} (${delivery.error})`);
      await sendTo("web:main", header + report + footer);
    }

    // Marked after delivery, so a crash mid-run tries again next tick rather
    // than silently skipping a day.
    markRun(schedule.id, now, schedule.timeZone);
    log.info?.(`scheduled run: ${schedule.task}`);
    ran++;
  }
  return ran;
}

// Scout never calls the agent, tools, MCP or a model. Delivery is the only
// write outside local state, and goes only to the exact owner-selected address.
async function runScheduledScout(schedule, now, fetchSource) {
  const isCurrent = () => {
    const current = loadSchedules().find(s => s.id === schedule.id);
    return Boolean(current && current.enabled !== false && current.address === schedule.address && JSON.stringify(current.scout) === JSON.stringify(schedule.scout));
  };
  const result = await runScout(schedule, { ...(fetchSource ? { fetchSource } : {}), isCurrent });
  const current = loadSchedules().find(s => s.id === schedule.id);
  // A deletion/disable/configuration change during I/O must not send or commit.
  if (!isCurrent() || result.status === 'cancelled') return;
  let delivery = null;
  if (result.updates.length || result.failures.length) delivery = await sendTo(current.address, formatScoutDigest(result, now));
  const still = loadSchedules().find(s => s.id === schedule.id);
  if (!isCurrent()) return;
  const delivered = delivery?.ok === true;
  const receipt = { at: now.toISOString(), status: delivery && !delivered ? 'delivery_failed' : result.status, fetched: Object.keys(result.fingerprints).length, updates: result.updates.length, failures: result.failures.length, egress: result.status === 'disabled' ? 'none' : 'remote HTTPS GET', delivered };
  const state = still.scout && typeof still.scout === 'object' && !Array.isArray(still.scout) ? still.scout : {};
  const fingerprints = (!result.updates.length || delivered) ? { ...(state.fingerprints || {}), ...result.fingerprints } : (state.fingerprints || {});
  // Keep only hashes for currently configured endpoints.
  const sources = Array.isArray(state.sources) ? state.sources.slice(0, 5) : [];
  const bounded = Object.fromEntries(sources.filter(url => typeof url === 'string' && typeof fingerprints[url] === 'string').map(url => [url, fingerprints[url]]));
  updateSchedule(still.id, { scout: { ...state, fingerprints: bounded, lastReceipt: receipt } });
  markRun(still.id, now, still.timeZone);
}

async function deliverReminders(now) {
  const due = pendingReminders().filter((r) => new Date(r.at).getTime() <= now.getTime());
  for (const reminder of due) {
    const lateBy = now.getTime() - new Date(reminder.at).getTime();
    const late = lateBy > LATE_GRACE_MS
      ? ` _(late by ${Math.round(lateBy / 60000)} min — the machine was probably asleep)_`
      : "";
    const message = `⏰ **Reminder:** ${reminder.text}${late}`;

    let delivery = { ok: false, error: "no address" };
    if (reminder.address) delivery = await sendTo(reminder.address, message);

    if (!delivery.ok) {
      // Fall back to whatever channel is alive rather than dropping it.
      log.warn?.(`reminder ${reminder.id}: could not deliver to ${reminder.address} (${delivery.error})`);
      await sendTo("web:main", `${message}\n\n_(could not reach ${reminder.address || "the original channel"})_`);
    }
    updateReminder(reminder.id, { fired: true, firedAt: now.toISOString(), delivered: delivery.ok });
    log.info?.(`reminder fired: ${reminder.text}`);
  }
  return due.length;
}

export function startScheduler(logger = console) {
  log = logger;
  if (timer) {
    return {
      stop: () => {
        clearInterval(timer);
        timer = null;
      },
    };
  }
  timer = setInterval(() => {
    tick().catch((err) => log.warn?.(`scheduler: ${err.message}`));
  }, TICK_MS);
  timer.unref?.();
  // Catch up immediately: a reminder that came due while Quasnooze was off.
  tick().catch(() => {});
  // Soonest first — pendingReminders() is insertion order, so [0] was
  // whichever reminder was created first, not whichever fires first.
  const next = pendingReminders().sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
  if (next) log.info?.(`scheduler: ${pendingReminders().length} reminder(s), next at ${formatClock(new Date(next.at), config.timezone)}`);
  return {
    stop: () => {
      clearInterval(timer);
      timer = null;
    },
  };
}
