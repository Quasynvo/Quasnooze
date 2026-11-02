# Windows voice pipeline review — 2026-11-02

## Scope and evidence

Reviewed launch/config, PowerShell compilation, native consent, SAPI recognition
lifecycle and callbacks, wake/dictation grammars and confidence gates, TTS pause /
resume, private JSON-lines bridge, resident request serialization, approvals,
HTTP controls and command-deck refresh/rendering, and the separate browser / local
Whisper speech paths. This is a targeted voice-system review, not a guarantee that
every project feature or Windows device has been exhaustively tested.

The supplied screenshot shows an API fetch failure and stale connected card. It
does not establish a microphone device failure or prove a recognized transcript
reached the model. Earlier compilation and JS tests were not microphone tests.

## Findings and changes

1. **Unsafe recognition shutdown/replacement ordering.** The old StopRecognition
   called RecognizeAsyncCancel, disposed immediately, and could construct a new
   recognizer before Windows signalled completion. Wake-to-dictation and Talk
   retries both exercised that ordering. Replacement is now serialized through a
   pure C# lifecycle gate; cancellation must complete before disposal/restart.
   Mute clears a queued restart; late callbacks are ignored while stopping.
   Completion cannot rearm recognition during an active TTS prompt: a fast reply
   racing with the old completion callback must not reopen the mic over speech.
   Natural completion and intentional cancellation are distinguished, including
   the InputStreamEnded and silence/rejection branches. A five-second watchdog
   reports failed shutdown without pretending the microphone was released or
   starting an overlapping engine. This fixes unsafe ordering, but is not proof
   that a particular driver or user's failure was caused by it.
2. **Insufficient physical-input evidence.** An ON indicator only established an
   initialized capture path. The deck now shows actual AudioLevelUpdated values
   from Windows (0–100, not calibrated dB), throttled to at most four updates per
   second. Samples expire in the UI and clear on mic release/disconnection. A
   moving meter does not prove correct words; a silent sample does not on its own
   distinguish privacy denial, muted hardware or the wrong default device.
3. **Silent permission refusal.** Native consent now reports both the pending
   dialog and an explicit decline, rather than returning with no visible reason.
4. **No independent voice diagnostic.** desktop:doctor can enumerate installed
   classic speech packs without a microphone, test a generated in-memory WAV
   without a device, or run an explicitly consented short microphone test. The mic
   test reports input level, speech-detected events, transcript/confidence and
   engine error separately from Ollama. It never executes recognized commands.
5. **Browser/native paths are not equivalent.** Browser-selected input, vendor
   browser recognition, classic English desktop packs and Windows desktop-app
   permissions differ. No automatic cloud/browser fallback or machine-settings
   modification has been added.
6. **Dictation-only decoding failed a real synthetic probe.** The first Windows
   run recognized the generated wake phrase at 0.982 confidence, but decoded the
   generated “what time is it” as “What I was it” at 0.378, below the 0.45 command
   threshold. This is concrete evidence of the classic dictation route failing a
   controlled fixture, not proof of the user's microphone failure. Resident capture
   now loads a higher-priority constrained grammar for supported everyday commands
   alongside free dictation. Doctor and the resident share that grammar factory,
   and CI fails an available synthetic fixture when the expected phrase is not
   accepted. Missing prerequisites are explicitly reported as unavailable.
7. **Confidence gating is still intentional.** Existing wake/dictation thresholds
   are unchanged. The report makes low-confidence text visible instead of
   blindly relaxing thresholds and executing possibly incorrect instructions.
   Rejected candidate text can be copied into an editable draft for manual review,
   never automatically executed. Accuracy and threshold tuning need real accent/
   noise recordings and consent.

## Reproduce on the affected Windows PC

Stop Pinch through its tray, and turn off the chat/browser mic before the probe.
Run these in the updated project directory with Node 22+:

```powershell
npm run desktop:doctor
npm run desktop:doctor -- --self-test
npm run desktop:doctor -- --mic
```

- Inventory: no recording; look for an English classic recognizer. Registry
  permission values are hints, not authoritative proof of access.
- Self-test: English TTS-generated WAV feeds wake/dictation directly. No mic,
  speakers or cloud service. Read status/transcripts and policyWouldAccept:
  unavailable prerequisites are explicitly reported, not a passed audio test.
- Mic: accept the native default-No dialog, then say **what time is it**. Uses the
  Windows default speech input for about 12 seconds. Reports transcript and levels
  to the console; inspect private text before sharing. No raw audio is saved.
  A 60-second parent-process limit handles blocked drivers/dialogs; failed
  cancellation is reported rather than synchronously disposing an active engine.

Then run `npm run desktop`, use Deck from the widget, and repeat Talk. Compare:

| Observation | What it establishes / next check |
|---|---|
| No English classic recognizer | System.Speech prerequisite missing; browser recognition can still work |
| Synthetic recognition fails | Investigate classic speech language/engine independently of microphone |
| Synthetic works, mic meter stays zero | Check Windows default input, physical mute and desktop-app privacy permissions; not an Ollama issue |
| Meter moves, no usable transcript | Speech language, accent/noise/grammar or confidence gate; inspect report |
| Transcript recognized in mic probe, resident Talk fails | Compare resident lifecycle/bridge events; diagnostic alone is not end-to-end success |
| Transcript reaches resident but result is slow | Agent/model/tool latency, not initial recognition; test clock fast path |
| Service disconnected | Deck cannot control/verify native input; reopen through the native widget |

## Regression evidence boundary

The native `-CheckOnly` self-test now executes lifecycle sequences for queued
wake-to-dictation replacement, repeated requests, mute clearing a queued restart,
and failed-start recovery. These are executable C# state tests, not regex-only
claims about event behavior. Windows CI also prints prerequisite inventory and a
synthetic audio report; a report saying unavailable/failed is not proof of speech
success. Node tests cover bounded audio events, expiration and disconnected state.
Real microphone/audio-device validation remains required on the affected PC.
