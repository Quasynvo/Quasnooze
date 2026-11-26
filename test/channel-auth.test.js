/**
 * channel-auth.test.js — an empty allowlist authorises nobody.
 *
 * Written after finding the inverse in two of three channels: Telegram read
 * `approved.size === 0 || approved.has(id)` and Discord read
 * `allowed.size && !allowed.has(channel)`, so the shipped default (a token with
 * the allowlist left blank) made the bot answer strangers — and the tool list
 * behind that conversation includes `shell` and `write_file`. The suite was
 * green the whole time, because nothing tested the door.
 *
 * Three layers here, on purpose:
 *   1. the predicate itself, including the inputs a message can actually carry;
 *   2. the refusal text, because it is the setup path the guide promises;
 *   3. a source fence, because the inversion is one character wide and easy to
 *      retype in the next channel someone adds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createAllowList, digitsOnly } from "../src/channels/auth.js";
import { unauthorisedReply } from "../src/channels/telegram.js";

const channelFiles = ["telegram.js", "discord.js", "whatsapp.js", "slack.js"];

const source = (name) => readFileSync(new URL(`../src/channels/${name}`, import.meta.url), "utf8");

/**
 * Code only, for the fences below.
 *
 * The comment in discord.js quotes the shape that shipped, because a bug that is
 * fixed but not described reopens. A fence that trips on its own documentation
 * teaches the wrong lesson, so comments are removed before matching. This is a
 * line-oriented approximation (a `//` inside a string literal truncates that
 * line) and that is fine here: the patterns being hunted are calls, not URLs.
 */
const codeOnly = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");

/* ───────────────────────────── the predicate ───────────────────────────── */

test("an empty allowlist denies every id, including the ones a message can carry", () => {
  const allowed = createAllowList([]);
  assert.equal(allowed.configured, false);
  assert.equal(allowed.size, 0);
  for (const id of [123456789, "123456789", "", " ", "0", null, undefined, {}, [], "undefined"]) {
    assert.equal(allowed.has(id), false, `empty allowlist must deny ${JSON.stringify(id)}`);
  }
});

test("a missing allowlist (undefined) is the same as an empty one", () => {
  for (const configured of [undefined, null, [], "", false]) {
    const allowed = createAllowList(configured);
    assert.equal(allowed.configured, false, `${JSON.stringify(configured)} must not count as configured`);
    assert.equal(allowed.has("123456789"), false);
    assert.equal(allowed.has("false"), false, "a boolean must never be stringified into an id");
  }
});

test("a configured allowlist allows exactly the listed ids, and nothing shaped like them", () => {
  const allowed = createAllowList(["123456789"]);
  assert.equal(allowed.configured, true);
  assert.equal(allowed.size, 1);
  assert.equal(allowed.has(123456789), true); // Telegram delivers a number
  assert.equal(allowed.has("123456789"), true);
  assert.equal(allowed.has(" 123456789 "), true); // whitespace is not identity
  assert.equal(allowed.has("1234567890"), false);
  assert.equal(allowed.has("12345678"), false);
  assert.equal(allowed.has("+123456789"), false);
  assert.equal(allowed.has(""), false);
  assert.equal(allowed.has(null), false);
});

test("blank entries from a trailing comma do not become an allow-the-empty-id rule", () => {
  const allowed = createAllowList(["123456789", "", "  ", null, undefined]);
  assert.equal(allowed.size, 1);
  assert.equal(allowed.has(""), false);
});

test("WhatsApp compares digits, so a formatted number matches the jid", () => {
  const allowed = createAllowList(["+91 98765 43210", "44 7700 900123"], { normalize: digitsOnly });
  assert.equal(allowed.size, 2);
  assert.equal(allowed.has("919876543210"), true); // what jidNumber() produces
  assert.equal(allowed.has("447700900123"), true);
  assert.equal(allowed.has("919876543211"), false);
  assert.equal(allowed.has(""), false);
});

test("an entry with no digits is dropped rather than matching an empty number", () => {
  const allowed = createAllowList(["not-a-number"], { normalize: digitsOnly });
  assert.equal(allowed.configured, false);
  assert.equal(allowed.has(""), false);
});

test("the allow list is read-only: nothing at runtime may grant itself access", () => {
  const allowed = createAllowList(["123456789"]);
  for (const mutator of ["add", "delete", "set", "grant"]) {
    assert.equal(typeof allowed[mutator], "undefined", `there must be no ${mutator}()`);
  }
  assert.equal(allowed.has("999"), false);
});

/* ────────────────────────────── the refusal ────────────────────────────── */

test("an unauthorised sender is told their own id and the variable to set", () => {
  const text = unauthorisedReply(987654321, { configured: false });
  assert.match(text, /987654321/);
  assert.match(text, /TELEGRAM_ALLOWED_IDS/);
  assert.match(text, /refuses everyone/i);
  assert.doesNotMatch(text, /granted|you may now/i);
});

test("a known bot with a set allowlist says 'private', not 'misconfigured'", () => {
  const text = unauthorisedReply(987654321, { configured: true });
  assert.match(text, /private/i);
  assert.match(text, /987654321/);
  assert.match(text, /TELEGRAM_ALLOWED_IDS/);
});

test("the refusal echoes no secrets and survives a missing id", () => {
  const text = unauthorisedReply(undefined, { configured: false });
  assert.match(text, /unknown/);
  assert.doesNotMatch(text, /[0-9]{8,}:[A-Za-z0-9_-]{20,}/); // BotFather token shape
});

/* ──────────────────────────── the source fence ─────────────────────────── */

test("no channel authorises anyone when its allowlist is empty", () => {
  // The two shapes that shipped. Either one means "empty list => everybody".
  const failOpen = [/allowed\s*\.\s*size\s*===?\s*0\s*\|\|/, /allowed\s*\.\s*size\s*&&/, /approved\s*\.\s*size\s*===?\s*0\s*\|\|/];
  const offenders = [];
  for (const name of channelFiles) {
    const text = codeOnly(source(name));
    for (const pattern of failOpen) {
      if (pattern.test(text)) offenders.push(`${name}: ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], "an empty allowlist must deny everything, not permit everything");
});

test("every channel that gates on an allowlist uses the shared helper", () => {
  for (const name of ["telegram.js", "discord.js", "whatsapp.js"]) {
    const text = codeOnly(source(name));
    assert.match(text, /createAllowList/, `${name} must build its allowlist with createAllowList`);
    assert.match(text, /allowed\s*\.\s*has\(/, `${name} must ask allowed.has(...)`);
  }
});

test("the channels that cannot work without an allowlist refuse to start", () => {
  // Discord and WhatsApp must bail before connecting/pairing; Telegram keeps the
  // documented bootstrap (refuse + echo the id) instead of going silent.
  for (const name of ["discord.js", "whatsapp.js"]) {
    const text = codeOnly(source(name));
    assert.match(text, /if\s*\(!allowed\.configured\)/, `${name} must return early when nothing is allowlisted`);
    assert.match(text, /return null/, `${name} must report itself as off rather than listening`);
  }
});

test("an approval button is only honoured for an authorised finger", () => {
  // The second door: a callback_query arrives with a `from` id, and answering one
  // resolves a permission prompt. The check must come before answerApproval().
  const text = codeOnly(source("telegram.js"));
  const at = text.indexOf("if (update.callback_query)");
  assert.ok(at > 0, "the callback_query branch must still exist");
  const branch = text.slice(at, at + 1200);
  const guard = branch.indexOf("allowed.has(update.callback_query.from");
  const tap = branch.indexOf("answerApproval(");
  assert.ok(guard > 0, "a callback_query must be checked against the allowlist");
  assert.ok(tap > 0, "answerApproval() must still be reachable");
  assert.ok(guard < tap, "the sender check must run BEFORE the approval is answered");
});

test("the docs and .env.example say what an empty allowlist does", () => {
  const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  for (const name of ["TELEGRAM_ALLOWED_IDS", "DISCORD_CHANNEL_IDS", "WHATSAPP_ALLOWED_NUMBERS"]) {
    const at = env.indexOf(name);
    assert.ok(at > 0, `${name} must be documented in .env.example`);
    const block = env.slice(Math.max(0, at - 400), at + name.length + 240).toLowerCase();
    assert.match(
      block,
      /empty|nobody|refuse|not connect/,
      `${name} must state what an empty value means — that sentence is the promise`
    );
  }
  const channels = readFileSync(new URL("../docs/CHANNELS.md", import.meta.url), "utf8");
  assert.match(channels, /refuse everyone/i, "the Telegram bootstrap promise must stay documented");
  assert.match(channels, /never\s+\*?every channel/i, "the Discord promise must stay documented");
});
