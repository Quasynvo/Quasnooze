# Fluid Motion Voice Engine — design and integration

**Status:** implemented browser presentation layer and opt-in microphone playground. Existing speech/model pipelines remain authoritative. No new runtime dependency, backend endpoint or environment variable.

## 1. Identity

Quasnooze's assistant identity is a **fluid interference signal**, not a character: three phase-offset ribbons surround a dark glass core. A fourth ribbon and orbiting particles distinguish computation. A radial spectrum distinguishes output. A compact dual-wave mark remains legible at favicon/native-widget size.

| Token | Value | Meaning |
|---|---|---|
| Background | `#080D19` | Dark canvas |
| Primary / secondary text | `#EDF4FF` / `#A8BBCE` | Readable interface copy |
| Ion cyan | `#6EE7F9` | Idle, input |
| Orbital violet | `#A78BFA` | Processing |
| Plasma magenta | `#F0ABFC` | Spectral highlight |
| Signal amber | `#FFBF69` | Attention / permission |
| Error crimson | `#FB7185` | Interruption; always paired with text |

Use system sans-serif for UI and system monospace for telemetry. Glass panels retain a solid dark fallback and a visible border. Glow belongs to the signal, not to every surface. Do not use the organization Q as a substitute for the assistant's Fluid Motion mark.

## 2. Files and responsibilities

```text
public/
  visualizer.js          # Reactive Motion Engine; no capture or application API calls
  visualizer.css         # Canvas sizing and static-image fallback
  audio-input.js         # Audio Stream Handler + Frequency Analyzer; explicit opt-in
  demo-signal.js         # Explicitly synthetic, silent demo signal
  visualizer.html        # Standalone five-state playground
  visualizer-demo.js     # Playground controls, permission and capture lifecycle
  desktop-motion.js      # Adapter for existing command-deck state events
  cosmic.js              # Conversation state adapter; historical route filename
  brand/voice-engine.svg # Static vector fallback
assets/
  quasnooze-showcase.gif # Silent five-state README walkthrough
  banner.svg/png         # Static alternatives
  architecture.svg      # Request, permission and presentation boundaries
scripts/
  build-brand-assets.py  # Deterministic art + static-site engine copies
```

The renderer uses Canvas 2D and browser platform APIs. It does not import a framework, open a microphone, request speech recognition or make network calls. `audio-input.js` is imported only by the standalone playground, not by the existing conversation or command deck.

## 3. Canonical states and transition contract

| Public state | Geometry and timing | Palette | Authoritative trigger |
|---|---|---|---|
| `idle` | Approximately 5.5-second breathing cycle; slow ribbon drift | Cyan / violet | Ready, muted, no active request, or native wake armed |
| `listening` | Spring-smoothed expansion; frequency-dependent boundary displacement | Cyan / magenta | Actual capture/recognition state; never just a focused text field |
| `thinking` | Angular velocity eases toward 1.65 rad/s; four ribbons and 28 orbit tracers | Violet / amber | Model work, tool work, text deltas |
| `speaking` | 48 radial spectrum bars; bright core and light trails | Bright cyan / magenta | Actual speech-output state or explicitly labelled preview |
| `error` | One 420 ms damped shake, maximum 5 px; warm color transition | Crimson / amber | Request/permission/stream failure |

Implementation details:

- Envelope: critically damped-style spring, stiffness `150`, damping `23`, integrated in substeps no larger than `1/120 s`.
- Color transition: exponential interpolation, rate `10/s`; state geometry changes at the authoritative event.
- Frequency smoothing: exponential interpolation, rate `16/s`, plus analyser smoothing `0.72`.
- Error displacement: `sin(age × 55) × exp(-age × 11)`, capped at 5 px. Repeated reports of the same error do not restart the shake.
- Idle has no semantic progress. Thinking has no fabricated percentage or completion estimate.
- `approval` is a permission overlay, not a sixth audio state: amber, idle-like geometry and explicit controls. It never resolves an approval.

`normalizeState()` maps `working`/`processing` → `thinking`, `attention`/`interrupted` → `error`, `output` → `speaking`, and `ready`/`muted`/`not-running`/`armed`/`approval` → `idle`. Unknown states fail closed to idle geometry; application code must still expose the real status in text.

In the conversation adapter, `delta`, `status`, `tool`, `tool_done` and `working` remain **thinking**. Only a reported `speaking` event enters speaking. Approval/error events retain their existing application semantics.

## 4. Signal contract: do not invent audio

```ts
// Conceptual shape; implementation is plain JavaScript.
type Signal = {
  source: "none" | "native" | "spectrum" | "demo";
  level: number;              // normalized 0..1
  bands?: ArrayLike<number>;  // normalized 0..1; resampled to 48 bands
  timestamp: number;         // performance.now() time base
};
```

- `spectrum`: measured FFT data. Freshness window **450 ms**.
- `native`: one scalar amplitude sample from `/api/desktop`. Freshness window **2,600 ms**, allowing the existing 1.5-second polling interval. This is **not FFT data**.
- `demo`: synthetic data, visibly labelled as a silent preview. Same 450 ms freshness window.
- `none`: no samples. State-driven motion only.

Values are clamped; non-finite levels become zero. Missing, future-dated or stale samples cannot remain advertised as live. The renderer reads a supplied `signalProvider()` once per rendered frame; it does not create a second animation/audio polling loop.

### Current integration matrix

| Surface | State source | Audio source | Important limit |
|---|---|---|---|
| `/visualizer.html`, preview mode | Selected state button | Synthetic or none | No model, recognition, tools or playback |
| `/visualizer.html`, mic enabled | Listening while capture is active | Real local FFT + RMS | Analysis only; no speech-to-text |
| `/desktop.html` | Existing `/api/desktop` phase | Fresh native scalar amplitude | No native output FFT |
| `/cosmic.html` | Existing native state / SSE events | Native scalar when listening; otherwise none | Text streaming is not audio speaking |
| Static product website | State buttons | Synthetic or none | No API or capture requests |
| `/index.html` advanced history | Existing speech controls | No new analyser attached | Browser recognition may use a vendor service |

**Output-reactive speaking:** the engine accepts measured bands in `speaking`, but the current native System.Speech bridge does not expose them. Its speaking spectrum is therefore decorative and labelled accordingly. To make it genuinely output-reactive, connect an analyser to an audio-producing node you own:

```js
// Given an existing Web Audio source and AudioContext owned by your integration:
const outputAnalyser = audioContext.createAnalyser();
outputAnalyser.fftSize = 1024;
sourceNode.connect(outputAnalyser);
outputAnalyser.connect(audioContext.destination);

// Sample outputAnalyser with your Frequency Analyzer and supply the result
// through signalProvider while the actual output state is "speaking".
// Disconnect the analyser when playback ends.
```

Do not assume `SpeechSynthesisUtterance` exposes a Web Audio node or PCM samples. It generally does not. Do not open the microphone to fake output reactivity. A native implementation would need an explicit, reviewed output-sample/level bridge; that bridge is **not implemented here**.

## 5. Minimal renderer integration

Serve these files from the existing same-origin `public/` directory:

```html
<link rel="stylesheet" href="/visualizer.css">
<div class="visualizer is-static" style="width:320px">
  <canvas id="voiceCanvas" aria-hidden="true"></canvas>
  <img class="visualizer-fallback" src="/brand/voice-engine.svg" alt="">
</div>
<p id="voiceState" role="status" aria-live="polite">Idle</p>
```

```js
import { createVisualizer } from "/visualizer.js";

const motion = createVisualizer(document.getElementById("voiceCanvas"), {
  maxDpr: 2,
  maxFps: 60,
});

function onApplicationState(state) {
  motion.setState(state);
  document.getElementById("voiceState").textContent = state;
}

// Existing event adapters call onApplicationState().
// On permanent unmount, release observers/listeners/RAF:
window.addEventListener("pagehide", event => {
  if (!event.persisted) motion.destroy();
});
```

For a bfcache restore, keep the instance alive on persisted `pagehide`; visibility handling pauses/resumes rendering. Destroy and recreate it if your framework permanently removes the canvas.

### Renderer API

| Method | Behavior |
|---|---|
| `setState(state)` | Accepts canonical states and documented aliases; updates canvas state metadata. |
| `setSignal(signal)` | Supplies a validated signal snapshot; useful for polled native telemetry. |
| `setReducedMotion(boolean)` | Overrides the initial OS preference for this instance. |
| `getDiagnostics()` | Returns state, signal source, reduced-motion flag, running flag and disposal status; no audio samples. |
| `renderAt(milliseconds)` | Deterministic documentation/test rendering; not a live-state source. |
| `destroy()` | Cancels RAF, disconnects observers and removes event listeners. Idempotent. |

Options: `signalProvider`, `reducedMotion`, `maxDpr` (default 2), `maxFps` (default 60), and optional `width`/`height` only when layout has no measurable size. A provider return value is validated each frame. An unavailable canvas context retains the static vector fallback.

## 6. Complete opt-in microphone integration

The following is the intended ownership pattern; the shipped playground also handles pending-permission cancellation and UI messages.

```js
import { createVisualizer } from "/visualizer.js";
import { startAudioAnalysis } from "/audio-input.js";

const canvas = document.getElementById("voiceCanvas");
const button = document.getElementById("micButton");
const status = document.getElementById("voiceState");
let session = null;
let pending = false;
let captureAbort = null;
const motion = createVisualizer(canvas, {
  signalProvider: () => session?.sample() ?? null,
});

button.addEventListener("click", async () => {
  if (session || pending) { stopMicrophone(); return; }
  pending = true;
  captureAbort = new AbortController();
  button.textContent = "Cancel microphone request";
  try {
    session = await startAudioAnalysis({ signal: captureAbort.signal });
    motion.setState("listening");
    status.textContent = "Microphone on — local audio analysis";
    button.textContent = "Turn microphone off";
  } catch (error) {
    if (error.name !== "AbortError") {
      motion.setState("error");
      status.textContent = error.message;
      button.textContent = "Try microphone again";
    }
  } finally {
    pending = false;
  }
});

function stopMicrophone() {
  captureAbort?.abort();
  session?.stop();
  session = null;
  pending = false;
  motion.setSignal({ source: "none", timestamp: performance.now() });
  motion.setState("idle");
  status.textContent = "Microphone off";
  button.textContent = "Enable microphone";
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopMicrophone();
});
window.addEventListener("pagehide", event => {
  stopMicrophone();
  if (!event.persisted) motion.destroy();
});
```

Call `startAudioAnalysis()` directly from the gesture. Do not await a configuration request first. Browser permission/autoplay policies differ; a visible error and text fallback are mandatory.

### Audio graph and analysis

```text
click → permission → MediaStream
                       │
                       ▼
               MediaStreamSource
                       │
                       ▼
                  AnalyserNode ──→ 48 log-spaced bands + RMS level
                       │
                       └── no destination connection: no mic monitoring

FFT: 1024 samples (configurable: 512 / 1024 / 2048 / 4096)
Band range: 60–8,000 Hz, bounded by the available FFT bins
Level: min(1, RMS × 5)
Echo cancellation: requested; noise suppression: requested
Automatic gain control: requested off; hardware/browser may differ
```

The graph neither records nor uploads audio. This does **not** make other browser speech APIs local. A separate `SpeechRecognition` session may use a vendor service and may require its own capture. Do not silently start both.

### Cleanup and races

`stop()` is idempotent: it stops media tracks, disconnects nodes and closes the AudioContext. Aborting a pending request closes the context and releases a late-arriving stream. Device `ended` events invalidate sampling. The playground releases capture on hide/page exit and ignores stale permission results after cancellation.

The playground surfaces unexpected device loss through `onEnded`, enters the interrupted state and offers retry. Other production hosts should provide the same callback. Never leave a “listening” label authoritative after the track ends.

## 7. Permissions and deployment

- **Secure context:** HTTPS or trustworthy loopback HTTP. Plain HTTP to a LAN IP is not a supported microphone origin.
- **Browser/OS:** the user must allow the site and the OS must allow the browser to use the input device.
- **Iframe:** parent needs `allow="microphone"`; configure server Permissions Policy accordingly. The Arena file viewer is sandboxed and does not grant live microphone access; use a local/server preview for hardware checks.
- **Native Windows:** browser site permissions do not replace Windows microphone privacy or an installed System.Speech recognizer.
- **No configuration bypass:** there is no `ENABLE_MIC=true` switch. `.env` cannot grant consent.
- **Authentication:** the playground is static and needs no model key. Existing control APIs retain their key, host and origin checks.

## 8. Accessibility and performance budget

- Canvas is decorative (`aria-hidden="true"`); a nearby text status announces meaningful changes politely.
- Never put essential controls inside canvas. State controls are real buttons with visible focus and `aria-pressed`.
- Color is supplementary: every state has a text label and distinct motion/geometry.
- OS reduced motion is honored initially; explicit UI override is available. Reduced mode stops RAF, breathing, orbiting, particles and shake while retaining state colors.
- No full-screen flashes or strobing. The error shake happens once per transition and is bounded.
- Rendering pauses when the document is hidden or the canvas is offscreen.
- DPR is capped at 2; frame rate is capped at 60. No WebGL requirement, layout reads per frame or unbounded particle allocation.
- A missing/lost canvas context falls back to the local SVG; text and controls remain usable.
- Glass effects are optional enhancement; essential contrast comes from solid dark surfaces.

These are implementation budgets, **not a claim of measured performance on every device**. Profile low-end mobile hardware before raising DPR, particle count or frame rate.

## 9. Assets and documentation maintenance

```sh
python3 scripts/build-brand-assets.py
```

Developer requirements: Python 3 and Pillow. The script builds the static mark, native PNG, README GIF/static banners and social image, then copies the shared engine/CSS/demo signal into `site/assets/`. Edit the canonical files in `public/`, not generated site copies.

The GIF is silent and deterministic. Do not caption it as live microphone input, model inference, a speed comparison or phoneme synchronization. Keep `assets/demo.gif` identical to `assets/quasnooze-showcase.gif` for the existing demo URL.

Retired character-image URLs are intentionally removed, not redirected to a character wrapper. Custom clients should use `/brand/voice-engine.svg` or the canvas component. The organization mark remains separate.

## 10. Verification checklist

Automated:

```sh
node --test test/visualizer.test.js test/visualizer-assets.test.js test/audio-input.test.js
node --test --test-concurrency=4
node scripts/audit.js

# Optional developer-only browser checks: Python Playwright + Chromium
python3 scripts/test-visualizer-browser.py
```

The browser script uses Chromium's synthetic audio device, not a physical microphone.

Manual/browser:

1. All five buttons change geometry, color and the accessible text label.
2. Default preview makes no capture, model or tool request.
3. Microphone is requested only after the explicit click; denial keeps text usable.
4. Live input changes the listening ring. Mute, device loss, hide and page exit release capture.
5. Cancel a pending permission prompt, then grant it: no late stream remains active.
6. Native speaking is labelled decorative; streamed text remains thinking.
7. Stale native telemetry does not masquerade as a live signal.
8. Reduced motion stops continuous RAF and shake; state changes remain visible.
9. Keyboard-only operation, 200% zoom and narrow mobile layout retain labels/controls.
10. Static fallback appears when canvas is unavailable; no external asset is required.

Physical Windows speech, accents, devices, startup and OS screen-reader acceptance remain separate checks. See [VALIDATION.md](brand/VALIDATION.md) for what was actually run.
