#!/usr/bin/env node
/**
 * reconcile-roadmap.js — make the manifest agree with the issue tracker.
 *
 * The contributor queue depends on `"status": "shipped"` to know a prerequisite
 * is done. Nothing was writing that field. Twenty items had been implemented and
 * closed, the manifest still called most of them `ready` or `backlog`, and every
 * future item that listed one of them in `depends_on` was waiting for a status
 * only a human remembered to write by hand.
 *
 * This derives it instead. A closed non-PR issue carrying `<!-- roadmap:ID -->`
 * is evidence that the item shipped; the earliest such issue is recorded as the
 * item's `issue`, and its close date as `shipped_at`. That is the same rule the
 * status board already used to draw its progress bar — it just never wrote the
 * answer down.
 *
 * What it deliberately does not do:
 *
 *   - **It never regresses.** A `shipped` item with no closed issue stays
 *     shipped: releases are a human decision and a reopened tracker is not
 *     evidence that a shipped feature was unshipped.
 *   - **It never invents work.** No item is created, promoted to `ready`, or
 *     rewritten. Only `status`, `issue`, and `shipped_at` are touched.
 *   - **It never pushes.** `--write` edits the file; opening a PR is a
 *     separate step, so a human still reviews every manifest change.
 *
 * Usage:
 *   node scripts/reconcile-roadmap.js --issues-json all.json            # report
 *   node scripts/reconcile-roadmap.js --issues-json all.json --write    # apply
 *   node scripts/reconcile-roadmap.js --issues-json all.json --check    # exit 1 on drift
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARKER_RE = /<!-- roadmap:([^\s]+) -->/g;

const argValue = (argv, flag, fallback = "") => {
  const index = argv.indexOf(flag);
  return index !== -1 && index + 1 < argv.length ? argv[index + 1] : fallback;
};

const ids = (body) => [...String(body || "").matchAll(MARKER_RE)].map((match) => match[1]);

/** `2026-11-04T20:13:17Z` → `2026-11-04`. Anything else is dropped, not guessed. */
function closedDate(issue) {
  const raw = issue.closedAt ?? issue.closed_at ?? "";
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? String(raw).slice(0, 10) : null;
}

/**
 * Pure: returns the reconciled roadmap plus what changed. Exported so the test
 * can assert the rules without running a CLI or touching the working tree.
 */
export function reconcile(roadmap, issues) {
  const doc = JSON.parse(JSON.stringify(roadmap));
  const byId = new Map();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    for (const id of ids(issue.body)) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(issue);
    }
  }

  const shipped = [];
  const linked = [];
  for (const item of doc.items || []) {
    const found = byId.get(item.id) || [];
    const closed = found
      .filter((issue) => String(issue.state || "").toLowerCase() === "closed")
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
    const open = found
      .filter((issue) => String(issue.state || "").toLowerCase() === "open")
      .sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

    if (closed.length) {
      const first = closed[0];
      if (item.status !== "shipped") {
        item.status = "shipped";
        shipped.push({ id: item.id, issue: first.number, title: item.title });
      }
      if (Number.isFinite(first.number) && item.issue !== first.number) item.issue = first.number;
      const date = closedDate(first);
      if (date && item.shipped_at !== date) item.shipped_at = date;
      continue;
    }

    // Still open: record which issue is doing the work, so the next reader does
    // not have to grep the tracker. Status is left exactly as a human set it.
    if (open.length && Number.isFinite(open[0].number) && item.issue !== open[0].number) {
      item.issue = open[0].number;
      linked.push({ id: item.id, issue: open[0].number });
    }
  }
  return { roadmap: doc, shipped, linked };
}

/** Drift is "the tracker finished this and the manifest disagrees", nothing else. */
export function drift(roadmap, issues) {
  const reconciled = reconcile(roadmap, issues);
  return reconciled.shipped;
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const issuesFile = argValue(argv, "--issues-json");
  const manifestPath = resolve(argValue(argv, "--manifest", join(ROOT, ".github/roadmap.json")));
  const write = argv.includes("--write");
  const check = argv.includes("--check");

  if (!issuesFile || !existsSync(issuesFile)) {
    console.error("usage: node scripts/reconcile-roadmap.js --issues-json FILE [--write|--check]");
    process.exit(2);
  }

  const roadmap = JSON.parse(readFileSync(manifestPath, "utf8"));
  const issues = JSON.parse(readFileSync(issuesFile, "utf8"));
  const { roadmap: next, shipped, linked } = reconcile(roadmap, issues);

  if (check) {
    for (const item of shipped) {
      console.error(`✖ ${item.id} shipped as #${item.issue} but the manifest says otherwise`);
    }
    if (shipped.length) {
      console.error(
        `\n${shipped.length} item(s) are finished in the tracker and unfinished in the manifest.`,
      );
      console.error("Run: node scripts/reconcile-roadmap.js --issues-json … --write");
      process.exit(1);
    }
    console.log("✓ the manifest agrees with the issue tracker");
  } else {
    for (const item of shipped) console.log(`shipped  ${item.id}  (#${item.issue})`);
    for (const item of linked) console.log(`linked   ${item.id}  (#${item.issue}, still open)`);
    console.log(
      `\n${shipped.length} newly shipped, ${linked.length} linked to an open issue, ` +
        `${(next.items || []).filter((item) => item.status === "shipped").length}/${(next.items || []).length} shipped in total`,
    );
    if (write && shipped.length) {
      writeJson(manifestPath, next);
      console.log(`wrote ${manifestPath}`);
    } else if (write) {
      console.log("nothing to write");
    } else if (shipped.length) {
      console.log("dry run — pass --write to update the manifest");
    }
  }
}
