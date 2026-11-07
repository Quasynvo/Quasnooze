import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "quasnooze-control-"));
process.env.PINCH_DATA = dataDir;
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_GUARD = "off";
delete process.env.QUASNOOZE_KILL_SWITCH;

import {
  isArmed, armKillswitch, disarmKillswitch, freezeMessage, readKillswitch,
  subject, mayRead, stampAcl, tenantId,
  classifyTask, route, createPromptCache, createSpendCap,
  enqueueHitl, decideHitl, pendingHitl, listHitl,
  mintEnvelope, workerMay, replyTo,
  validate, parseJson, SchemaError,
  filterHits,
} from "../src/control/index.js";

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test("kill switch fails closed on arm and env", () => {
  assert.equal(isArmed(), false);
  const armed = armKillswitch({ reason: "test freeze", by: "test" });
  assert.equal(armed.armed, true);
  assert.equal(isArmed(), true);
  assert.match(freezeMessage(), /kill switch is armed/);
  disarmKillswitch({ by: "test" });
  assert.equal(isArmed(), false);
  assert.equal(readKillswitch().armed, false);
});

test("identity subjects are stable and ACL is fail-closed", () => {
  const a = subject({ channel: "web", sessionId: "s1" });
  const b = subject({ channel: "web", sessionId: "s1" });
  const c = subject({ channel: "telegram", sessionId: "s1" });
  assert.equal(a.id, b.id);
  assert.notEqual(a.id, c.id);
  assert.equal(tenantId().length > 0, true);

  const doc = { text: "secret", acl: stampAcl(a) };
  assert.equal(mayRead(a, doc), true);
  assert.equal(mayRead(c, doc), false);
  assert.equal(mayRead(a, { text: "open", acl: { public: true, tenant: a.tenant } }), true);
});

test("gateway classifies tasks and spend cap refuses over budget", () => {
  assert.equal(classifyTask("what time is it"), "fast");
  assert.equal(classifyTask("please implement the parser", { hasTools: true }), "code");
  assert.equal(classifyTask("hello there"), "chat");

  const { backends } = route({
    task: "classify",
    backends: [{ name: "primary" }, { name: "small" }],
  });
  assert.equal(backends[0].name, "small");

  const cap = createSpendCap({ limitUsd: 1 });
  assert.equal(cap.observe({ usd: 0.4 }).ok, true);
  assert.equal(cap.observe({ usd: 0.7 }).refused, true);

  const cache = createPromptCache({ max: 2 });
  const k = cache.key([{ role: "user", content: "hi" }], "mock");
  cache.set(k, "hello");
  assert.equal(cache.get(k), "hello");
});

test("HITL queue is durable, single-use, and expires", () => {
  const item = enqueueHitl({ action: "send email", preview: "hi", sessionId: "s", ttlMs: 1000, now: 1_700_000_000_000 });
  assert.equal(item.state, "pending");
  assert.equal(pendingHitl({ now: 1_700_000_000_000 }).length, 1);
  const once = decideHitl(item.id, { approve: true, by: "owner", now: 1_700_000_000_100 });
  assert.equal(once.ok, true);
  const twice = decideHitl(item.id, { approve: false, now: 1_700_000_000_200 });
  assert.equal(twice.ok, false);

  enqueueHitl({ action: "stale", ttlMs: 1000, now: 1_000 });
  const listed = listHitl({ now: 1_000 + 1001 });
  assert.ok(listed.some((i) => i.action === "stale" && i.state === "expired"));
});

test("A2A envelopes never grant shell and workers are scoped", () => {
  const env = mintEnvelope({
    from: "parent",
    to: "worker",
    goal: "summarise notes",
    grants: ["read_file", "shell", "search_docs", "shell"],
    budget: { rounds: 2, timeoutMs: 5000 },
  });
  assert.equal(workerMay(env, "read_file"), true);
  assert.equal(workerMay(env, "search_docs"), true);
  assert.equal(workerMay(env, "shell"), false);
  assert.ok(!env.grants.includes("shell"));
  const reply = replyTo(env, { ok: true, text: "done", evidence: ["notes.md"] });
  assert.equal(reply.inReplyTo, env.id);
  assert.equal(reply.ok, true);
});

test("schema validation refuses extra keys and bad JSON", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["kind"],
    properties: { kind: { type: "string", enum: ["ok", "no"] } },
  };
  assert.equal(validate(schema, { kind: "ok" }).kind, "ok");
  assert.throws(() => validate(schema, { kind: "ok", extra: 1 }), SchemaError);
  assert.throws(() => parseJson("not json", schema), SchemaError);
  assert.equal(parseJson('prefix {"kind":"no"}', schema).kind, "no");
});

test("ACL filter drops hits the subject may not read", () => {
  const who = subject({ channel: "web", sessionId: "alpha" });
  const other = subject({ channel: "discord", sessionId: "beta" });
  const hits = [
    { id: "1", text: "mine", acl: stampAcl(who) },
    { id: "2", text: "theirs", acl: stampAcl(other) },
  ];
  const visible = filterHits(hits, who);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, "1");
});
