#!/usr/bin/env node
/**
 * roadmap-queue.js — pure queue selection; network writes stay in the workflow.
 *
 * The board is allowed to be quiet. It is not allowed to be quiet for a reason
 * nobody can see, which is the state this file was in: an issue would be filed,
 * merged and closed, the manifest would keep saying `ready`, and every future
 * item that depended on it would wait for a `shipped` status that no one was
 * ever going to write. The queue looked full of work and filed nothing.
 *
 * Two rules come out of that:
 *
 *   1. CLOSED IS SHIPPED. A dependency is satisfied by the manifest saying so,
 *      or by an issue carrying that item's marker being closed. The manifest is
 *      a reviewed document and moves at review speed; the issue tracker is the
 *      record of what happened. When they disagree, the record wins.
 *   2. REFUSALS EXPLAIN THEMSELVES. Every item the queue skips can name the one
 *      gate holding it. `queueReport()` exists so the status issue and the run
 *      summary can say "next item opens 2026-11-10" instead of "no eligible
 *      item", which reads like the project is finished.
 *
 * The selection order, caps and gates are unchanged: ready before backlog,
 * `auto_file: false` is a maintainer veto, `not_before` is a UTC calendar date,
 * and an item whose issue was ever opened is never filed twice.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_SECTIONS = [
  "## Context",
  "## Acceptance criteria",
  "## How to verify",
  "## Time estimate",
];

const marker = (body) =>
  [...String(body || "").matchAll(/<!-- roadmap:([^\s]+) -->/g)].map((match) => match[1]);

const stateOf = (issue) => String(issue.state ?? "").toLowerCase();

export function isContributorIssue(issue) {
  if (issue.pull_request || stateOf(issue) !== "open") return false;
  const labels = (issue.labels || []).map((label) =>
    typeof label === "string" ? label : label.name,
  );
  return (
    marker(issue.body).length > 0 ||
    String(issue.body || "").includes("<!-- growth:fingerprint:") ||
    labels.some((label) => ["growth", "help wanted", "good first issue"].includes(label))
  );
}

export function countContributorIssues(issues) {
  return issues.filter(isContributorIssue).length;
}

/** Items the tracker says are finished: closed, non-PR issues carrying a marker. */
export function closedEvidence(issues) {
  const closed = new Set();
  for (const issue of issues) {
    if (issue.pull_request || stateOf(issue) !== "closed") continue;
    for (const id of marker(issue.body)) closed.add(id);
  }
  return closed;
}

/** Valid, today-or-earlier UTC calendar date. Anything else fails closed. */
function isOpenDate(value, today) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value &&
    value <= today
  );
}

/**
 * Why this item cannot be filed today, or null if it can.
 * Returned strings are shown to humans, so they name the gate rather than a code.
 */
function gateReason(item, { today, shipped, todayOf }) {
  if (item.auto_file === false) return { reason: "maintainer approval required", kind: "manual" };

  if (item.not_before !== undefined) {
    if (!isOpenDate(item.not_before, today)) {
      return {
        reason: `opens ${String(item.not_before).slice(0, 10)}`,
        kind: "schedule",
        date: typeof item.not_before === "string" ? item.not_before.slice(0, 10) : null,
      };
    }
  }

  if (item.depends_on !== undefined) {
    if (
      !Array.isArray(item.depends_on) ||
      !item.depends_on.every((id) => typeof id === "string")
    ) {
      return { reason: "invalid dependency list", kind: "dependency" };
    }
    const unmet = item.depends_on.filter((id) => !shipped.has(id));
    if (unmet.length) {
      return { reason: `waiting on ${unmet.join(", ")}`, kind: "dependency" };
    }
  }

  if (
    !REQUIRED_SECTIONS.every((section) => String(item.body || "").includes(section)) ||
    !item.files?.length ||
    !item.verify
  ) {
    return { reason: "incomplete issue body", kind: "incomplete" };
  }

  return null;
}

export function selectQueue(roadmap, issues, today = new Date().toISOString().slice(0, 10)) {
  const history = issues.filter((issue) => !issue.pull_request);
  const seen = new Set(history.flatMap((issue) => marker(issue.body)));
  const open = history.filter((issue) => stateOf(issue) === "open" && marker(issue.body).length);
  const items = roadmap.items || [];

  let count = countContributorIssues(history);
  let easy = open.filter((issue) =>
    marker(issue.body).some((id) =>
      items.some((item) => item.id === id && item.difficulty === "easy"),
    ),
  ).length;

  const totalCap = roadmap.meta?.open_curated_cap ?? 4;
  const easyCap = roadmap.meta?.open_easy_cap ?? 3;
  const shipped = new Set([
    ...items.filter((item) => item.status === "shipped").map((item) => item.id),
    ...closedEvidence(history),
  ]);

  const picked = [];
  for (const status of ["ready", "backlog"]) {
    for (const item of items) {
      if (item.status !== status || item.auto_file === false || seen.has(item.id)) continue;
      if (gateReason(item, { today, shipped }) !== null) continue;
      if (count >= totalCap || (item.difficulty === "easy" && easy >= easyCap)) continue;
      picked.push(item);
      seen.add(item.id);
      count++;
      if (item.difficulty === "easy") easy++;
    }
  }
  return picked;
}

/**
 * The queue's own account of itself: what would file now, what each refused item
 * is waiting for, and the soonest date any of them opens.
 *
 * `blocked` is the part that matters. A board with four open issues and no
 * explanation looks identical to a board with nothing left to do; this makes the
 * difference visible in one line per reason.
 */
export function queueReport(
  roadmap,
  issues,
  today = new Date().toISOString().slice(0, 10),
) {
  const history = issues.filter((issue) => !issue.pull_request);
  const seen = new Set(history.flatMap((issue) => marker(issue.body)));
  const items = roadmap.items || [];
  const shipped = new Set([
    ...items.filter((item) => item.status === "shipped").map((item) => item.id),
    ...closedEvidence(history),
  ]);

  const openContributor = countContributorIssues(history);
  const totalCap = roadmap.meta?.open_curated_cap ?? 4;
  const easyCap = roadmap.meta?.open_easy_cap ?? 3;

  const fileable = selectQueue(roadmap, issues, today);
  const blocked = [];
  const dates = [];
  for (const item of items) {
    if (item.status === "shipped" || seen.has(item.id)) continue;
    if (item.status !== "ready" && item.status !== "backlog") continue;
    const gate = gateReason(item, { today, shipped });
    if (!gate) continue;
    blocked.push({ id: item.id, kind: gate.kind, reason: gate.reason });
    if (gate.date && gate.date > today) dates.push(gate.date);
  }
  dates.sort();

  return {
    today,
    openContributorIssues: openContributor,
    totalCap,
    easyCap,
    slots: Math.max(0, totalCap - openContributor),
    fileable: fileable.map((item) => item.id),
    blocked,
    blockedByKind: blocked.reduce((acc, b) => {
      acc[b.kind] = (acc[b.kind] || 0) + 1;
      return acc;
    }, {}),
    nextGate: dates[0] || null,
    nextGateCount: dates.filter((date) => date === dates[0]).length,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const [manifest, history, today] = args;
  if (!manifest || !history) {
    console.error(
      "usage: node scripts/roadmap-queue.js MANIFEST HISTORY.json [YYYY-MM-DD] [--report]",
    );
    process.exit(2);
  }
  const roadmap = JSON.parse(readFileSync(manifest, "utf8"));
  const issues = JSON.parse(readFileSync(history, "utf8"));
  const stamp = today || undefined;
  if (process.argv.includes("--report")) {
    console.log(JSON.stringify(queueReport(roadmap, issues, stamp), null, 2));
  } else {
    console.log(JSON.stringify(selectQueue(roadmap, issues, stamp)));
  }
}
