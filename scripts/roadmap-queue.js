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
 *      summary can say "waiting on reason-01-plan-verify" instead of "no
 *      eligible item", which reads like the project is finished.
 *
 * There are no dates in this file, on purpose. An item opens when the work it
 * depends on is closed, not when a calendar says it may be discussed — a date
 * gate made the board look finished while it held sixty specified tasks, and
 * made "when does this start?" a question about a schedule rather than about
 * the project. Ordering is `depends_on`; refusal is `auto_file: false`; and an
 * item whose issue was ever opened is never filed twice.
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

/**
 * Why this item cannot be filed, or null if it can.
 * Returned strings are shown to humans, so they name the gate rather than a code.
 *
 * A `not_before` date is deliberately not consulted. The field is rejected by
 * scripts/validate-roadmap.js so the manifest cannot carry an ordering rule the
 * queue ignores; an item waits for work, never for a day.
 */
function gateReason(item, { shipped }) {
  if (item.auto_file === false) return { reason: "maintainer approval required", kind: "manual" };

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

export function selectQueue(roadmap, issues) {
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
      if (gateReason(item, { shipped }) !== null) continue;
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
 * The queue's own account of itself: what would file now and what each refused
 * item is waiting for.
 *
 * `blocked` is the part that matters. A board with four open issues and no
 * explanation looks identical to a board with nothing left to do; this makes the
 * difference visible in one line per reason.
 */
export function queueReport(roadmap, issues) {
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

  const fileable = selectQueue(roadmap, issues);
  const blocked = [];
  for (const item of items) {
    if (item.status === "shipped" || seen.has(item.id)) continue;
    if (item.status !== "ready" && item.status !== "backlog") continue;
    const gate = gateReason(item, { shipped });
    if (!gate) continue;
    blocked.push({ id: item.id, kind: gate.kind, reason: gate.reason });
  }
  // Nothing is waiting for a date, so the only thing that can explain a quiet
  // board is a dependency or a veto — and both name the item responsible.
  const waitingOn = {};
  for (const item of items) {
    if (item.status === "shipped" || seen.has(item.id)) continue;
    for (const id of Array.isArray(item.depends_on) ? item.depends_on : []) {
      if (!shipped.has(id)) waitingOn[id] = (waitingOn[id] || 0) + 1;
    }
  }

  return {
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
    // The bottleneck, not a schedule: which unbuilt items the queue is waiting on.
    waitingOn: Object.entries(waitingOn)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([id, count]) => ({ id, unlocks: count })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const [manifest, history] = args;
  if (!manifest || !history) {
    console.error("usage: node scripts/roadmap-queue.js MANIFEST HISTORY.json [--report]");
    process.exit(2);
  }
  const roadmap = JSON.parse(readFileSync(manifest, "utf8"));
  const issues = JSON.parse(readFileSync(history, "utf8"));
  if (process.argv.includes("--report")) {
    console.log(JSON.stringify(queueReport(roadmap, issues), null, 2));
  } else {
    console.log(JSON.stringify(selectQueue(roadmap, issues)));
  }
}
