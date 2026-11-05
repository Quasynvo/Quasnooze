/**
 * frontier-roadmap.test.js — the competitive-frontier layer of the roadmap, and
 * docs/COMPETITIVE-FRONTIER.md, are two halves of one claim: that every new
 * feature arrives with a measured improvement and a floor it may not break.
 *
 * The rules worth pinning:
 *   - a frontier item without a number in its target is a wish, not a feature;
 *   - a frontier item without a "must not regress" floor is allowed to trade
 *     quality for speed, which is the one thing this project refuses;
 *   - the document and the manifest describe the same set of ids;
 *   - the comparison names the projects it claims to have out-designed, because
 *     an unnamed competitor is marketing.
 */

// Guards the competitive-frontier layer of the roadmap:
//   * every frontier item carries a measurable performance contract,
//   * the contract is a target and a non-regression floor, not an adjective,
//   * the audit document and the manifest agree on which items exist,
//   * the document names the projects it is comparing against.
//
// The intent is that a contributor cannot add "make it faster" as a feature.
// See docs/COMPETITIVE-FRONTIER.md.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(".github/roadmap.json", "utf8"));
const doc = readFileSync("docs/COMPETITIVE-FRONTIER.md", "utf8");

const FRONTIER_PREFIXES = ["duplex-", "ear-", "skill-", "mind-", "lead-"];
const frontier = manifest.items.filter((item) =>
  FRONTIER_PREFIXES.some((prefix) => item.id.startsWith(prefix)),
);

const sectionOf = (body, heading) => {
  const start = body.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const rest = body.slice(start + heading.length + 3);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
};

test("the frontier set exists and is gated by dependencies, not dates", () => {
  assert.ok(
    frontier.length >= 12,
    `expected at least 12 frontier items, found ${frontier.length}`,
  );

  for (const item of frontier) {
    if (item.status === "shipped") {
      // Shipping is the point of the exercise; a shipped item only has to say
      // when, so the queue and the audit agree about it.
      assert.match(
        String(item.shipped_at ?? ""),
        /^\d{4}-\d{2}-\d{2}$/,
        `${item.id} is shipped but has no shipped_at date`,
      );
      continue;
    }
    assert.equal(
      item.status,
      "backlog",
      `${item.id} must start in backlog, not ${item.status}`,
    );
    // No calendar. An item opens when the work it depends on is closed, which
    // is the only ordering this project has — a date made a specified backlog
    // look finished, and made "when does this start?" a question about a
    // schedule instead of about the prerequisite.
    assert.equal(
      "not_before" in item,
      false,
      `${item.id} carries a date; order work with depends_on instead`,
    );
    assert.ok(
      item.depends_on && item.depends_on.length > 0,
      `${item.id} must name the item that has to exist first`,
    );
    assert.ok(
      item.labels.includes("help wanted"),
      `${item.id} must be claimable by a contributor`,
    );
  }

  const ids = new Set(manifest.items.map((item) => item.id));
  for (const item of frontier) {
    for (const dependency of item.depends_on) {
      assert.ok(
        ids.has(dependency),
        `${item.id} depends on ${dependency}, which is not in the manifest`,
      );
      assert.notEqual(
        dependency,
        item.id,
        `${item.id} cannot depend on itself`,
      );
    }
  }
});

test("every frontier item carries a measurable performance contract", () => {
  for (const item of frontier) {
    const contract = sectionOf(item.body, "Performance contract");
    assert.ok(
      contract.trim().length > 0,
      `${item.id} has no ## Performance contract section`,
    );

    // The contract is three bulleted lines inside the section, not three
    // sub-headings, so that it reads as one block in an issue body.
    const line = (label) => {
      const match = contract.match(new RegExp(`\\*\\*${label}:\\*\\*([^\\n]*)`));
      return match ? match[1].trim() : "";
    };
    const baseline = line("Baseline");
    const target = line("Target");
    const floor = line("Must not regress");

    assert.ok(baseline.trim(), `${item.id} contract has no Baseline`);
    assert.ok(target.trim(), `${item.id} contract has no Target`);
    assert.ok(floor.trim(), `${item.id} contract has no Must not regress`);

    // A baseline of "slow" is not a baseline; a target of "faster" is not a
    // target. Both have to name something you could measure with a stopwatch,
    // a corpus, or a counter.
    const measurable = /\d/;
    assert.match(
      target,
      measurable,
      `${item.id} target must contain a number, not an adjective`,
    );
    assert.match(
      baseline,
      /\d|not implemented/i,
      `${item.id} baseline must name a recorded measurement or say "not implemented"`,
    );
    // "Slow today" is not a baseline; it is an excuse to skip measuring.
    assert.doesNotMatch(
      baseline,
      /^(slow|bad|poor|unknown|slow today)\b/i,
      `${item.id} baseline is a feeling, not a measurement`,
    );
  }
});

test("frontier items keep their acceptance criteria and safety notes", () => {
  for (const item of frontier) {
    for (const heading of [
      "Context",
      "What to change",
      "Acceptance criteria",
      "How to verify",
      "Time estimate",
    ]) {
      assert.ok(
        sectionOf(item.body, heading).trim(),
        `${item.id} is missing the ${heading} section`,
      );
    }
    assert.match(
      item.body,
      /\*\*Safety:\*\*/,
      `${item.id} must state what it is allowed to touch`,
    );
  }

  // The two halves of the moat must survive editing: a compiled skill is only
  // worth having if it is verified and if a drifted run stops instead of
  // guessing.
  const verified = manifest.items.find((i) => i.id === "skill-02-verified-execution");
  const drift = manifest.items.find((i) => i.id === "skill-03-drift-repair");
  assert.ok(verified && drift, "the verified-execution chain must exist");
  assert.match(verified.body, /verified|contr|wrong-success/i);
  assert.match(drift.body, /drift|precondition/i);
  assert.ok(
    drift.depends_on.includes("skill-02-verified-execution"),
    "drift repair must build on verified execution",
  );
});

test("the frontier document and the manifest describe the same work", () => {
  for (const item of frontier) {
    assert.ok(
      doc.includes(item.id),
      `${item.id} is in the roadmap but not documented in docs/COMPETITIVE-FRONTIER.md`,
    );
  }

  const documented = new Set(doc.match(/\b(?:duplex|ear|skill|mind|lead)-\d{2}[a-z0-9-]*/g));
  const known = new Set(frontier.map((item) => item.id));
  for (const id of documented) {
    const resolved = [...known].filter((real) => real === id || real.startsWith(`${id}-`));
    assert.equal(
      resolved.length,
      1,
      `docs mention ${id}, which does not resolve to exactly one roadmap item`,
    );
  }
});

test("the comparison names the projects it is comparing against", () => {
  const projects = [
    "openclaw/openclaw",
    "openinterpreter/open-interpreter",
    "ggml-org/whisper.cpp",
    "SYSTRAN/faster-whisper",
    "pipecat-ai/pipecat",
    "livekit/agents",
    "bytedance/UI-TARS",
    "kyutai-labs/moshi",
    "rhasspy/piper",
    "snakers4/silero-vad",
    "hexgrad/kokoro",
    "dscripka/openWakeWord",
    "OpenAdaptAI/OpenAdapt",
  ];

  for (const project of projects) {
    assert.ok(
      doc.includes(project),
      `docs/COMPETITIVE-FRONTIER.md must name ${project}`,
    );
  }

  // The point of the document is to find the gap, not to praise the field.
  assert.match(doc, /nobody/i);
  assert.match(doc, /cannot|does not|no /i);
});
