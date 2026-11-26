/**
 * The braincheck throughput number.
 *
 * It shipped dividing words by milliseconds and multiplying by 60000 — words
 * per hour-of-milliseconds — so a reply that really ran at ~12 words/s was
 * printed as "~757 words/s". The script exists to answer "how fast is it", so
 * a 60× error there is the whole answer being wrong. The formula now lives in
 * src/metrics.js, where this file can hold it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { wordsPerSecond } from "../src/metrics.js";

test("words per second is words divided by seconds", () => {
  assert.equal(wordsPerSecond("one two three four", 2000), 2);
  assert.equal(wordsPerSecond("one two three four", 1000), 4);
  assert.equal(wordsPerSecond("only", 500), 2);
});

test("the unit is seconds, not the 60× that shipped", () => {
  // Ten words in one second is ten words per second. The old arithmetic said
  // 600 — this assertion is the regression, stated as the number it is not.
  const words = "a b c d e f g h i j";
  assert.equal(wordsPerSecond(words, 1000), 10);
  assert.notEqual(wordsPerSecond(words, 1000), 600);
  // And a realistic local-model reply: ~40 words in 7.6 s.
  assert.equal(wordsPerSecond("word ".repeat(40).trim(), 7613), 5);
});

test("whitespace, empty replies and stopwatch errors do not produce nonsense", () => {
  assert.equal(wordsPerSecond("", 1000), 0);
  assert.equal(wordsPerSecond("   \n\t ", 1000), 0);
  assert.equal(wordsPerSecond(null, 1000), 0);
  assert.equal(wordsPerSecond("a b", 0), 2000, "0 ms is a stopwatch error, not infinite speed");
  assert.equal(wordsPerSecond("a b", -5), 2000);
  assert.equal(wordsPerSecond("a b", Number.NaN), 2000);
});
