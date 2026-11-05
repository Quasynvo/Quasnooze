/**
 * speech-accuracy.test.js — measuring "it understands me better" instead of asserting it.
 *
 * The README says voice accuracy has not been measured on physical hardware, and
 * that stays true. What this measures is narrower and honest, and it is split in
 * two on purpose:
 *
 *   • **word error rate** over a labelled corpus — how close the transcript is to
 *     the words that were said;
 *   • **command accuracy** — did that transcript select the intended tool with the
 *     intended arguments.
 *
 * They are not the same number and they must not be averaged into one. "Turn off
 * the kitchen light" transcribed as "turn off the kitchen lite" is a small word
 * error and the same command; "remind me at two" transcribed as "remind me at
 * noon" is one word and the wrong reminder. A single accuracy percentage hides
 * exactly the failures a person notices.
 *
 * Every number carries its sample count, and a condition below the minimum
 * reports "withheld" rather than a percentage. A WER from three samples is a
 * coincidence with a decimal point.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  wordErrorRate,
  scoreCommand,
  evaluateSpeech,
  renderSpeechEvaluation,
  speechBaseline,
  MIN_CONDITION_SAMPLES,
} from "../scripts/evaluate-speech.js";

const corpus = JSON.parse(await readFile(new URL("../test-fixtures/speech/v1/corpus.json", import.meta.url), "utf8"));

/* ────────────────────────────── word error rate ─────────────────────────── */

test("WER counts substitutions, deletions and insertions against the reference length", () => {
  assert.deepEqual(wordErrorRate("what time is it", "what time is it"), { wer: 0, substitutions: 0, deletions: 0, insertions: 0, referenceWords: 4 });
  // one substitution in four words
  assert.deepEqual(wordErrorRate("what time is it", "what time is that"), { wer: 0.25, substitutions: 1, deletions: 0, insertions: 0, referenceWords: 4 });
  // one deletion
  assert.equal(wordErrorRate("turn off the kitchen light", "turn off kitchen light").wer, 0.2);
  // one insertion, against a three-word reference
  assert.equal(wordErrorRate("turn the volume up", "turn the volume up please").wer, 1 / 4);
  // an empty hypothesis is every word lost, not a division by zero
  assert.deepEqual(wordErrorRate("volume up", ""), { wer: 1, substitutions: 0, deletions: 2, insertions: 0, referenceWords: 2 });
  assert.equal(wordErrorRate("", "").wer, 0);
});

test("WER normalises case and punctuation but not meaning", () => {
  assert.equal(wordErrorRate("Turn off the light.", "turn off the light").wer, 0);
  assert.equal(wordErrorRate("what is 20% of 150", "what is 20 % of 150").wer, 0);
  // A word that changes the command is still a word error, and stays visible.
  assert.equal(wordErrorRate("remind me at two", "remind me at noon").wer, 1 / 4);
});

/* ───────────────────────────── command accuracy ─────────────────────────── */

test("command accuracy is pass/fail on tool and arguments, not on wording", () => {
  const expectTool = { intent: "calculator", args: { expression: "20/100*150" } };
  assert.equal(scoreCommand("what is 20% of 150", expectTool).ok, true);
  // Same words, different tool: the sentence sounds right and does the wrong thing.
  const wrongTool = scoreCommand("what time is it", expectTool);
  assert.equal(wrongTool.ok, false);
  assert.equal(wrongTool.intent, "time_now");
  // Right tool, wrong argument.
  const wrongArgs = scoreCommand("remind me to call mum in 20 minutes", { intent: "remind", args: { text: "call dad", when: "in 20 minutes" } });
  assert.equal(wrongArgs.ok, false);
  assert.equal(wrongArgs.argsMatch, false);
});

test("a transcript that routes nowhere is a miss, not an error", () => {
  const result = scoreCommand("turn on the kitchen light", { intent: null, args: {} });
  assert.equal(result.ok, true, "no tool was the right answer");
  const missed = scoreCommand("turn on the kitchen light", { intent: "time_now", args: {} });
  assert.equal(missed.ok, false);
  assert.equal(missed.intent, null);
});

/* ──────────────────────────────── the corpus ────────────────────────────── */

test("the corpus is versioned, synthetic, text-only and licensed for redistribution", () => {
  assert.equal(corpus.version, 1);
  assert.equal(corpus.synthetic, true);
  assert.equal(corpus.license, "CC0-1.0");
  assert.match(corpus.provenance, /no recordings of real people/i);
  assert.ok(corpus.utterances.length >= 40, `only ${corpus.utterances.length} utterances`);
  const ids = new Set(corpus.utterances.map((u) => u.id));
  assert.equal(ids.size, corpus.utterances.length, "duplicate utterance id");
  for (const utterance of corpus.utterances) {
    assert.match(utterance.id, /^[a-z][a-z0-9-]{2,63}$/);
    assert.ok(["clean", "accented", "noisy", "numbers-names"].includes(utterance.condition), utterance.condition);
    assert.equal(typeof utterance.reference, "string");
    assert.ok(utterance.reference.trim().length > 2);
    assert.equal(typeof utterance.hypothesis, "string");
    assert.ok(utterance.expect && "intent" in utterance.expect, `${utterance.id} has no expected intent`);
    // Text only. There is no audio in this repository and there must not be.
    assert.equal(utterance.audio, undefined, `${utterance.id} carries audio`);
  }
  const conditions = new Set(corpus.utterances.map((u) => u.condition));
  assert.deepEqual([...conditions].sort(), ["accented", "clean", "noisy", "numbers-names"]);
});

/* ─────────────────────────────── the runner ─────────────────────────────── */

const report = await evaluateSpeech();

test("the runner is deterministic: two runs produce the same report", async () => {
  const again = await evaluateSpeech();
  assert.deepEqual(again.conditions, report.conditions);
  assert.deepEqual(again.headline, report.headline);
});

test("every reported number carries its sample count", () => {
  for (const [condition, row] of Object.entries(report.conditions)) {
    assert.equal(typeof row.samples, "number", `${condition} has no sample count`);
    assert.equal(row.commandAccuracy.samples, row.samples);
    assert.equal(row.wer.samples, row.samples);
    for (const value of [row.wer.value, row.commandAccuracy.value]) {
      assert.ok(value === null || typeof value === "number");
    }
    if (row.wer.value !== null) assert.equal(row.wer.reported, true);
  }
  assert.equal(report.conditions.clean.samples, corpus.utterances.filter((u) => u.condition === "clean").length);
});

test("a condition with too few samples withholds its number instead of printing one", async () => {
  // Deliberately under-sampled: the rule has to be exercised, not just described.
  const thinCorpus = {
    ...corpus,
    utterances: corpus.utterances.filter((u) => u.condition === "noisy").slice(0, MIN_CONDITION_SAMPLES - 4),
  };
  const thin = await evaluateSpeech({ corpus: thinCorpus });
  const row = thin.conditions.noisy;
  assert.equal(row.samples, MIN_CONDITION_SAMPLES - 4);
  assert.equal(row.wer.value, null);
  assert.equal(row.commandAccuracy.value, null);
  assert.equal(row.wer.reported, false);
  assert.match(row.wer.reason, /withheld/i);
});

test("the headline is withheld unless every condition clears the minimum", async () => {
  // The shipped corpus clears it everywhere, so the headline prints...
  assert.equal(report.headline.reported, true);
  assert.equal(typeof report.headline.wer, "number");
  assert.deepEqual(report.headline.withheld, []);
  assert.ok(Object.values(report.conditions).every((row) => row.samples >= MIN_CONDITION_SAMPLES));
  // ...and the same corpus, thinned, does not.
  const thinCorpus = { ...corpus, utterances: corpus.utterances.filter((u) => u.condition !== "accented").concat(corpus.utterances.filter((u) => u.condition === "accented").slice(0, 3)) };
  const thin = await evaluateSpeech({ corpus: thinCorpus });
  assert.equal(thin.headline.reported, false);
  assert.equal(thin.headline.wer, null);
  assert.match(thin.headline.reason, /withheld/i);
  assert.deepEqual(thin.headline.withheld, ["accented"]);
});

test("command accuracy is reported separately from WER, with the misses named", () => {
  assert.equal(typeof report.conditions.clean.commandAccuracy.value, "number");
  assert.equal(typeof report.conditions.clean.wer.value, "number");
  assert.ok(report.misses.length > 0, "no miss was named, so the report cannot be acted on");
  for (const miss of report.misses) {
    assert.ok(miss.id && miss.condition);
    assert.ok("expected" in miss && "got" in miss);
  }
  // A named miss must be a real one: the clean condition should not be full of them.
  assert.ok(report.misses.filter((m) => m.condition === "clean").length <= 1);
});

test("measured and unmeasured are distinguishable in the report", () => {
  assert.match(report.scope.performed, /word error rate and command accuracy over a text corpus/i);
  assert.match(report.scope.notPerformed, /physical microphone/i);
  assert.match(report.provenance, /hand-authored-synthetic/);
});

test("the rendered report states sample counts, the withheld headline and the hardware caveat", () => {
  const markdown = renderSpeechEvaluation(report);
  assert.match(markdown, /# Speech accuracy evaluation — corpus v1/);
  assert.match(markdown, /\| Condition \| Utterances \| WER \| Command accuracy \|/);
  assert.match(markdown, /withheld/i);
  assert.match(markdown, /physical microphone/i);
  // A percentage without its count is the thing this report exists to prevent.
  assert.doesNotMatch(markdown, /WER:\s*\d+\.\d+%/, "a bare percentage appeared");
});

test("the corpus contains no audio files — the claim is text-only, so it is checked", async () => {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(new URL("../test-fixtures/speech/v1/", import.meta.url));
  const audio = entries.filter((name) => /\.(wav|mp3|ogg|m4a|flac|webm)$/i.test(name));
  assert.deepEqual(audio, [], `audio in the corpus: ${audio.join(", ")}`);
  assert.deepEqual(entries.sort(), ["corpus.json"]);
});

test("the committed baseline is the runner's own output, not a number typed by hand", async () => {
  const committed = await readFile(new URL("../docs/SPEECH-BASELINE-V1.md", import.meta.url), "utf8");
  assert.equal(committed.trimEnd(), renderSpeechEvaluation(report).trimEnd(), "docs/SPEECH-BASELINE-V1.md is stale — regenerate it");
  const status = await speechBaseline();
  assert.equal(status.baseline, "current");
  assert.equal(status.utterances, corpus.utterances.length);
  assert.equal(status.physicalMicrophone, false);
  assert.equal(status.corpusErrors, 0, "the corpus asks the router for something it cannot do");
});

test("the docs point at the report and separate it from hardware acceptance", async () => {
  const doc = await readFile(new URL("../docs/VOICE.md", import.meta.url), "utf8");
  const section = doc.slice(doc.indexOf("## How accurate is it"));
  assert.ok(section, "docs/VOICE.md has no accuracy section");
  assert.match(section, /SPEECH-BASELINE-V1\.md/, "the report location is not named");
  assert.match(section, /word error rate/i);
  assert.match(section, /command accuracy/i);
  assert.match(section, /not.*hardware acceptance|hardware acceptance/i);
});
