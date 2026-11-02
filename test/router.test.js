/**
 * Routing and failure classification: the fallback chain, the codes that stop it, and the rule
 * that a reply already on screen is never asked for twice.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { CODES, FINAL_CODES, HINTS, QuasError, classify, fromStatus, planFor } from "../src/failure.js";
import { ResilientRouter } from "../src/router.js";

/* ────────────────────────────── helpers ────────────────────────────── */

/** A backend that answers from a function and counts how often it was asked. */
function fake(name, answer, { provider = name } = {}) {
  const backend = {
    name,
    provider,
    calls: 0,
    async chat(messages, options = {}) {
      backend.calls++;
      return answer(messages, options);
    },
  };
  return backend;
}

const okWith = (provider, content = "hello") => () => ({ content, provider, toolCalls: [] });
const failWith = (error) => () => {
  throw error;
};

/** A clock that advances 1ms per reading, so timings are deterministic without sleeping. */
function ticks() {
  let t = 0;
  return () => {
    t += 1_000_000;
    return t;
  };
}

const cfgWith = (llm) => ({ llm: { fallback: "", openaiKey: "", ollamaModel: "local:7b", openaiModel: "cloud-1", ...llm } });

/* ───────────────────────────── the chain ───────────────────────────── */

test("the first backend that answers wins and the rest are never called", async () => {
  const primary = fake("primary", okWith("primary", "from primary"));
  const secondary = fake("secondary", okWith("secondary"));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });

  const routed = await router.run([{ role: "user", content: "hi" }]);

  assert.equal(routed.result.content, "from primary");
  assert.equal(routed.provider, "primary");
  assert.equal(routed.degraded, false);
  assert.equal(routed.attempts.length, 1);
  assert.equal(secondary.calls, 0);
});

test("primary fails, secondary answers, and the turn is marked degraded", async () => {
  const primary = fake("ollama", failWith(fromStatus(500, "boom", { provider: "ollama" })));
  const secondary = fake("openai", okWith("openai", "from the cloud"));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });

  const routed = await router.run([{ role: "user", content: "hi" }]);

  assert.equal(routed.result.content, "from the cloud");
  assert.equal(routed.provider, "openai");
  assert.equal(routed.degraded, true);
  assert.deepEqual(routed.attempts.map((a) => [a.backend, a.ok]), [["ollama", false], ["openai", true]]);
  assert.equal(routed.attempts[0].code, CODES.UPSTREAM_BROKEN);
});

test("when every backend fails the primary's reason is thrown, with the whole trail", async () => {
  const primary = fake("ollama", failWith(fromStatus(429, "slow down", { provider: "ollama" })));
  const secondary = fake("openai", failWith(fromStatus(401, "bad key", { provider: "openai" })));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });

  await assert.rejects(router.run([{ role: "user", content: "hi" }]), (err) => {
    assert.equal(err.code, CODES.RATE_LIMITED, "the primary's reason explains the turn");
    assert.equal(err.status, 429);
    assert.equal(err.attempts.length, 2);
    assert.deepEqual(err.attempts.map((a) => a.code), [CODES.RATE_LIMITED, CODES.NEED_AUTH]);
    assert.match(err.hint, /rate limit/i);
    return true;
  });
});

test("a final failure stops the chain instead of retrying it on every backend", async () => {
  const primary = fake("ollama", failWith(new QuasError(CODES.BAD_INPUT, "messages must be an array")));
  const secondary = fake("openai", okWith("openai"));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });

  await assert.rejects(router.run([{ role: "user", content: "hi" }]), (err) => err.code === CODES.BAD_INPUT);
  assert.equal(secondary.calls, 0, "the same broken request would fail there too");
});

test("a failure after text reached the caller is not retried anywhere", async () => {
  const primary = fake("ollama", (messages, options) => {
    options.onDelta("Once upon a ");
    throw new Error("stream ended early");
  });
  const secondary = fake("openai", okWith("openai", "a different beginning"));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });
  const seen = [];

  await assert.rejects(router.run([{ role: "user", content: "hi" }], { onDelta: (piece) => seen.push(piece) }), (err) => {
    assert.equal(err.code, CODES.STREAM_CUT, "the user would otherwise read the answer twice");
    assert.match(err.hint, /already started/i);
    return true;
  });
  assert.equal(secondary.calls, 0);
  assert.deepEqual(seen, ["Once upon a "], "what was streamed stays streamed, once");
});

test("a failure before any text reaches the caller still falls through", async () => {
  const primary = fake("ollama", () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  });
  const secondary = fake("openai", okWith("openai", "served by the fallback"));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });

  const routed = await router.run([{ role: "user", content: "hi" }], { onDelta: () => {} });

  assert.equal(routed.result.content, "served by the fallback");
  assert.equal(routed.attempts[0].code, CODES.UNREACHABLE);
});

test("every attempt is timed, including the one that failed", async () => {
  const primary = fake("ollama", failWith(fromStatus(503, "unavailable")));
  const secondary = fake("openai", okWith("openai"));
  const router = new ResilientRouter([primary, secondary], { now: ticks() });

  const routed = await router.run([{ role: "user", content: "hi" }]);

  assert.ok(routed.attempts.every((a) => a.ms > 0));
});

test("the router refuses to be built with no backends", () => {
  assert.throws(() => new ResilientRouter([]), /at least one backend/);
});

test("the plan is the ordered list of what would be tried", () => {
  const router = new ResilientRouter([fake("ollama", okWith("ollama")), fake("openai", okWith("openai"))]);
  assert.deepEqual(router.plan, ["ollama", "openai"]);
});

/* ───────────────────────── classification ───────────────────────── */

test("HTTP statuses become the codes that describe them", () => {
  assert.equal(fromStatus(429).code, CODES.RATE_LIMITED);
  assert.equal(fromStatus(401).code, CODES.NEED_AUTH);
  assert.equal(fromStatus(403).code, CODES.NEED_AUTH);
  assert.equal(fromStatus(400).code, CODES.BAD_INPUT);
  assert.equal(fromStatus(500).code, CODES.UPSTREAM_BROKEN);
  assert.equal(fromStatus(503).code, CODES.UPSTREAM_BROKEN);
  assert.equal(fromStatus(429, "slow", { retryAfterSeconds: 30 }).retryAfterSeconds, 30);
  assert.match(fromStatus(500, "boom").message, /HTTP 500: boom/);
});

test("what fetch throws is told apart: refused, timed out, unreadable", () => {
  assert.equal(classify(new Error("connect ECONNREFUSED 127.0.0.1:11434")).code, CODES.UNREACHABLE);
  assert.equal(classify(new Error("getaddrinfo ENOTFOUND api.example")).code, CODES.UNREACHABLE);
  const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  assert.equal(classify(aborted).code, CODES.TIMEOUT);
  assert.equal(classify(new Error("Non-JSON response (200): <html>")).code, CODES.PAYLOAD_MISMATCH);
});

test("classify leaves an already-typed failure alone", () => {
  const original = new QuasError(CODES.NEED_AUTH, "bad key", { provider: "openai" });
  assert.equal(classify(original), original);
});

test("the hint is actionable for every code, and final codes say so", () => {
  for (const code of Object.values(CODES)) {
    assert.ok(HINTS[code] && HINTS[code].length > 20, `no usable hint for ${code}`);
  }
  assert.ok(FINAL_CODES.has(CODES.BAD_INPUT));
  assert.ok(FINAL_CODES.has(CODES.STREAM_CUT));
  assert.ok(!FINAL_CODES.has(CODES.RATE_LIMITED), "a rate limit is exactly what a fallback is for");
  assert.ok(!FINAL_CODES.has(CODES.NEED_AUTH));
  assert.ok(!FINAL_CODES.has(CODES.UNREACHABLE));
  assert.equal(new QuasError(CODES.BAD_INPUT, "x").final, true);
  assert.equal(new QuasError(CODES.RATE_LIMITED, "x").final, false);
});

test("the machine-readable failure carries the code, never just the message", () => {
  const failure = fromStatus(429, "slow down", { provider: "openai" });
  const json = failure.toJSON();
  assert.equal(json.ok, false);
  assert.equal(json.code, CODES.RATE_LIMITED);
  assert.equal(json.provider, "openai");
  assert.equal(json.status, 429);
  assert.ok(json.hint);
});

/* ────────────────────── the fallback policy ────────────────────── */

test("by default a turn has exactly one provider: no silent trip to the cloud", () => {
  const plan = planFor({ provider: "ollama", model: "local:7b" }, cfgWith({ openaiKey: "sk-test" }));
  assert.deepEqual(plan.map((hop) => hop.provider), ["ollama"]);
});

test("an opted-in fallback adds exactly one hop, in the order asked for", () => {
  const plan = planFor({ provider: "ollama", model: "local:7b" }, cfgWith({ fallback: "openai", openaiKey: "sk-test" }));
  assert.deepEqual(plan.map((hop) => [hop.provider, hop.role]), [["ollama", "primary"], ["openai", "fallback"]]);
  assert.equal(plan[1].model, "cloud-1");
});

test("a fallback that cannot work is not pretended to exist", () => {
  const noKey = planFor({ provider: "ollama", model: "local:7b" }, cfgWith({ fallback: "openai", openaiKey: "" }));
  assert.deepEqual(noKey.map((hop) => hop.provider), ["ollama"], "no key, no second hop");

  const same = planFor({ provider: "ollama", model: "local:7b" }, cfgWith({ fallback: "ollama" }));
  assert.deepEqual(same.map((hop) => hop.provider), ["ollama"], "a fallback to itself is not a fallback");

  const mock = planFor({ provider: "ollama", model: "local:7b" }, cfgWith({ fallback: "mock" }));
  assert.deepEqual(mock.map((hop) => hop.provider), ["ollama"], "canned text is never an answer");
});
