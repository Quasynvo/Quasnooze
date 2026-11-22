/**
 * cost-ledger.test.js — the cost half of issue #211.
 *
 * Claims: a per-turn cost ledger (tokens, model, latency, estimated spend)
 * that is 100% local — zero network bytes, ever — and a spend cap the
 * control plane actually enforces: over the cap, priced cloud backends are
 * refused and the refusal is on the record.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-cost-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-cost-data-"));
process.env.PINCH_AUTO_APPROVE = "false";
process.env.LLM_PROVIDER = "ollama";
process.env.OLLAMA_URL = "http://127.0.0.1:9";
process.env.OPENAI_API_KEY = "sk-test-the-cap-must-trip-first";
process.env.QUASNOOZE_SPEND_CAP_USD = "1"; // this file exercises the cap at $1
process.env.LLM_FALLBACK = "ollama"; // the owner opted into local fallback (empty by default)

const { costLedger, costSummary, spendState, todaySpendUsd } = await import("../src/cost.js");
const { route, createSpendCap } = await import("../src/control/gateway.js");

const DATA = process.env.PINCH_DATA;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function writeTurns(rows) {
  writeFileSync(join(DATA, "telemetry.ndjson"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const pricedTurn = {
  kind: "turn",
  ts: new Date().toISOString(),
  provider: "openai",
  model: "gpt-4o-mini",
  tokens: 1_000_000,
  ms: 900,
  firstTextMs: 320,
};

test("the ledger prices each turn locally: tokens, model, latency, spend", () => {
  writeTurns([pricedTurn, { ...pricedTurn, kind: "turn", tokens: 0, model: "fast:latest", provider: "ollama" }]);
  const ledger = costLedger();
  assert.equal(ledger.rows.length, 2);
  const [row] = ledger.rows;
  assert.equal(row.model, "gpt-4o-mini");
  assert.equal(row.tokens, 1_000_000);
  assert.equal(row.latencyMs, 900);
  assert.equal(row.firstTextMs, 320);
  assert.equal(row.state, "priced");
  assert.equal(row.low, 0.15, "input price × tokens");
  assert.equal(row.high, 0.6, "output price × tokens");
  const localRow = ledger.rows[1];
  assert.equal(localRow.state, "local");
  assert.equal(localRow.low + localRow.high, 0, "a local model costs nothing");
  assert.equal(typeof ledger.total.low, "number");
});

test("an unpriced model reports unknown — never a fake zero", () => {
  writeTurns([{ ...pricedTurn, model: "mystery-9000" }]);
  const [row] = costLedger().rows;
  assert.equal(row.state, "unknown");
  assert.equal(row.low, undefined, "no invented price");
});

test("the ledger is 100% local: zero network bytes", () => {
  writeTurns([pricedTurn]);
  let netCalls = 0;
  const realFetch = globalThis.fetch;
  const realXhr = globalThis.XMLHttpRequest;
  globalThis.fetch = () => { netCalls += 1; throw new Error("network forbidden"); };
  globalThis.XMLHttpRequest = function () { netCalls += 1; throw new Error("network forbidden"); };
  try {
    costLedger();
    costSummary({ days: 30 });
    spendState({ limitUsd: 5 });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.XMLHttpRequest = realXhr;
  }
  assert.equal(netCalls, 0, "pricing reads local files only");
  // and the modules themselves never import a network stack
  for (const rel of ["src/cost.js", "src/backup.js"]) {
    const source = readFileSync(join(ROOT, rel), "utf8");
    assert.equal(/require\(["'](node:)?(http|https|net|dgram|tls)["']\)|from ["'](node:)?(http|https|net|dgram|tls)["']|fetch\(/.test(source), false,
      `${rel} must not touch the network`);
  }
});

test("the spend cap is computed from the local ledger, across restarts", () => {
  // 2M tokens at output price = $2 for gpt-4o-mini's out:0.6 → high = 1.2
  writeTurns([{ ...pricedTurn, tokens: 2_000_000 }]);
  assert.equal(todaySpendUsd({ high: true }), 1.2);
  const state = spendState({ limitUsd: 1 });
  assert.equal(state.overCap, true);
  assert.equal(state.limitUsd, 1);
  assert.equal(state.spentUsd, 1.2);
});

test("over the cap, the control plane refuses priced cloud backends — local stays", () => {
  writeTurns([{ ...pricedTurn, tokens: 2_000_000 }]); // $1.20 high — over a $1 cap
  const plan = route({
    task: "chat",
    backends: [
      { name: "primary", kind: "cloud", provider: "openai", model: "gpt-4o-mini" },
      { name: "fallback", kind: "local", provider: "ollama", model: "fast" },
    ],
    spend: spendState({ limitUsd: 1 }),
  });
  assert.equal(plan.backends.some((b) => b.kind === "cloud"), false, "priced backends are refused over the cap");
  assert.equal(plan.backends.some((b) => b.kind === "local"), true, "local keeps working — the assistant still answers");
  assert.match(plan.reason || "", /spend cap/i);
});

test("under the cap the plan is unchanged", () => {
  writeTurns([]); // no spend at all
  const plan = route({
    task: "chat",
    backends: [
      { name: "primary", kind: "cloud", provider: "openai", model: "gpt-4o-mini" },
      { name: "fallback", kind: "local", provider: "ollama", model: "fast" },
    ],
    spend: spendState({ limitUsd: 5 }),
  });
  assert.equal(plan.backends.length, 2);
});

test("createSpendCap still refuses an over-cap observation", () => {
  const cap = createSpendCap({ limitUsd: 1 });
  assert.equal(cap.observe({ usd: 0.5 }).ok, true);
  const refused = cap.observe({ usd: 0.8 });
  assert.equal(refused.ok, false);
  assert.equal(refused.refused, true);
});

test("over the cap, the priced request never leaves the machine and local answers", async () => {
  writeTurns([{ ...pricedTurn, tokens: 2_000_000 }]); // $1.20 today — over a $1 cap
  const { brain } = await import("../src/brain.js");

  let cloudCalls = 0;
  let localCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (/openai|azure|anthropic|generativelanguage/i.test(target)) {
      cloudCalls += 1;
      throw new Error("money call escaped the cap");
    }
    localCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ message: { content: "answered locally, for free" } }),
      text: async () => JSON.stringify({ message: { content: "answered locally, for free" } }),
      headers: { get: () => null },
    };
  };
  try {
    const out = await brain.chat([{ role: "user", content: "hello" }], {
      selection: { provider: "openai", model: "gpt-4o-mini" },
    });
    assert.equal(cloudCalls, 0, "the priced request never left the machine");
    assert.equal(out.provider, "ollama", "the local provider answered instead");
    assert.match(out.content, /answered locally/, "the assistant still answers");
  } finally {
    globalThis.fetch = realFetch;
  }
});
