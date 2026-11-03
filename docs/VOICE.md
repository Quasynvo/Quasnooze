# Voice: the evidence and the boundary

**Issue:** [Quasynvo/Quasnooze#60](https://github.com/Quasynvo/Quasnooze/issues/60) — *Talk to it and
have it read replies back*. **Date:** 2026-11-02. **Status:** implemented in this tree; a human
still reviews and merges. The old inventory said `partial` and claimed replies were not spoken
back. That was stale: the web panel already had a speak toggle, but it could silently choose a
network voice, cut off the tail of long replies, and had no behavioural test. This change makes
the claim true and checks it.

---

## The capability, one path at a time

> **Fluid Motion update:** the new `/visualizer.html` playground adds explicitly opt-in, local Web Audio frequency analysis. It does not transcribe speech or change the recognition paths below. `/cosmic.html` and `/desktop.html` visualize existing state without opening browser capture. Native speaking currently has no output FFT feed, so its spectrum is decorative. See [VISUALIZER.md](VISUALIZER.md) for the signal contract.

| Path | Talk to it | Reads replies back | Needs configuration? |
|---|---|---|---|
| [Web panel](../public/index.html) (`/index.html`) | browser `SpeechRecognition` dictation and opt-in wake word | **yes** — `createSpeechOut()` + installed local `SpeechSynthesisVoice` | no. No `WHISPER_URL`, account, server endpoint or package |
| [Windows voice host](../desktop/Companion.cs) | local `System.Speech` wake/dictation | **yes** — `SpeechSynthesizer` | `npm run desktop` on Windows; see [DESKTOP.md](DESKTOP.md) |
| Recorded voice notes | optional OpenAI-compatible Whisper endpoint (`/api/transcribe`) | text reply only | `WHISPER_URL`, see [GUIDE.md](GUIDE.md#optional-whisper-transcription-api) |
| Telegram / Discord / Slack / WhatsApp | voice notes where the channel supports them | **no** — text only | channel setup |

The `voice` entry in [CAPABILITIES.json](CAPABILITIES.json) is `have` because the first two paths
are real, openable and tested. It does **not** claim that every channel gets audio replies.

---

## Why spoken replies work offline out of the box

- The web panel's speech-out block accepts only voices whose `localService` is exactly `true`.
  A remote-only voice, an unlabelled voice or an empty voice list makes the player stay silent
  and show `no installed local voice` in the hint. It never falls back to a network voice.
- The block contains no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, external script or
  URL. It hands plain text to `SpeechSynthesisUtterance`; the browser/OS voice does the audio.
- The original speech-out change added no endpoint, secret, cookie, dependency or config key. The later Fluid Motion update adds public static modules only; it still adds no speech endpoint or audio configuration key.
- Spoken replies are **opt-in per device** (`pinch.speak` in `localStorage`), off by default. The
  first `speak()` follows a click — the toggle or Send — which also satisfies browser autoplay
  rules. Turning the toggle off calls `cancel()` and clears the queue.

The honest limit: we can refuse a voice the browser labels as remote, but we cannot audit a
closed-source browser's speech engine internals. **Browser dictation may send microphone audio to
the browser vendor** (Chrome in particular), even before a command follows a wake word. For a
path where recognition *and* synthesis stay on the machine, use the Windows voice host. The old
claim that browser audio never leaves the device was wrong and has been corrected in
[GUIDE.md](GUIDE.md#voice-on-your-phone) and [CHANNELS.md](CHANNELS.md#wake-word).

---

## What a spoken reply does

1. Complete answers and live reminders are passed to `speakableText()`: fenced code, HTML-ish
   tags, Markdown emphasis, citation markers and the 🛡️ guard footer are removed; a reminder
   prefix becomes plain `Reminder:`. Tag scanning uses a bounded 200-character lookahead rather
   than a backtracking regex. Model output never reaches the speech engine as markup.
2. A reply is bounded at 2,000 characters. If it is longer, the tail is **not silently lost** —
   the spoken text ends with `Reply continues on screen.` and the full answer stays in the panel.
3. The text is split at sentence or word boundaries into utterances of at most 240 characters.
   They are spoken serially through `onend`/`onerror`; a new turn replaces the old queue, and a
   generation counter makes callbacks from a cancelled utterance inert.
4. The selected voice's own `lang` is used, so an installed `ta-IN` voice is chosen for Tamil
   dictation rather than an English network voice. A `voiceschanged` event refreshes the list
   without a reload.

---

## Reproduce

```bash
# The behavioural proof: fake speechSynthesis, real shipped speech-out code.
node --test test/voice-reply.test.js

# The full gate.
npm test
npm run audit

# Manual check (no model needed).
LLM_PROVIDER=mock QUASNOOZE_KEY= npm start
```

Open `http://localhost:7777/index.html` (the default `/` is the command deck), tap **🔈** once,
then send `hello`. The hint changes to `🔊 replies use a local voice`, the mock answer is read,
and tapping **🔊** again stops it. With no installed local voice the hint says
`🔈 no installed local voice`, a toast explains why, and no utterance is created.

`test/voice-reply.test.js` extracts the `// speech-out:start` … `// speech-out:end` block from the
shipped HTML and drives it with a fake `SpeechSynthesis`; it also runs the **whole panel module**
with a fake DOM so the toggle, hint and player are exercised as wired. It covers opt-in,
local-only voice selection, the honest hint text, `voiceschanged`, sentence-boundary chunking with
no dropped words, cancel/replace races, markup/code/guard stripping, the length cap, the absence
of network calls, a bounded tag-scan probe, the panel wiring, and the inventory evidence. Remove `createSpeechOut()` or reintroduce a network-voice
fallback and the suite goes red.

---

## Risk, read against [AUDIT.md](AUDIT.md)

| Audit finding | Why this change does not reopen it |
|---|---|
| #3 foreign Origin could drive the assistant | no new HTTP endpoint, cookie or request path; speech-out is entirely client-side |
| #4 DNS rebinding via `Host` | unchanged server routing and allowlist |
| #5 model-output HTML injection in the panel | spoken text is stripped to plain characters before `SpeechSynthesisUtterance`; the visual `md()` renderer is untouched |
| #2 credentials in child environments | no child process, no shell, no new environment variable |
| #14 an answer could start a second turn | speech-out never calls `/api/chat`; it only receives an already-completed answer |

New, smaller risks and their answers: a spoken reply can be **overheard** — hence opt-in, a
visible toggle, immediate cancel and a length cap; a poisoned reply could try to make the device
read a lot of text — hence the 20,000-character scan cap, bounded tag lookahead, 2,000-character
spoken cap and bounded utterances; a cancelled engine can fire a late callback — hence the
generation counter. No real
speaker or microphone hardware was available in the Linux CI sandbox; the native Windows path is
covered by [VOICE-REVIEW.md](VOICE-REVIEW.md) and Windows CI, not by a claim of universal audio
accuracy.

---

## Cost: what we stopped doing

Every yes is a no to something. This one says no to:

- **A server-side TTS endpoint.** No `/api/speak`, no audio codec, no `espeak`/`piper` process
  spawned from model-controlled text, no new upload or download surface. That is the smallest
  change that makes the capability real, not the most impressive one.
- **Audio replies in chat apps.** Telegram, Discord, Slack and WhatsApp still get text. Matching a
  hosted assistant's voice UX across every channel would mean an audio pipeline and a much larger
  review surface.
- **Silent network voices and silent truncation.** Remote voices are refused rather than used as
  a convenience fallback; long answers are chunked rather than cut at 600 characters. Both are
  visible behaviour changes a user might notice.
- **The old privacy sentence.** `audio never leaves the device until a command follows` was not
  true of browser recognition. Correcting the guide costs a flattering claim.
- **A dependency, a config key and an always-on microphone.** None were added.

What it costs to maintain: one more ~150-line state machine in the panel, one more hint string,
and seventeen focused tests. What it buys: a capability inventory that is no longer wrong in the
flattering direction, and a reader who can open the code, run the test and hear the answer.

---

## What is not claimed

- Not full-duplex conversation or barge-in. Speech starts from a completed answer, not streamed
  tokens; see [CONVERSATION.md](CONVERSATION.md#spoken-back-and-forth).
- Not local browser recognition. Only the Windows voice host guarantees on-device recognition.
- Not speech in every browser. A browser without `speechSynthesis`, or one with no installed
  local voice, gets a visible explanation and silence — not a hidden cloud call.
- Not a hardware voice-quality or latency benchmark. The test proves *that* the shipped code
  calls a local voice with the right text; it does not prove how good that voice sounds.
