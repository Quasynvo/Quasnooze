<p align="center">
  <img src="assets/quasnooze-showcase.gif" width="100%" alt="Quasnooze Fluid Motion Voice Engine: luminous interference ribbons transition through idle, listening, processing, speaking and interrupted states. Silent scripted preview." />
</p>

<h1 align="center">Quasnooze</h1>
<p align="center"><strong>Your voice. In fluid motion.</strong><br>A local-first personal AI assistant by <a href="https://github.com/Quasynvo">Quasynvo</a>.<br>Responsive audio visuals. Everyday tools. Your permission, first.</p>

<p align="center">
  <a href="https://github.com/Quasynvo/Quasnooze/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/Quasynvo/Quasnooze/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6ee7f9?style=flat-square&amp;labelColor=080d19" /></a>
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-a78bfa?style=flat-square&amp;labelColor=080d19" />
  <a href="docs/VISUALIZER.md"><img alt="Fluid Motion voice visualizer" src="https://img.shields.io/badge/%E2%88%BF-Fluid_Motion-6ee7f9?style=flat-square&amp;labelColor=080d19" /></a>
  <a href="docs/VOICE.md"><img alt="Microphone access is opt in" src="https://img.shields.io/badge/microphone-opt--in-f0abfc?style=flat-square&amp;labelColor=080d19" /></a>
</p>

<p align="center"><a href="#start-in-three-steps">Start here</a> · <a href="#the-fluid-motion-voice-engine">See the motion</a> · <a href="#voice-and-microphone-setup">Voice setup</a> · <a href="docs/VISUALIZER.md">Integration guide</a> · <a href="docs/GUIDE.md">Full guide</a></p>

<p align="center">
  <a href="https://quasynvo.github.io/Quasnooze/demo/"><strong>▶ Open the live preview</strong></a>
  — the conversation surface, scripted, in your browser.<br>
  <sub>No install. No model. No tools. No microphone. <a href="https://quasynvo.github.io/Quasnooze/demo/visualizer.html">Try the five motion states ↗</a></sub>
</p>

<p align="center">
  <sub>Already have a checkout? <code>npm run demo</code> boots the real panel with a canned brain in about two seconds — no keys, no Ollama, no network.</sub>
</p>

> **Preview provenance:** the header is a silent, scripted walkthrough—not live AI, recorded microphone input or a performance benchmark. Prefer less motion? Use the [static SVG](assets/banner.svg) or open the interface with your OS reduced-motion preference enabled.
>
> **Existing installations:** the product name, saved data, configuration aliases and `pinch` CLI remain supported. This identity refresh does not move data or enable a microphone. [Compatibility details →](docs/REBRANDING.md)

## Local intelligence. A visible signal.

Quasnooze runs on **your own computer**. Ask a question, plan your day, find a document, set a reminder or use supported tools. Its **Fluid Motion Voice Engine** gives the interface a clear, responsive presence without turning the assistant into a character.

- **Local by default.** Ollama provides local reasoning. Optional cloud providers, browser speech, network tools and messaging channels have separate, explicit data boundaries.
- **Audio-reactive when connected.** The standalone visualizer can analyze opt-in microphone input through the Web Audio API. The conversation view follows existing backend/native states; it does not secretly open a second audio stream.
- **Permission-aware.** See microphone status, real tool activity and requests for approval. Animation never approves an action.
- **Motion with restraint.** A dark glass interface, cyan–violet–magenta ribbons, bounded glows and reduced-motion alternatives.

**Status:** the Windows voice host and browser conversation experience are previews. Physical Windows microphone, wake-word, startup and accessibility acceptance still need testing. The new visualizer is a **2D canvas signal**, not a 3D avatar, lip-sync system or measurement of model progress.

## The Fluid Motion Voice Engine

**Signature:** three phase-offset interference ribbons surrounding a dark glass core, with a compact dual-wave mark. Each state changes geometry, rhythm and color—not just a status label.

| State | Signature motion | Color | What the signal means |
|---|---|---|---|
| **Idle** | Slow-breathing core; gentle, drifting ribbons | Ion cyan / violet | Ready or inactive. No claim that a microphone is on. |
| **Listening** | Expanding plasma ring; frequency-shaped ripples when an analyser is connected | Cyan / magenta | Live microphone analysis in the playground, or listening reported by the native host. |
| **Processing / thinking** | Accelerating orbital trails; a fourth interference ribbon | Violet / amber | Text generation, tool work or native computation. Not a percentage-complete indicator. |
| **Speaking / output** | High-contrast radial spectrum with luminous trails | Bright cyan / magenta | Native speech state, or a clearly labelled silent preview. Output-frequency reactivity requires an output analyser. |
| **Error / interrupted** | One brief, damped shake; warm glow that settles | Crimson / amber | A failed request, denied permission or interrupted stream. Read the accompanying explanation. |

**Approval is separate from these five audio states:** it uses a calm amber presentation plus explicit **Allow once / Deny** controls. A spoken “yes” or an animation cannot approve a sensitive action. [Structured approval previews](docs/ACTION-PREVIEWS.md) show bounded targets, risks, expected effects and redaction notices without changing the approval gate.

### Signal honesty

The interface distinguishes **live FFT bands**, a **native scalar input level**, **synthetic demo data**, and **state-only motion**.

- The native Windows API currently exposes amplitude, not FFT bands or TTS output samples. Listening can follow that amplitude; native speaking uses decorative spectrum motion.
- Text deltas map to **thinking**, never speaking.
- Missing or stale audio falls back to state-driven motion. It is not presented as a live spectrum.
- The static website and `?demo=1` conversation mode make no AI, tool or audio-capture requests. A preview does not mute a separately running native host.

### Try the visualizer

After starting Quasnooze, open **`/visualizer.html`** from the launcher’s panel URL.

1. Explore the five state buttons. They start as **silent synthetic previews**.
2. Select **Enable microphone** to use real, local frequency analysis. Permission is requested only after that click.
3. Select **Turn microphone off** when finished. Hiding or leaving the page releases the microphone.
4. Enable **Reduce motion** for a static core and state colors. The OS preference is respected by default.

The playground analyzes audio; it **does not transcribe speech or call a model**. For actual voice commands, use the existing surfaces below.

## Start in three steps

**Requirements:** Node.js **22+**. Windows 10/11 is required for the native voice host; the web/channel assistant also runs on Linux and macOS. Basic local/web use needs no browser bundle, CDN or mandatory runtime package. WhatsApp/QR support uses optional packages.

### 1 · Get the code

```sh
git clone https://github.com/Quasynvo/Quasnooze.git
cd Quasnooze
```

### 2 · Configure and check

```sh
npm run setup
npm run doctor
npm run brain
```

Install/start **Ollama** and select an installed model for real local reasoning. Setup guides model, workspace, access-key and optional-channel configuration. It does not download a model, install a speech pack or grant microphone permission automatically.

### 3 · Start your interface

```sh
# Cross-platform web and configured-channel assistant
npm start

# OR: Windows native tray/widget and local voice host
npm run desktop
```

Open the panel URL printed by the launcher. The default port is `7777`; a keyless default server stays on loopback. **Do not expose an unauthenticated assistant or forward its port.** Native launch starts with the microphone muted.

<details>
<summary><strong>Try a canned assistant demo</strong></summary>

```sh
npm run demo
```

This uses a **canned brain**, not real model reasoning. It disables the panel key and is **not a security sandbox**. Keep it local and treat tool permissions seriously.

For a motion-only conversation preview, open `/cosmic.html?demo=1`. For the five-state motion playground and optional microphone analysis, open `/visualizer.html`.

</details>

## Voice and microphone setup

### Native Windows speech

Use `npm run desktop` with Windows PowerShell 5.1, .NET Framework 4.8, WinForms/System.Speech, a microphone and a compatible **English desktop speech recognizer**. Modern Windows voice-access support alone does not establish that the classic recognizer is installed.

- Select **Talk locally**, or explicitly enable **Hey Quasnooze** in the native widget.
- Wait for **LISTENING** before giving one instruction.
- **Mute** releases recognition. **Stop voice** stops speech/listening behavior as documented; it is **not task cancellation**.
- The native host uses local recognition and synthesis. There is no silent cloud speech fallback.

[Windows setup and limitations →](docs/DESKTOP.md)

### Browser microphone analysis

The visualizer playground uses `navigator.mediaDevices.getUserMedia()` and an `AnalyserNode`.

- Use **HTTPS** or a trustworthy **loopback HTTP** origin such as `http://localhost:7777`. An arbitrary HTTP LAN address generally cannot access the microphone.
- Allow microphone access in the browser and OS. Permission is never inferred from an `.env` setting.
- If embedded in an iframe, the parent must permit microphone access and the server must allow it with Permissions Policy.
- Audio analysis stays in the page: no recording, audio upload or analyser-to-speaker connection.
- Denial, a missing device and a busy device produce actionable messages. Text controls remain usable.

**Important:** browser `SpeechRecognition`, used by the advanced history panel, is a separate path and **may send audio to the browser vendor**. Local FFT analysis does not make browser recognition local. [Exact voice boundaries →](docs/VOICE.md)

No new environment variable is required for the visualizer. `WHISPER_URL` remains optional and applies to recorded voice-note transcription—not canvas animation.

## Three connected surfaces

| Surface | Route | Purpose |
|---|---|---|
| **Command deck** | `/` or `/desktop.html` | Everyday actions, native/microphone status, results and approvals. |
| **Voice conversation** | `/cosmic.html` | Fluid Motion visuals, real text streaming, existing approvals and optional native voice. Existing route retained. |
| **Conversation history** | `/index.html` | History, attachments, memory and advanced chat controls. |
| **Motion playground** | `/visualizer.html` | Five-state previews and explicitly opt-in local microphone analysis. |

![Quasnooze voice conversation with the Fluid Motion engine; scripted preview, no active AI or microphone](docs/images/cosmic-conversation.png)

## Architecture and module map

![Request and visualizer architecture: text or opt-in audio enters existing speech/model paths; policy gates actions; state and separately sourced audio signals drive the visualizer](assets/architecture.svg)

| Module | Implementation | Responsibility |
|---|---|---|
| **Audio Stream Handler** | [`public/audio-input.js`](public/audio-input.js) | Explicit capture, permission errors, cancellation and track/context cleanup. |
| **Frequency Analyzer** | `startAudioAnalysis()` in the same module | FFT bands, RMS-derived level and local-only analyser graph. |
| **Reactive Motion Engine** | [`public/visualizer.js`](public/visualizer.js) | Canvas ribbons, spring smoothing, state transitions, fallback and reduced motion. |
| **Native Voice Bridge** | [`src/windows-companion.js`](src/windows-companion.js), [`desktop/Companion.cs`](desktop/Companion.cs) | Existing Windows recognition, synthesis, mute controls and scalar input telemetry. |
| **Speech-to-text paths** | Browser recognition, Windows System.Speech, [`src/voice.js`](src/voice.js) | Existing browser/native dictation and optional Whisper-compatible voice-note transcription. |
| **Conversation / tool pipeline** | [`src/server.js`](src/server.js), [`src/agent.js`](src/agent.js) | Streaming text, typed failures, tools and approval boundaries. |
| **Provider routing** | [`src/router.js`](src/router.js), [`src/brain.js`](src/brain.js) | Configured model calls and explicitly enabled fallback. |

The visualizer is a **presentation layer**, not a replacement speech recognizer. Native source filenames remain stable for compatibility. The module names above describe responsibilities; they do not imply a new backend service.

### Integrate the renderer

Serve the files from `public/`; there is no build step or runtime package to install.

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

const canvas = document.getElementById("voiceCanvas");
const motion = createVisualizer(canvas);

// Call from your actual application state, not from a decorative timer.
motion.setState("thinking");
document.getElementById("voiceState").textContent = "Processing your request";

// On permanent unmount:
// motion.destroy();
```

For real input, call `startAudioAnalysis()` **inside a click handler**, pass its `sample()` function as the engine’s `signalProvider`, and call `stop()` on mute/unmount. Keep permission handling and capture ownership outside the renderer.

The [integration guide](docs/VISUALIZER.md) includes the complete capture example, API reference, state mappings, design tokens, output-audio limitations and accessibility checklist.

## What Quasnooze can do

| Need | Available capability | Boundary |
|---|---|---|
| Ask, draft or plan | Conversation, local model selection, personas and remembered facts | Answers can be wrong; style/memory cannot grant permissions. |
| Everyday Windows actions | Time/system status, bounded filename search and allowlisted app launches | Requires the native host for native actions; not arbitrary desktop automation. |
| Work with documents | Workspace search, supported attachments and source/citation handling | Bounded access; citations do not guarantee correctness. |
| Use engineering tools | File operations, command tools, calculations and optional MCP/custom tools | Workspace policy and approvals apply; plugins are not OS-sandboxed. |
| Remember and schedule | Reminders, schedules, local history and personal-data export | Delivery needs a running, awake host; validated restore is separate work. |
| Ask the clock, a sum, or a reminder | Deterministic turns answer without a model: time, arithmetic, remembered facts, tasks and reminders | Five closed sentence shapes only; anything ambiguous goes to the model, and `QUASNOOZE_FAST_PATH=off` restores the previous behaviour. |
| Use your chat apps | Telegram, Discord, Slack, WhatsApp and web | Optional setup; external services receive messages sent through them. |

Read-only shell commands such as `ls`, `cat`, `grep`, `git status` and friends
run straight through when they satisfy the risk classifier. Other commands ask; blocked commands remain blocked. [Exact policy and examples →](docs/GUIDE.md#commands-it-runs-without-asking)

See the [capability inventory](docs/CAPABILITIES.json) for implementation evidence and limitations.

## Privacy, permissions and failure handling

- Personal state lives on the machine running Quasnooze. Local does **not** automatically mean encrypted or sandboxed.
- Native microphone use is opt-in and starts muted. A wake phrase is **not authentication**.
- Microphone analysis is local to the playground. Browser recognition, cloud models, network tools and messaging services have different data flows.
- JavaScript plugins run with the process’s privileges. Install only code you trust.
- Disconnecting a page does not establish that a backend task stopped. The playground releases its own capture on hide/unmount; it cannot control the native microphone.

Failed turns use typed results such as `RATE_LIMITED`, `NEED_AUTH`, `UNREACHABLE`, `TIMEOUT`, `CONTEXT_LIMIT` and `STREAM_CUT`. The interface shows an actionable explanation rather than inventing a successful response.

```sh
quasnooze health
```

Provider fallback is **opt-in**. Enabling a cloud fallback can send conversation history to that endpoint. A reply already streaming to the user is not silently restarted elsewhere. [Routing and diagnostics →](docs/ROUTING.md)

Read the [audit](docs/AUDIT.md), [security policy](SECURITY.md), [voice review](docs/VOICE-REVIEW.md) and [desktop guide](docs/DESKTOP.md) before enabling powerful integrations.

## Commands and configuration

From a checkout, use `node bin/quasnooze.js help`. The `pinch` entry remains a compatibility alias.

| Command | Purpose |
|---|---|
| `quasnooze setup` / `quasnooze doctor` | Guided configuration / readiness checks |
| `quasnooze health` | Provider matrix, routing verdict and structured readiness; `--json` for scripts, `--baseline` for the content-free latency artifact ([diagnostics](docs/DIAGNOSTICS.md)) |
| `quasnooze desktop` | Windows native voice host |
| `quasnooze chat` / `quasnooze ask "…"` | Terminal conversation / one-shot question |
| `quasnooze pair` / `quasnooze brain-test` | Phone pairing / model and tool probe |
| `quasnooze export` / `quasnooze cost` | Personal-data export / recorded token-cost estimate |
| `quasnooze audit` / `quasnooze radar` | Local guardrails / runtime and repository drift |

Use `.env` or process environment. Prefer `QUASNOOZE_*`; corresponding `PINCH_*` names remain accepted. Real environment overrides `.env`. Data paths are not moved by this refresh. [Migration rules →](docs/REBRANDING.md)

**npm status:** metadata uses `@quasynvo/quasnooze`; publication and scope ownership are not established by this repository change. Use the Git checkout until maintainers publish and verify a release.

## Build and verify

```sh
# Runtime regression suite and local audit
node --test --test-concurrency=4
node scripts/audit.js
node scripts/validate-roadmap.js
```

The visualizer has focused tests for state mapping, signal freshness, microphone cleanup and reduced motion. Browser checks use disposable fixtures; they are not native-hardware or audio-quality evidence.

To rebuild README/brand assets, install **Python 3 + Pillow** as developer tools, then run:

```sh
python3 scripts/build-brand-assets.py
```

This also synchronizes the shared renderer into the static website. The [validation record](docs/brand/VALIDATION.md) separates checks actually run from pending platform acceptance.

## Contribute

1. Choose an [open contributor task](https://github.com/Quasynvo/Quasnooze/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
2. Comment before starting to coordinate ownership.
3. Add focused regressions, run the checks and open a small PR.

Motion changes must preserve signal honesty, keyboard access and reduced-motion behavior. See [CONTRIBUTING.md](CONTRIBUTING.md), the [visualizer contract](docs/VISUALIZER.md) and the [product roadmap](docs/ROADMAP-PROPOSED.md).

[User guide](docs/GUIDE.md) · [Voice boundaries](docs/VOICE.md) · [Voice control roadmap](docs/VOICE-CONTROL-ROADMAP.md) · [Competitive frontier](docs/COMPETITIVE-FRONTIER.md) · [Fast-path evaluation](docs/FAST-PATH-EVAL.md) · [Channels](docs/CHANNELS.md) · [Conversation behavior](docs/CONVERSATION.md) · [Runtime support](docs/SUPPORT.md)

Maintained by **[Ranjith Rosan](https://github.com/RANJITHROSAN17)** and the [open-source contributors](https://github.com/Quasynvo/Quasnooze/graphs/contributors), under **[Quasynvo](https://github.com/Quasynvo)**. Previous attribution is preserved. [MIT license](LICENSE).

### Durable configuration for packaged installs

Packaged installs keep `.env` and personal data in a stable per-user location,
not in the npm installation or npx cache. Git checkouts retain their existing
local paths; explicit `PINCH_DATA` / `QUASNOOZE_DATA` overrides are preserved.
Use `quasnooze migrate-state` to preview copying legacy package state, then
`quasnooze migrate-state --apply` for interactive confirmation. See
[storage locations, migration and uninstall guidance](docs/USER-STATE.md).

### Retention preview (no deletion)

Run `quasnooze retention-plan --json` for a bounded, metadata-only inventory of
sessions, memory, reminders, schedules and telemetry. Policies default off;
optional age thresholds are preview-only and are never saved or applied. See
[retention categories, safety and platform limitations](docs/RETENTION.md).

### Synthetic retrieval evaluation

Run `node scripts/evaluate-retrieval.js` from a source checkout to reproduce the
[labelled offline retrieval baseline](docs/RETRIEVAL-EVALUATION.md). It reports
recall/rank metrics, cold/warm index counters, stale-update checks and known
no-answer failures. Citation provenance is tested separately; model-answer
faithfulness is explicitly not run. No private corpus, model or network is used.

### Local support diagnostics

`quasnooze support-bundle` previews a separate, allowlisted diagnostic artifact.
Saving requires `--out FILE --write` and interactive confirmation; there is no
upload or automatic personal-data export. See
[support-bundle fields, limits and privacy caveats](docs/SUPPORT-BUNDLE.md).
