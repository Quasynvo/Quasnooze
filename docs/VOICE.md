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

## Latency budget

`telemetry.js` used to record one duration per turn, which is enough to notice a
regression and useless for locating one: a 2.4 s turn looks identical whether the
model was slow, the transcript took a second to settle, or audio started late.
Each record now carries a `stages` object — five numbers, each a duration in
milliseconds, each with a target.

| Stage | Target | Measured from → to | Why it is here |
|---|---:|---|---|
| `captureEndMs` | no target | microphone opened → speaker stopped | the utterance length; it is the anchor the browser stages are measured from, not a latency, so a long sentence is not mistaken for a slow turn |
| `endpointMs` | 300 ms | speaker stopped → endpoint decided (utterance closed, final transcript accepted) | the first half of "listen → text": the browser deciding you finished |
| `transcriptMs` | 300 ms | endpoint decided → request written to the server | the hand-off: debounce, serialisation, `fetch` |
| `firstTokenMs` | 700 ms | request reached the server → first assistant text ready to write | everything the server owns: routing, prompt assembly, the model turn, the first delta |
| `firstAudioMs` | 1200 ms | speaker stopped → first local audio started | the number a person actually experiences |

Read it with:

```bash
npm run health -- --json | jq .latency
```

```json
{
  "source": "data/telemetry.ndjson (in-memory ring of the last 200 records)",
  "scope": "local measurements from this machine; not a cross-device benchmark",
  "stages": {
    "firstTokenMs": { "samples": 12, "p50": 410, "p95": 690, "targetMs": 700, "overTarget": 1 },
    "firstAudioMs": { "samples": 0, "p50": null, "p95": null, "targetMs": 1200, "overTarget": 0 }
  }
}
```

The sample count sits next to every percentile on purpose: a p95 over four turns
is four turns, and a reader who cannot see that will believe the number.
`overTarget` is how often the budget was missed — a target nobody counts against
is a slogan.

### What the numbers are, and what they are not

- **Two anchors, stated.** The browser stages are offsets from its own turn start
  (the microphone opening). `firstTokenMs` is offset from the moment the request
  reached this server. A browser and a server do not share a clock; pretending
  they do would produce a number nobody could defend, so the two anchors are
  named in the code, in the docs and in the JSON.
- **A missing mark is `null`, never `0`.** A fabricated zero is a perfect score,
  and a perfect score is the number a reader believes.
- **`firstAudioMs` is null in the browser, deliberately.** The mark lands after
  the reply has started, so getting it onto the turn would mean either a second
  request — which this change is not allowed to add — or attributing one turn's
  audio to another. The row exists so the number has a home when a caller can
  supply it (a native voice host, or a test), and so the gap is visible rather
  than quietly assumed to be fine.
- **Nothing but numbers is recorded.** A `timing` payload is whitelisted to the
  five stage keys before it reaches the log: a transcript, a prompt or an object
  sent alongside them is dropped, not stored. There is a test that sends a
  sentence as a "transcript" and greps the log for it.
- **Local, one machine.** These are measurements of this install. They are not a
  cross-device benchmark, not a comparison with another product, and not a
  promise about your hardware — the model, the CPU and the operating system's
  voices all move them.
## Two speech paths, and which one leaves the device

There have always been two ways to talk to this thing, and they have different
privacy properties. Naming them in a table is the point: "fast" and "local" used
to be different products.

| Path | Who recognises the speech | Where the audio goes | Needs |
|---|---|---|---|
| **Browser recognition** (`SpeechRecognition` in the deck) | the browser, or its vendor | **may leave the device** — Chrome and Safari are entitled to send audio to their speech service | a browser that ships a recogniser; an explicit per-page opt-in |
| **Local dictation** | this machine: `AnalyserNode` for endpointing, `MediaRecorder` for audio, `WHISPER_URL` for the transcript | the page → **your own server** (`/api/transcribe`) → the transcription endpoint **you configured** | `WHISPER_URL` pointed at an OpenAI-compatible local server (whisper.cpp, faster-whisper) |
| **Local streaming speech** (opt-in, off by default) | this machine, chunk by chunk | the page → **your own server** (`/api/voice/stream`) → a **loopback-only** endpoint you named | `QUASNOOZE_VOICE_STREAM=on` and a loopback `QUASNOOZE_VOICE_STREAM_URL` |

Nothing is persisted in either path: no recording is written to disk, and no
audio is stored in `data/`. The local path never contacts a browser vendor, and
the browser path remains opt-in and labelled — the deck asks before it enables it.

The local path is what the microphone button now does **when the browser has no
recogniser**. That used to be a dead button with a dimmed icon; it is now a
working one, and the two paths never mix in a single utterance.

## Endpointing: what decides you have finished

`createEndpointer()` in `public/audio-input.js` reads the same analyser frames
the visualiser draws. There is no model and no dependency:

- **onset** needs `onsetFrames` (default 2) consecutive frames above
  `speechThreshold` (0.06 of full scale), so a click or a door does not open an
  utterance;
- **trailing silence** of `silenceMs` (default **300 ms**) below
  `silenceThreshold` (0.03) ends it — the same 300 ms the latency budget calls
  the endpoint stage, so the default holds the published number rather than
  describing it;
- **hysteresis** between the two thresholds means a quiet consonant mid-sentence
  does not end the sentence;
- **a cap** of `maxUtteranceMs` (15 s) ends a monologue rather than uploading a
  lecture;
- **a floor** of `minSpeechMs` (250 ms): a cough is endpointed and *discarded*, and
  no audio is uploaded for it at all.

### What it does not guarantee

- **It is not a speech classifier.** A fan, a keyboard or a noisy room raises the
  floor; the detector will decide on loudness, and the honest consequence is that
  a noisy room produces worse segmentation. There is no noise-floor adaptation in
  this version, and the thresholds are constants you can change, not estimates.
- **It says nothing about words.** Endpointing decides *when you stopped*, not
  what you said. Transcription accuracy is the transcription server's.
- **Timing is frame-quantised.** The endpoint lands within one animation frame of
  the window (the test allows one 60 ms frame), and the analyser's own smoothing
  adds a little. It is not a sample-accurate VAD.
- **Not barge-in.** It does not detect speech while the assistant is talking, and
  it does not interrupt playback.
- **Not a wake word in the security sense.** There is a wake *gate* (above), but
  it is a convenience trigger: recordings replay it, nearby people trigger it, and
  it authenticates nobody. Background listening still needs the Windows voice host,
  and the gate is off by default.

## Wake gating: a trigger, not a lock

There is an optional "Hey Quasnooze" gate on the browser path
(`public/audio-input.js`, `voice-04`). Saying the phrase opens the microphone for
**one utterance**; before that, audio is discarded as it is read rather than
buffered and then dropped — no chunk is assembled, no request is made, and no
transcript exists to send.

**The phrase is not authentication, and this is the part that matters.** It
decides *when to listen*, never *who is allowed*:

- A **recording** of you saying it replays it. The gate has no way to tell a
  speaker from a phone playing a clip.
- A **nearby person** can say it. Nothing here identifies a voice; there is no
  speaker verification, no enrolment, and no model that scores a voiceprint.
- It is **not a permission**. No approval prompt, capability check or effect gate
  may be keyed to the phrase. `wakePhraseAuthenticates()` exists purely so a
  caller looking for that answer gets a `false` instead of a plausible-looking
  state machine. Keep approval decisions on the approval path.

The gate is **off by default** and opt-in per page: it arms only from a click in
that tab, the panel always shows which of `off`, `gate-idle`, `gate-heard`,
`listening` or `sending` is active, and losing the page releases the microphone —
`pagehide` for a navigation, `visibilitychange` for a tab switch, which on mobile
can suspend the page without firing `pagehide`. Silence after the phrase expires in
3 s rather than holding the microphone for the full 15 s utterance cap, because a
stray match is common and an open microphone is not free.

Which hardware does the recognising decides where the audio goes, and that is the
existing table above: the browser's recogniser may send audio to its vendor (the
opt-in prompt says so), while the Windows voice host recognises on-device with
`System.Speech`. Gating changes *when* capture may start, never *where* the audio
goes — those are separate questions and conflating them is how a privacy label
becomes a lie.

## Streaming partials, and why a partial is never a message

With a Whisper-compatible endpoint, waiting for a whole clip is the slow part: a
two-second sentence is transcribed after the fact, not during it. Local dictation
therefore uploads **bounded chunks** while you speak (`chunkMs`, default 1.2 s)
and each chunk carries the previous chunk's transcript as the `prompt` form
field, so words that fall on a boundary are not lost.

That transcript is **provisional**. It is shown in the message box with
`aria-busy` set, and it is replaced by the next one. It cannot become a message:
the only code that appends to the conversation is `send()`, and the only thing
that calls `send()` is a final transcript. The tests assert that at the source
level and at the pipeline level, because "the partial never enters history" is a
property that fails silently and looks like a duplicate message.

**Silence is not paid for.** Partial uploads happen only while the frame in hand is
voiced. Audio captured during a pause — including the trailing silence before the
endpoint — rides on the next upload and on the final POST, so pausing never costs
audio and never costs a request that transcribes a room. In the end-to-end demo
that is four requests instead of five, and a test asserts that every captured
byte reaches the server exactly once, so the saving cannot quietly become a loss.

`prompt` context is bounded to 400 characters, flattened to one line and taken
from the **tail** — the recent words are what carry continuity, and an unbounded
"context" field is a way to push arbitrary text through a transcription endpoint.

Setting `streaming: false` is the whole-clip path: one request at the end, the
same status sequence, the same final callback, no partials. That is the
"no behavioural difference" test — the caller cannot tell which path ran except by
counting requests.

## Local streaming speech, and what "local" is allowed to mean

The buffered path above uploads a clip and waits. `harness-13` adds a streaming
adapter that reports partials as you speak, and it is **off unless you turn it
on**:

```sh
QUASNOOZE_VOICE_STREAM=on
QUASNOOZE_VOICE_STREAM_URL=http://127.0.0.1:8080/v1/audio/transcriptions
QUASNOOZE_VOICE_STREAM_CHUNK=65536   # one upload, in bytes
```

Five properties are enforced in `src/voice/stream.js`, not merely described:

1. **No adapter means no adapter.** With the switch off, `GET /api/voice/stream`
   answers `available: false` with a reason and a *fallback sentence* the panel
   renders verbatim ("no local stream adapter — dictation uses your configured
   transcription endpoint" or "typing only; nothing is recorded"). Nothing
   reaches for the browser's vendor recogniser or an OpenAI endpoint to fill the
   gap. The browser recogniser is a separate, labelled, opt-in path and is never
   started on your behalf.
2. **Local-only means loopback-only.** `assertLocalStreamUrl` accepts `http(s)`
   on `127.0.0.1`, `localhost` or `[::1]` and refuses everything else — including
   look-alikes that resolve remotely (`127.0.0.1.nip.io`, `localhost.evil.example`),
   `0.0.0.0` (a bind address, not a destination), LAN addresses, embedded
   credentials, fragments and non-HTTP schemes. The check runs again before every
   upload, so a URL pinned at startup cannot be swapped for a different one later.
3. **Redirects are refused, not followed.** A 302 is how a loopback endpoint
   becomes an arbitrary destination. The request uses `redirect: "manual"` so the
   3xx comes back and can be named — `STREAM_REDIRECT_REFUSED` — instead of
   being reported as "unreachable", which would be a lie about what happened.
4. **Bounded everywhere.** Chunks have a byte ceiling; a request has a 5 s
   timeout, matching the buffered path; a response body is capped at 1 MB; a
   transcript at 4 000 characters; a stream at 2 000 events; and at most
   `maxQueue` chunks are in flight. Past that the caller gets
   `{ accepted: false, reason: "backpressure" }` and pauses capture rather than
   this module buffering audio without bound.
5. **Ordered, and a partial is still not a message.** Requests finish out of
   order, so results are parked by sequence and drained in order — the reader's
   words cannot be reordered by a slow chunk. Events are `partial`, `final`,
   `partial-failed`, `failed` or `cancelled`; a final is emitted exactly once; and
   the route returns `text: null` with `partialIsMessage: false` unless a final
   arrived. `failed` and `cancelled` are not 200s.

**The microphone starts muted.** Capture begins only from a click; the capability
probe on page load is a metadata request with no microphone access. No audio file
is written and no transcript is sent anywhere as telemetry — the chunk is POSTed
and dropped.

**Barge-in is not claimed.** If a reply is speaking when you start dictating, the
old speech is cancelled where the browser supports it; where it does not, the page
says the capability is unavailable rather than pretending the overlap worked.
This remains one utterance at a time, not full-duplex conversation.

## How accurate is it

There are two questions hiding in "does it understand me", and averaging them
loses the one that matters:

- **word error rate** — how close the transcript is to the words that were said;
- **command accuracy** — whether that transcript selects the intended tool with
  the intended arguments.

They are measured and reported separately, on a labelled corpus of 48 short
utterances in `test-fixtures/speech/v1/corpus.json` (14 clean, 12 accented, 12
noisy, 10 numbers-and-names; CC0-1.0, text only). The report is
[docs/SPEECH-BASELINE-V1.md](SPEECH-BASELINE-V1.md), regenerated with
`node scripts/evaluate-speech.js`; a test compares the committed file with the
runner's output, so a stale number fails the build instead of sitting there
looking measured.

Why two numbers: "turn off the kitchen light" heard as "turn off the kitchen
lite" is one word wrong and the same command; "remind me at two" heard as "remind
me at noon" is one word wrong and the wrong reminder. Arguments are compared after
normalising number words and plurals — a cosmetic error must not be scored as a
broken command, or the two numbers collapse into one. The current corpus shows the
point: the numbers-and-names condition has a *lower* word error rate than the
accented one and the *worse* command accuracy, because digit substitutions are
small in word terms and total in command terms.

Every number carries its sample count, and a condition with fewer than
`MIN_CONDITION_SAMPLES` (8) utterances reports **withheld** rather than a
percentage, including the headline if any condition is under the line. A WER from
three samples is a coincidence with a decimal point.

**This is not hardware acceptance.** The hypotheses in the corpus are authored
text, not recordings: the runner downloads no model, opens no microphone and
touches no network. So the word error rate describes the fixture, while command
accuracy is a live measurement of the shipped router (`matchFastIntent`) — and the
corpus's own reference layer is scored the same way, so an expectation the router
cannot satisfy surfaces as a corpus error rather than as an accuracy figure. What
the report *does* catch immediately is a router that cannot survive realistic
transcripts: it currently names, for example, a leading hesitation ("uh what time
is it") and a dropped unit word ("what is 18 of 250") as command misses. The
misses are listed by utterance id, so they can be turned into work items instead
of anecdotes.

The physical-microphone question — does this hear *you*, in a kitchen, over a
fan — remains unmeasured, and nothing in this report should be read as an answer
to it.

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
- Not local browser recognition. A browser recogniser may send audio to its vendor; local
  dictation (above) is the path that keeps audio on your machine, and the Windows voice host
  remains the only always-on local recogniser.
- Not speech in every browser. A browser without `speechSynthesis`, or one with no installed
  local voice, gets a visible explanation and silence — not a hidden cloud call.
- Not a hardware voice-quality or latency benchmark. The test proves *that* the shipped code
  calls a local voice with the right text; it does not prove how good that voice sounds.
- Not a cross-device latency benchmark. The budget table above is measured on one machine, and
  `firstAudioMs` is recorded only when a caller can supply it — in the browser it is null, never 0.
- Not a noise-robust endpointing model. The local detector thresholds loudness with hysteresis;
  a noisy room makes it worse, and `docs/VOICE.md` says so rather than claiming clean segments.
- Not a local streaming pipeline by default. `harness-13`'s adapter is opt-in (`QUASNOOZE_VOICE_STREAM=on`)
  and loopback-only; with it off, dictation is buffered and the streaming partials do not exist. The
  optional Whisper adapter remains request/response, and nothing here turns it into a stream.
- Not a wake word as a security boundary. The opt-in gate (`voice-04`) is off by default, disarms on page
  hide, and only decides when to listen; it is defeated by a recording, so nothing may gate approval on it.
- Not barge-in. There is no always-on listener: the mic starts muted. Overlapping
  a reply is best-effort — old speech is cancelled where the browser supports it, and the page says so
  when it does not.
- Not a claim that browser recognition is private. That path may send audio to the browser vendor
  and is labelled as such; local dictation is the path that keeps audio on your machine.
- Not a speech-recognition accuracy claim. The word error rate in
  [SPEECH-BASELINE-V1.md](SPEECH-BASELINE-V1.md) is scored over hand-authored hypotheses, not
  recordings; it measures the fixture and this build's router, and it says nothing about how well
  a microphone in a noisy room hears you.
