/**
 * Issue #60: "Talk to it and have it read replies back".
 *
 * These tests execute the speech-out code shipped in public/index.html, not a
 * copy of it. A fake SpeechSynthesis records the utterances a browser would
 * hear. The point is the behaviour a reader can open: opt-in, local-only voice,
 * serially queued replies, no network voice fallback and no dropped tail.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, Script } from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public", "index.html"), "utf8");

function speechBlock() {
  const start = html.indexOf("// speech-out:start");
  const end = html.indexOf("// speech-out:end");
  assert.ok(start > -1 && end > start, "the shipped speech-out block is missing — there is no behaviour to exercise");
  return html.slice(start, end);
}

/** Run the exact shipped source as a function body and hand back its symbols. */
const speech = new Function(`${speechBlock()}
return {
  speakableText, speechChunks, speechCut, speechHintText, createSpeechOut,
  SPEECH_MAX_REPLY_CHARS, SPEECH_MAX_UTTERANCE_CHARS,
};`)();

class FakeUtterance {
  constructor(text) { this.text = text; }
}

function harness(initialVoices = [{ name: "OS voice", lang: "en-IN", localService: true }]) {
  let voices = initialVoices;
  const spoken = [];
  const statuses = [];
  let canceled = 0;
  const synthesis = {
    getVoices: () => voices,
    speak: (utter) => { spoken.push(utter); },
    cancel: () => { canceled++; },
  };
  const out = speech.createSpeechOut({
    synthesis,
    Utterance: FakeUtterance,
    getVoices: () => voices,
    lang: () => "en-IN",
    onStatus: (s) => statuses.push({ ...s }),
  });
  return {
    out, spoken, statuses,
    get canceled() { return canceled; },
    setVoices: (next) => { voices = next; },
  };
}

function fakeElement(id = "") {
  return {
    id, textContent: "", innerHTML: "", value: "", title: "", hidden: false, disabled: false,
    dataset: {}, style: {}, children: [], options: [{ text: "EN·IN" }], selectedIndex: 0,
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    setAttribute(k, v) { this[k] = v; }, getAttribute(k) { return this[k]; }, removeAttribute() {},
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; }, remove() {}, after() {}, focus() {}, click() {},
    querySelector() { return fakeElement(); }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, scrollTop: 0, scrollHeight: 0,
  };
}

/** Run the whole shipped panel module with a fake DOM. Boot's network calls
 *  are removed; everything above them — including the speech-out wiring — runs. */
function bootPanel({ speak = "1", voices = [{ name: "OS voice", lang: "en-IN", localService: true }], synthesis = true } = {}) {
  let source = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, "the inline panel module is missing");
  const boot = /\(async function boot\(\) \{[\s\S]*?\}\)\(\);/;
  assert.ok(boot.test(source), "the boot block changed — update this harness");
  source = source.replace(boot, "");

  const elements = new Map();
  const spoken = [];
  class Utterance { constructor(text) { this.text = text; } }
  const synth = synthesis ? {
    getVoices: () => voices,
    speak: (utter) => { spoken.push(utter); },
    cancel() {}, addEventListener() {},
  } : undefined;
  class SpeechRecognition { start() {} stop() {} }
  class EventSource { addEventListener() {} close() {} }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    querySelectorAll: () => [], querySelector: () => fakeElement(), createElement: () => fakeElement(),
    addEventListener() {}, body: fakeElement("body"), documentElement: fakeElement("html"),
  };
  const window = {
    innerWidth: 1200, speechSynthesis: synth,
    SpeechSynthesisUtterance: synthesis ? Utterance : undefined,
    SpeechRecognition, addEventListener() {}, removeEventListener() {},
  };
  const context = createContext({
    console, document, window, PINCH_MARK: "<svg></svg>",
    localStorage: { getItem: (k) => (k === "pinch.speak" ? speak : null), setItem() {}, removeItem() {} },
    location: { search: "", origin: "http://127.0.0.1:7777", pathname: "/" },
    navigator: { language: "en-IN" }, performance: { now: () => 0 },
    requestAnimationFrame: (f) => f(), setInterval() {}, setTimeout() {}, clearTimeout() {},
    URL, URLSearchParams, AbortSignal, FormData, Blob, TextDecoder, EventSource,
    fetch: async () => ({ ok: true, json: async () => ({}), text: async () => "", body: { getReader() {} } }),
    alert() {}, confirm: () => false,
  });
  context.globalThis = context;
  context.window = window;
  window.navigator = context.navigator;
  source += "\nglobalThis.__speechOut = speechOut; globalThis.__hint = document.getElementById(\"voiceHint\").textContent;";
  runInContext(source, context, { filename: "public/index.html" });
  return { context, spoken, elements, synth };
}

test("the real panel module boots, reports a local voice and speaks a completed reply", () => {
  const { context, spoken } = bootPanel({ speak: "1" });
  assert.match(context.__hint, /replies use a local voice/);
  assert.equal(context.__speechOut.status().reason, "ready");
  context.__speechOut.speak("hello from the panel");
  assert.deepEqual(spoken.map((u) => u.text), ["hello from the panel"]);
  assert.equal(spoken[0].voice.localService, true);
});

test("a fresh panel stays silent until the shipped speak toggle is clicked", () => {
  const { context, spoken, elements } = bootPanel({ speak: null });
  assert.match(context.__hint, /tap 🔈 for spoken replies/);
  assert.equal(context.__speechOut.status().enabled, false);
  elements.get("speakToggle").onclick();
  assert.equal(context.__speechOut.status().enabled, true);
  assert.match(elements.get("voiceHint").textContent, /replies use a local voice/);
  context.__speechOut.speak("now on");
  assert.deepEqual(spoken.map((u) => u.text), ["now on"]);
});

test("a panel with only remote voices explains the silence and speaks nothing", () => {
  const { context, spoken } = bootPanel({ speak: "1", voices: [{ name: "Cloud", lang: "en-US", localService: false }] });
  assert.match(context.__hint, /no installed local voice/);
  assert.equal(context.__speechOut.speak("private answer"), false);
  assert.equal(spoken.length, 0);
});

test("a completed reply is spoken through an installed local voice, only after opt-in", () => {
  const h = harness();
  assert.equal(h.out.status().enabled, false, "spoken replies must not default on");
  assert.equal(h.out.speak("Hello there"), false);
  assert.equal(h.spoken.length, 0);

  h.out.setEnabled(true);
  assert.equal(h.out.status().reason, "ready");
  assert.equal(h.out.speak("Hello there"), true);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].text, "Hello there");
  assert.equal(h.spoken[0].voice.localService, true);
  assert.equal(h.spoken[0].voice.lang, "en-IN");
  assert.equal(h.spoken[0].lang, "en-IN");
  assert.equal(h.spoken[0].rate, 1);
});

test("a network-only or unlabelled voice is refused, not used as a silent offline fallback", () => {
  for (const voices of [
    [{ name: "Cloud", lang: "en-US", localService: false }],
    [{ name: "Unknown", lang: "en-US" }],
    [],
  ]) {
    const h = harness(voices);
    h.out.setEnabled(true);
    assert.equal(h.out.status().reason, "no-local-voice");
    assert.equal(h.out.speak("private answer"), false);
    assert.equal(h.spoken.length, 0, "a remote voice must never be handed to speechSynthesis");
    assert.equal(h.out.status().pending, 0);
    assert.ok(h.statuses.some((s) => s.reason === "no-local-voice"));
  }
});

test("the voice hint reports the real state instead of promising a browser list", () => {
  const ready = { supported: true, localVoices: 1 };
  assert.match(speech.speechHintText(ready, { inputSupported: true, enabled: true }), /replies use a local voice/);
  assert.match(speech.speechHintText(ready, { inputSupported: true, enabled: false }), /tap 🔈 for spoken replies/);
  assert.match(speech.speechHintText({ supported: true, localVoices: 0 }, { inputSupported: true, enabled: true }), /no installed local voice/);
  assert.match(speech.speechHintText({ supported: false, localVoices: 0 }, { inputSupported: false, enabled: true }), /no speech input here.*spoken replies unsupported/);
});

test("voiceschanged can supply a local voice without a page reload", () => {
  const h = harness([]);
  h.out.setEnabled(true);
  assert.equal(h.out.status().reason, "no-local-voice");
  h.setVoices([{ name: "Tamil OS voice", lang: "ta-IN", localService: true }]);
  h.out.refreshVoices();
  assert.equal(h.out.status().reason, "ready");
  assert.equal(h.out.speak("வணக்கம்"), true);
  assert.equal(h.spoken[0].voice.lang, "ta-IN");
});

test("long replies are chunked at sentence boundaries and no words are dropped", () => {
  const sentence = "The quick brown fox jumps over the lazy dog. ";
  const reply = sentence.repeat(20);
  const clean = speech.speakableText(reply);
  const chunks = speech.speechChunks(clean);
  assert.ok(chunks.length > 1, "the old 600-character slice would have passed this");
  assert.ok(chunks.every((c) => c.length <= speech.SPEECH_MAX_UTTERANCE_CHARS));
  assert.ok(chunks[0].endsWith("."), "chunks should break at a sentence, not mid-word");
  assert.equal(chunks.join(" "), clean, "the tail of a long reply must still be spoken");

  const h = harness();
  h.out.setEnabled(true);
  assert.equal(h.out.speak(reply), true);
  assert.equal(h.spoken.length, 1, "speech starts with the first chunk, not after the whole reply");
  for (let i = 1; i < chunks.length; i++) h.spoken[i - 1].onend();
  assert.deepEqual(h.spoken.map((u) => u.text), chunks);
});

test("turning speech off cancels queued audio and ignores late callbacks", () => {
  const h = harness();
  h.out.setEnabled(true);
  h.out.speak("word ".repeat(200));
  const first = h.spoken[0];
  assert.ok(h.out.status().pending > 0);

  h.out.setEnabled(false);
  assert.equal(h.canceled, 1);
  assert.equal(h.out.status().speaking, false);
  assert.equal(h.out.status().pending, 0);
  const before = h.spoken.length;
  first.onend();
  first.onerror();
  assert.equal(h.spoken.length, before, "a cancelled utterance must not drain the old queue");
});

test("a new reply replaces an old queue instead of talking over it", () => {
  const h = harness();
  h.out.setEnabled(true);
  h.out.speak("first sentence. ".repeat(100));
  const old = h.spoken[0];
  const before = h.spoken.length;

  h.out.speak("Second answer.", { replace: true });
  assert.equal(h.canceled, 1);
  assert.equal(h.spoken.length, before + 1);
  assert.equal(h.spoken.at(-1).text, "Second answer.");
  old.onerror();
  assert.equal(h.spoken.length, before + 1);
});

test("model-controlled markup, code and guard footers are not read aloud", () => {
  const raw = [
    "Here is **the answer** [1]. <img src=x onerror=alert(1)>",
    "[see more](https://example.test/a)",
    "```<script>alert(2)</script>```",
    "🛡️ **Code check:** invented citation [9]",
  ].join("\n");
  const clean = speech.speakableText(raw);
  assert.match(clean, /Here is the answer/);
  assert.match(clean, /see more/);
  assert.doesNotMatch(clean, /<script|onerror|alert|```|\*\*|Code check|https?:\/\//i);
  assert.doesNotMatch(clean, /invented citation/);

  const h = harness();
  h.out.setEnabled(true);
  h.out.speak(raw);
  assert.equal(h.spoken[0].text, clean);
});

test("unclosed tags in model output cannot make the speech sanitizer scan quadratically", () => {
  const raw = "<".repeat(19_000) + " hello";
  const started = performance.now();
  const clean = speech.speakableText(raw);
  assert.ok(performance.now() - started < 2000, "the bounded lookahead regressed into an O(n²) scan");
  assert.ok(clean.startsWith("<"), "a literal '<' with no closing '>' is text, not a tag");
  assert.match(clean, /Reply continues on screen\.$/);
});

test("spoken output is bounded and the shipped speech-out code makes no network calls", () => {
  const clean = speech.speakableText("A ".repeat(5000));
  assert.ok(clean.length <= speech.SPEECH_MAX_REPLY_CHARS + 40);
  assert.match(clean, /Reply continues on screen\.$/);

  const source = speechBlock();
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|https?:\/\//i);

  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("speech-out must not fetch"); };
  try {
    const h = harness();
    h.out.setEnabled(true);
    assert.equal(h.out.speak("Still local."), true);
    assert.equal(h.spoken.length, 1);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("the shipped panel module still parses after the speech-out wiring", () => {
  const source = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, "the inline panel module is missing");
  assert.doesNotThrow(() => new Script(source, { filename: "public/index.html" }));
});

test("the shipped panel wires the player to completed replies and an opt-in toggle", () => {
  assert.match(html, /speechOut\.speak\(answer, \{ replace: true \}\)/);
  assert.match(html, /speechOut\.speak\(data\.text\)/);
  assert.match(html, /speechOut\.stop\(\)/);
  assert.match(html, /speechOut\.setEnabled\(store\.speak\)/);
  assert.match(html, /localStorage\.getItem\("pinch\.speak"\) === "1"/);
  assert.match(html, /voiceschanged/);
  assert.match(html, /localService === true/);
  assert.match(html, /speechHintText\(s, \{ inputSupported: Boolean\(SR\)/);
  assert.doesNotMatch(html, /enqueueSpeech\(|stopSpeech\(|stripGuardNote\(/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/i, "the panel must not load a remote script");
});

test("the voice inventory claims 'have' and cites evidence a reader can open", () => {
  const data = JSON.parse(readFileSync(join(root, "docs", "CAPABILITIES.json"), "utf8"));
  const voice = data.capabilities.find((c) => c.id === "voice");
  assert.ok(voice, "the voice capability disappeared from the inventory");
  assert.equal(voice.status, "have");
  assert.equal(voice.policy, "in-scope");
  for (const needle of ["public/index.html", "desktop/Companion.cs", "test/voice-reply.test.js", "docs/VOICE.md"]) {
    assert.ok(voice.evidence.some((e) => e.includes(needle)), `missing evidence: ${needle}`);
  }
  for (const ev of voice.evidence) {
    const path = ev.split(":")[0].trim();
    if (path.includes("/")) assert.ok(existsSync(join(root, path)), `evidence does not exist: ${path}`);
  }
  assert.match(voice.note, /local voice|localService/i);
  assert.match(voice.note, /opt-in/i);
  assert.match(voice.note, /browser vendor/i);
});

test("the docs no longer claim browser dictation always stays on the device", () => {
  for (const file of ["docs/GUIDE.md", "docs/CHANNELS.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.doesNotMatch(text, /audio never leaves the device/i, `${file} still overclaims privacy`);
    assert.doesNotMatch(text, /matches locally; audio never leaves/i, `${file} still overclaims privacy`);
    assert.match(text, /may send\s+microphone audio to the browser vendor/i, `${file} needs the browser-recognition caveat`);
  }
});
