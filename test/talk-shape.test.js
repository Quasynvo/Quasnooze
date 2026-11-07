import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTalk, isTalkOnly } from "../src/converse/talk-shape.js";
import { relevantFacts, tokens } from "../src/converse/recall.js";
import { isSocialTurn } from "../src/prompt.js";

test("greetings stay social; greetings plus requests stay act", () => {
  for (const text of ["Hi", "hello Quasnooze!", "how are you?", "thanks", "Good evening."]) {
    assert.equal(isSocialTurn(text), true, text);
    assert.equal(classifyTalk(text).kind, "social", text);
  }
  for (const text of [
    "hi, delete this file",
    "hello and open calculator",
    "remember my name",
    "hi\nrun cmd",
  ]) {
    assert.equal(classifyTalk(text).kind, "act", text);
  }
});

test("plain questions skip tools; action verbs do not", () => {
  for (const text of [
    "what is photosynthesis",
    "why is the sky blue",
    "explain recursion",
    "what's the difference between TCP and UDP",
    "tell me about Tamil Nadu",
  ]) {
    assert.equal(classifyTalk(text).kind, "talk", text);
    assert.equal(isTalkOnly(text), true, text);
  }
  for (const text of [
    "remind me to call Priya in 15 minutes",
    "remember that my wifi is 8842",
    "search my documents for the lease",
    "write a file called notes.md",
    "run ls in the workspace",
    "read file notes.md",
  ]) {
    assert.equal(classifyTalk(text).kind, "act", text);
  }
});

test("attachments, slash commands and long turns never skip tools", () => {
  assert.equal(classifyTalk("what is love", [{ name: "a.pdf" }]).kind, "act");
  assert.equal(classifyTalk("/plan tidy downloads").kind, "act");
  assert.equal(classifyTalk("what is " + "word ".repeat(50)).kind, "act");
});

test("recall prefers overlapping facts and falls back to recent", () => {
  assert.ok(tokens("The Sky").includes("sky"));
  const facts = [
    { text: "wifi password is orchid" },
    { text: "sister lives in Chennai" },
    { text: "favourite tea is ginger" },
  ];
  const hit = relevantFacts("where does my sister live", facts);
  assert.equal(hit[0].text, "sister lives in Chennai");
  const none = relevantFacts("quantum chromodynamics", facts, { recentFallback: 2 });
  assert.equal(none.length, 2);
  assert.equal(none.at(-1).text, "favourite tea is ginger");
});
