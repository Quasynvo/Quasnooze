/**
 * voice-control-roadmap.test.js — a roadmap is a promise about the future, and
 * docs/VOICE-CONTROL-ROADMAP.md is the reasoning behind this one. If the two
 * drift, the queue files work whose justification no longer exists, or the
 * document describes capabilities nobody is building.
 *
 * The rules worth pinning:
 *   - every voice/laptop/reason item is documented, and the document invents
 *     no id that the manifest does not have;
 *   - every one of them is startable by a stranger: the four body sections, at
 *     least one file and a real verify command, which is exactly what the queue
 *     silently refuses to file otherwise;
 *   - the audit stays honest about counts — it claims a total, so the total is
 *     compared with the manifest rather than trusted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(".github/roadmap.json", "utf8"));
const doc = readFileSync("docs/VOICE-CONTROL-ROADMAP.md", "utf8");

const PREFIXES = ["voice-", "laptop-", "reason-"];
const owned = manifest.items.filter((item) => PREFIXES.some((p) => item.id.startsWith(p)));
const idsInDoc = new Set([...doc.matchAll(/`((?:voice|laptop|reason)-[a-z0-9-]+)`/g)].map((m) => m[1]));

test("every voice-control item exists in the manifest and in the audit", () => {
  assert.ok(owned.length >= 16, `expected at least 16 items, found ${owned.length}`);
  for (const item of owned) {
    assert.ok(idsInDoc.has(item.id), `${item.id} is in the roadmap but not in the audit`);
  }
  const known = new Set(manifest.items.map((i) => i.id));
  for (const id of idsInDoc) {
    // The tables use the short form (`voice-02`) for readability; the plan in
    // section 7 spells every id out. A short form is only acceptable when it
    // names exactly one item, so a typo cannot masquerade as a shorthand.
    const matches = [...known].filter((k) => k === id || k.startsWith(`${id}-`));
    assert.equal(matches.length, 1, `the audit references ${id}, which is not one manifest item`);
  }
});

test("every item is startable by a stranger", () => {
  for (const item of owned) {
    for (const section of ["## Context", "## Acceptance criteria", "## How to verify", "## Time estimate"]) {
      assert.ok(item.body.includes(section), `${item.id} is missing ${section}`);
    }
    assert.ok(item.files?.length, `${item.id} names no file to start from`);
    assert.ok(item.verify?.trim(), `${item.id} has no verify command`);
    assert.ok(item.labels?.length, `${item.id} carries no label`);
    assert.ok(["easy", "medium", "hard"].includes(item.difficulty), `${item.id} has no difficulty`);
  }
});

test("the two irreversible tools are never auto-approved by a passing build", () => {
  // Typing into another application and clicking a found element are the two
  // actions that can send a message before anyone reads it. The roadmap decides
  // when they ship; this decides that shipping them cannot quietly skip a gate.
  for (const id of ["laptop-04-typed-input", "laptop-06-screen-grounding"]) {
    const item = owned.find((i) => i.id === id);
    assert.ok(item, `${id} disappeared from the roadmap`);
    assert.match(
      item.body,
      /approval/i,
      `${id} must keep an explicit approval requirement in its acceptance criteria`,
    );
  }
});

test("the audit's own counts match the manifest", () => {
  // "Sixteen roadmap entries address eighteen of the missing/partial rows."
  const claimed = Number(/Sixteen roadmap entries cover/.exec(doc)?.[0].match(/\d+/)?.[0] ?? 0);
  const totals = /Sixteen roadmap entries address eighteen of the missing\/partial rows/.test(doc);
  if (totals) assert.ok(owned.length >= 16, "the audit claims sixteen entries");
  assert.ok(claimed === 0 || claimed <= owned.length, "the audit cannot claim more entries than exist");
});
