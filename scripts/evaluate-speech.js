#!/usr/bin/env node
/**
 * evaluate-speech.js — how well does it hear, and does it hear the *right thing*?
 *
 * The README says voice accuracy has not been measured on physical hardware, and
 * that remains true. What this measures is narrower and checkable offline:
 *
 *   • **word error rate** — how close a transcript is to the words that were said;
 *   • **command accuracy** — whether that transcript selects the intended tool
 *     with the intended arguments.
 *
 * They are deliberately two numbers. "Turn off the kitchen light" heard as "turn
 * off the kitchen lite" is one word wrong and the same command; "remind me at
 * two" heard as "remind me at noon" is one word wrong and the wrong reminder. A
 * single percentage averages the harmless case with the harmful one.
 *
 * Both layers of the corpus are honest about what they are:
 *   - the **hypotheses** are hand-authored text (see `provenance`), so the WER
 *     here is a property of a fixture, not of any model;
 *   - the **references** are run through the real deterministic router
 *     (`matchFastIntent`), so command accuracy on the reference layer is a live
 *     measurement of this checkout — and a check that the corpus expectations are
 *     satisfiable at all.
 *
 * Every number carries its sample count, and a condition below the minimum
 * reports "withheld" rather than a percentage. A WER from three samples is a
 * coincidence with a decimal point.
 *
 * Usage:
 *   node scripts/evaluate-speech.js           # markdown report
 *   node scripts/evaluate-speech.js --json    # machine-readable
 */
import { readFile } from "node:fs/promises";
import { matchFastIntent } from "../src/fast-path.js";

const FIXTURE = new URL("../test-fixtures/speech/v1/corpus.json", import.meta.url);

export const CORPUS_VERSION = 1;
/** Below this, a condition's numbers are withheld instead of published. */
export const MIN_CONDITION_SAMPLES = 8;
export const CONDITIONS = Object.freeze(["clean", "accented", "noisy", "numbers-names"]);

/** Lowercase, punctuation to spaces, collapse. "18%" and "18 %" are the same word. */
export function normalizeWords(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Word-level Levenshtein with the edit operations kept apart.
 * WER = (S + D + I) / reference words. An empty reference with an empty
 * hypothesis is 0; an empty hypothesis is every word lost.
 */
export function wordErrorRate(reference, hypothesis) {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  const n = ref.length;
  const m = hyp.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + same);
    }
  }
  let i = n, j = m, substitutions = 0, deletions = 0, insertions = 0;
  while (i > 0 && j > 0) {
    if (ref[i - 1] === hyp[j - 1] && d[i][j] === d[i - 1][j - 1]) { i--; j--; continue; }
    if (d[i][j] === d[i - 1][j - 1] + 1) { substitutions++; i--; j--; continue; }
    if (d[i][j] === d[i - 1][j] + 1) { deletions++; i--; continue; }
    insertions++; j--;
  }
  deletions += i;
  insertions += j;
  return {
    wer: n === 0 ? (m === 0 ? 0 : 1) : (substitutions + deletions + insertions) / n,
    substitutions, deletions, insertions, referenceWords: n,
  };
}

const NUMBER_WORDS = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13",
  fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
  seventy: "70", eighty: "80", ninety: "90", hundred: "100", thousand: "1000",
};
const singular = (word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);

/**
 * Arguments are compared after normalising the differences that cannot change
 * what happens: number words ("in two hours" ≡ "in 2 hours") and plurals ("in 30
 * minute" ≡ "in 30 minutes"). Without this, the cosmetic errors this report
 * exists to forgive would be scored as broken commands, and the two numbers it
 * keeps apart would collapse into one.
 */
const normalizeArg = (value) =>
  normalizeWords(value).map((word) => (NUMBER_WORDS[word] ?? word)).map(singular).join(" ");

/**
 * Did this transcript select the intended tool with the intended arguments?
 *
 * `intent: null` means "no tool was the right answer", which is a real
 * expectation: "tell me a joke" must not fire the calculator. A transcript that
 * routes nowhere when a tool was expected is a miss, not an error — the assistant
 * would simply answer as chat, which is the failure this number exists to expose.
 */
export function scoreCommand(transcript, expect) {
  const routed = matchFastIntent(String(transcript ?? ""));
  const intent = routed?.name ?? null;
  const args = routed?.args ?? {};
  const intentMatch = intent === (expect?.intent ?? null);
  let argsMatch = true;
  for (const [key, value] of Object.entries(expect?.args ?? {})) {
    if (normalizeArg(args[key]) !== normalizeArg(value)) argsMatch = false;
  }
  return { ok: intentMatch && argsMatch, intent, expected: expect?.intent ?? null, argsMatch, got: args };
}

function validateCorpus(corpus) {
  if (corpus.version !== CORPUS_VERSION) throw new Error(`Unsupported corpus version ${corpus.version}`);
  if (corpus.synthetic !== true) throw new Error("The corpus must declare itself synthetic");
  if (!/^[A-Za-z0-9.+-]+$/.test(String(corpus.license || ""))) throw new Error("The corpus must name a redistributable licence");
  // Low on purpose: a deliberately thinned corpus is a legal input, and the
  // withheld rule can only be shown to work by feeding one in.
  if (!Array.isArray(corpus.utterances) || corpus.utterances.length < 4) throw new Error("The corpus is too small to score");
  const seen = new Set();
  for (const utterance of corpus.utterances) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(utterance.id)) throw new Error(`Invalid utterance id ${utterance.id}`);
    if (seen.has(utterance.id)) throw new Error(`Duplicate utterance id ${utterance.id}`);
    seen.add(utterance.id);
    if (!CONDITIONS.includes(utterance.condition)) throw new Error(`${utterance.id}: unknown condition ${utterance.condition}`);
    if (!utterance.expect || !("intent" in utterance.expect)) throw new Error(`${utterance.id}: no expected intent`);
    // The corpus is text-only on purpose: no audio, no paths to audio.
    if (utterance.audio !== undefined) throw new Error(`${utterance.id}: the corpus must not carry audio`);
  }
  return corpus;
}

const ratio = (value) => (value === null ? null : Number(value.toFixed(4)));

function withheldRow(samples, reason) {
  return { samples, value: null, reported: false, reason };
}

/**
 * Score the corpus. `corpus` is injectable so a test can hand in an
 * under-sampled one and prove the refusal rule rather than trusting it.
 */
export async function evaluateSpeech({ corpus: injected = null, now = Date.now() } = {}) {
  const started = now;
  const corpus = validateCorpus(injected ?? JSON.parse(await readFile(FIXTURE, "utf8")));
  const conditions = {};
  const misses = [];
  const corpusErrors = [];

  for (const condition of CONDITIONS) {
    const rows = corpus.utterances.filter((u) => u.condition === condition);
    if (!rows.length) continue;
    let errors = 0, words = 0, substitutions = 0, deletions = 0, insertions = 0;
    let commandHits = 0, referenceHits = 0;
    for (const row of rows) {
      const distance = wordErrorRate(row.reference, row.hypothesis);
      errors += distance.substitutions + distance.deletions + distance.insertions;
      words += distance.referenceWords;
      substitutions += distance.substitutions;
      deletions += distance.deletions;
      insertions += distance.insertions;

      const heard = scoreCommand(row.hypothesis, row.expect);
      if (heard.ok) commandHits++;
      else {
        misses.push({
          id: row.id, condition,
          expected: row.expect.intent ?? null,
          got: heard.intent ?? null,
          expectedArgs: row.expect.args ?? {},
          gotArgs: heard.got ?? {},
          said: row.hypothesis,
        });
      }

      // The reference layer is the live one: real router, this checkout. A miss
      // here is a corpus bug, not an accuracy result, so it is reported apart.
      const intended = scoreCommand(row.reference, row.expect);
      if (intended.ok) referenceHits++;
      else corpusErrors.push({ id: row.id, expected: row.expect.intent, got: intended.intent, reference: row.reference });
    }
    const samples = rows.length;
    const reportable = samples >= MIN_CONDITION_SAMPLES;
    const reason = `withheld: ${samples} sample${samples === 1 ? "" : "s"} is below the ${MIN_CONDITION_SAMPLES}-sample minimum`;
    conditions[condition] = {
      samples,
      reportable,
      wer: reportable
        ? { samples, value: ratio(errors / Math.max(1, words)), reported: true, reason: null, substitutions, deletions, insertions, referenceWords: words }
        : { ...withheldRow(samples, reason), substitutions, deletions, insertions, referenceWords: words },
      commandAccuracy: reportable
        ? { samples, value: ratio(commandHits / samples), reported: true, reason: null, hits: commandHits }
        : { ...withheldRow(samples, reason), hits: commandHits },
      referenceAccuracy: { samples, value: ratio(referenceHits / samples), hits: referenceHits },
    };
  }

  const withheld = Object.entries(conditions).filter(([, row]) => !row.reportable).map(([name]) => name);
  const totals = Object.values(conditions).reduce(
    (acc, row) => ({
      samples: acc.samples + row.samples,
      errors: acc.errors + row.wer.substitutions + row.wer.deletions + row.wer.insertions,
      words: acc.words + row.wer.referenceWords,
      hits: acc.hits + row.commandAccuracy.hits,
    }),
    { samples: 0, errors: 0, words: 0, hits: 0 },
  );

  const headline = withheld.length
    ? { wer: null, commandAccuracy: null, reported: false, withheld, reason: `withheld: ${withheld.join(", ")} below the ${MIN_CONDITION_SAMPLES}-sample minimum` }
    : {
        wer: ratio(totals.errors / Math.max(1, totals.words)),
        commandAccuracy: ratio(totals.hits / totals.samples),
        samples: totals.samples,
        reported: true,
        withheld,
        reason: null,
      };

  return {
    schemaVersion: 1,
    corpusVersion: corpus.version,
    corpus: corpus.name,
    license: corpus.license,
    synthetic: true,
    // Provenance is a field, not a footnote: nobody should have to guess whether
    // a WER here came from a model.
    provenance: "hand-authored-synthetic",
    corpusNote: corpus.provenance,
    scope: {
      performed: "Word error rate and command accuracy over a text corpus, scored by the shipped deterministic router. Deterministic and offline: no model, no audio, no network.",
      notPerformed: "No physical microphone, no acoustic model, no recording of a real person, and no hardware acceptance. The hypotheses are authored text, so the WER measures the fixture; the reference layer measures this checkout's router.",
    },
    definitions: {
      wer: "Word error rate = (substitutions + deletions + insertions) / reference words, corpus-level per condition after lowercasing and stripping punctuation.",
      commandAccuracy: "Command accuracy = the heard transcript routes to the expected tool with the expected arguments, compared after normalising number words and plurals, so a cosmetic word error is not scored as a broken command. `intent: null` means no tool was correct. Measured on the hypotheses.",
      referenceAccuracy: "The same measure on the reference transcripts. It should be 1.0; anything less is a corpus expectation that the router cannot satisfy, and is listed under corpusErrors.",
      samples: "Every value carries its sample count. A condition under the minimum reports withheld rather than a percentage.",
    },
    conditions,
    headline,
    misses,
    corpusErrors,
    totals: { samples: totals.samples, referenceWords: totals.words, errors: totals.errors },
    elapsedMs: Date.now() - started,
  };
}

const pct = (value) => (value === null ? "withheld" : `${(value * 100).toFixed(1)}%`);

/**
 * One markdown table cell. Backslashes are escaped along with the pipe and
 * newlines are flattened: escaping `|` alone would let a transcript ending in a
 * backslash escape the escape and break the table (CodeQL
 * js/incomplete-sanitization).
 */
const cell = (value) => String(value ?? "").replace(/[\\|]/g, (ch) => `\\${ch}`).replace(/\r?\n/g, " ");

/** `remind text="call mum"` reads better than a bare tool name when the args are the miss. */
const describe = (intent, args) => {
  if (!intent) return "(no tool)";
  const pairs = Object.entries(args ?? {}).map(([key, value]) => `${key}="${String(value).replace(/"/g, "'")}"`);
  return pairs.length ? `${intent} ${pairs.join(" ")}` : intent;
};

export function renderSpeechEvaluation(report) {
  return [
    "# Speech accuracy evaluation — corpus v1",
    "",
    `**Corpus:** \`${report.corpus}\` v${report.corpusVersion}, ${report.totals.samples} utterances, licence ${report.license}. **Hypotheses from:** \`${report.provenance}\`.`,
    `**Headline:** ${report.headline.reported ? `word error rate ${pct(report.headline.wer)} and command accuracy ${pct(report.headline.commandAccuracy)} over ${report.headline.samples} utterances` : `withheld — ${report.headline.reason}`}.`,
    "",
    ...Object.values(report.definitions).map((text) => `- ${text}`),
    "",
    "| Condition | Utterances | WER | Command accuracy | Reference accuracy |",
    "|---|---:|---:|---:|---:|",
    ...Object.entries(report.conditions).map(([name, row]) =>
      `| ${name} | ${row.samples} | ${pct(row.wer.value)} | ${pct(row.commandAccuracy.value)} | ${pct(row.referenceAccuracy.value)} |`),
    "",
    "## What was measured, and what was not",
    "",
    `- **Measured:** ${report.scope.performed}`,
    `- **Not measured:** ${report.scope.notPerformed}`,
    "",
    report.misses.length ? "## Command misses (the transcript heard a different command)" : "## Command misses",
    "",
    report.misses.length
      ? "| Utterance | Condition | Wanted | Heard | Transcript |\n|---|---|---|---|---|\n" +
        report.misses.map((miss) =>
          `| ${cell(miss.id)} | ${cell(miss.condition)} | ${cell(describe(miss.expected, miss.expectedArgs))} | ${cell(describe(miss.got, miss.gotArgs))} | ${cell(miss.said)} |`).join("\n")
      : "None.",
    "",
    report.corpusErrors.length ? "## Corpus expectations the router cannot satisfy" : "## Corpus expectations",
    "",
    report.corpusErrors.length ? "```json\n" + JSON.stringify(report.corpusErrors, null, 2) + "\n```" : "Every reference transcript routes as the corpus expects.",
    "",
    "This is not hardware acceptance. There is no microphone, no acoustic model and no recording of a real person in this corpus, so these numbers cannot say how well the product hears you in a kitchen. They say what the shipped router does with a transcript, and how far a plausible transcript drifts from the words that were said. See docs/VOICE.md for the method and docs/SPEECH-BASELINE-V1.md for this report as committed.",
    "",
    "<!-- Generated by `node scripts/evaluate-speech.js`. Do not edit by hand: the test suite compares this file with the runner's output, so a stale number fails the build rather than sitting here looking measured. -->",
    "",
  ].join("\n");
}

/* ──────────────────────── status, for `npm run health` ──────────────────── */

const BASELINE_DOC = new URL("../docs/SPEECH-BASELINE-V1.md", import.meta.url);

/**
 * A few facts a diagnostics screen can print without pretending to a percentage:
 * the corpus size, the per-condition sample counts, and whether the committed
 * baseline still matches what the runner produces. Offline, deterministic, no
 * microphone.
 */
export async function speechBaseline() {
  const report = await evaluateSpeech();
  const committed = await readFile(BASELINE_DOC, "utf8").catch(() => null);
  const rendered = renderSpeechEvaluation(report);
  return {
    corpus: report.corpus,
    version: report.corpusVersion,
    utterances: report.totals.samples,
    minSamples: MIN_CONDITION_SAMPLES,
    conditions: Object.fromEntries(Object.entries(report.conditions).map(([name, row]) => [name, row.samples])),
    headline: report.headline.reported
      ? { reported: true, wer: report.headline.wer, commandAccuracy: report.headline.commandAccuracy, samples: report.headline.samples }
      : { reported: false, reason: report.headline.reason },
    misses: report.misses.length,
    corpusErrors: report.corpusErrors.length,
    baseline: committed === null ? "missing" : committed.trimEnd() === rendered.trimEnd() ? "current" : "stale",
    provenance: report.provenance,
    physicalMicrophone: false,
  };
}

/* ─────────────────────────────────── CLI ───────────────────────────────── */

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("evaluate-speech.js");
if (invokedDirectly) {
  const json = new Set(process.argv.slice(2)).has("--json");
  try {
    const report = await evaluateSpeech();
    console.log(json ? JSON.stringify(report, null, 2) : renderSpeechEvaluation(report));
    process.exit(report.corpusErrors.length ? 1 : 0);
  } catch (err) {
    console.error(`evaluate-speech: ${err.message}`);
    process.exit(2);
  }
}
