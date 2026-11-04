/**
 * roadmap-reconcile.test.js — the manifest is a claim; the tracker is the record.
 *
 * Written because this repository shipped twenty roadmap items and marked three.
 * Every dependent item gates on `"status": "shipped"`, nothing wrote that field,
 * and the queue sat on a board that looked finished. These tests pin the two
 * rules that keep it from happening again: closure is evidence, and reconcile
 * only ever moves an item forward.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { reconcile, drift } from "../scripts/reconcile-roadmap.js";

const item = (id, over = {}) => ({ id, title: id, status: "backlog", ...over });
const issue = (id, number, over = {}) => ({
  number,
  state: "closed",
  body: `<!-- roadmap:${id} -->`,
  closedAt: "2026-11-04T12:00:00Z",
  ...over,
});

test("a closed issue marks its item shipped, with the issue number and close date", () => {
  const roadmap = { items: [item("a"), item("b")] };
  const { roadmap: next, shipped } = reconcile(roadmap, [issue("a", 41)]);
  assert.deepEqual(shipped.map((s) => s.id), ["a"]);
  const a = next.items.find((i) => i.id === "a");
  assert.equal(a.status, "shipped");
  assert.equal(a.issue, 41);
  assert.equal(a.shipped_at, "2026-11-04");
  // untouched
  assert.equal(next.items.find((i) => i.id === "b").status, "backlog");
});

test("it never regresses: shipped stays shipped with no closed issue", () => {
  const roadmap = { items: [item("a", { status: "shipped" })] };
  const { roadmap: next, shipped } = reconcile(roadmap, []);
  assert.equal(next.items[0].status, "shipped");
  assert.deepEqual(shipped, []);
});

test("an open issue is recorded without changing the status a human set", () => {
  const roadmap = { items: [item("a", { status: "ready" })] };
  const { roadmap: next, linked } = reconcile(roadmap, [issue("a", 95, { state: "open", closedAt: null })]);
  assert.equal(next.items[0].status, "ready");
  assert.equal(next.items[0].issue, 95);
  assert.equal(next.items[0].shipped_at, undefined);
  assert.deepEqual(linked, [{ id: "a", issue: 95 }]);
});

test("the earliest closed issue wins and pull requests are not evidence", () => {
  const roadmap = { items: [item("a")] };
  const history = [
    { number: 99, state: "closed", body: "<!-- roadmap:a -->", pull_request: {} },
    issue("a", 50, { closedAt: "2026-10-01T00:00:00Z" }),
    issue("a", 41, { closedAt: "2026-09-15T00:00:00Z" }),
  ];
  const { roadmap: next } = reconcile(roadmap, history);
  assert.equal(next.items[0].issue, 41);
  assert.equal(next.items[0].shipped_at, "2026-09-15");
});

test("bodies without a marker, and unknown ids, are ignored", () => {
  const roadmap = { items: [item("a")] };
  const { roadmap: next, shipped } = reconcile(roadmap, [
    { number: 1, state: "closed", body: "no marker here" },
    issue("not-in-the-manifest", 2),
  ]);
  assert.deepEqual(shipped, []);
  assert.equal(next.items[0].status, "backlog");
});

test("drift() is exactly the shipped-in-tracker, unfinished-in-manifest set", () => {
  const roadmap = { items: [item("a"), item("b", { status: "shipped" }), item("c")] };
  const history = [issue("a", 41), issue("b", 42), issue("c", 43, { state: "open", closedAt: null })];
  assert.deepEqual(drift(roadmap, history).map((s) => s.id), ["a"]);
});

test("the committed manifest uses only statuses the queue understands", () => {
  const manifest = JSON.parse(readFileSync(".github/roadmap.json", "utf8"));
  const statuses = new Set(manifest.items.map((i) => i.status));
  for (const status of statuses) {
    assert.ok(["backlog", "ready", "shipped"].includes(status), `unknown status: ${status}`);
  }
  // Every dependency must name a real item, or the queue fails closed forever.
  const ids = new Set(manifest.items.map((i) => i.id));
  for (const i of manifest.items) {
    for (const dep of i.depends_on || []) assert.ok(ids.has(dep), `${i.id} → ${dep}`);
  }
  // And an item that shipped should say which issue did it, now that we know.
  for (const i of manifest.items.filter((x) => x.status === "shipped")) {
    assert.ok(i.issue === undefined || Number.isInteger(i.issue), `${i.id} has a non-numeric issue`);
  }
});
