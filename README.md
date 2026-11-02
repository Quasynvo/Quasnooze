<p align="center">
  <img src="assets/quasnooze-showcase.gif" width="100%" alt="Quasnooze by Quasynvo — illustrated cosmic assistant states: idle, thinking, illustrative speaking and permission required" />
</p>
<h1 align="center">Quasnooze</h1>
<p align="center"><b>Intelligence, in your orbit.</b><br>A local-first personal AI assistant by <a href="https://github.com/Quasynvo">Quasynvo</a>.<br>Your everyday tools. A cosmic sloth companion. Your permission, first.</p>
<p align="center">
  <a href="https://github.com/Quasynvo/Quasnooze/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/Quasynvo/Quasnooze/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-83f5ed" /></a>
  <a href="docs/AUDIT.md"><img alt="Security review and limitations" src="https://img.shields.io/badge/security-review%20%26%20limits-ba9dff" /></a>
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-83f5ed" />
</p>
<p align="center"><a href="#start-in-three-steps">Start here</a> · <a href="#what-can-it-do">Capabilities</a> · <a href="#three-ways-to-meet-your-assistant">See the experience</a> · <a href="docs/GUIDE.md">Full guide</a> · <a href="https://github.com/Quasynvo/Quasnooze/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22">Contribute</a></p>

> **New name, same project.** Quasnooze was previously called Pinch. Existing configuration, data, approval policies and the legacy `pinch` CLI alias remain supported. [Migration and compatibility →](docs/REBRANDING.md)
>
> The animated header is an **illustrated state walkthrough**, not a recorded model benchmark or live microphone. Use the reduced-motion [static header](assets/banner.png) if preferred.

## What is Quasnooze?

An assistant you run on **your own computer**. Ask a question, plan your day, look up a file, set a reminder, or use supported tools. A luminous space sloth makes the conversation feel present—not artificially slow.

- **Local by default:** Ollama handles local reasoning. Optional cloud providers and messaging channels have separate network/data boundaries.
- **Present on Windows:** native tray/widget, opt-in “Hey Quasnooze,” local speech, a talk hotkey and explicit action confirmations.
- **Visible, not mysterious:** see real progress, tool activity, microphone state and requests for permission.
- **Still your machine:** sensitive actions remain gated. The companion is not an OS sandbox or unrestricted computer-control agent.

**Status:** the Windows resident and illustrated conversation experiences are previews. Physical Windows microphone, wake-word, startup and accessibility acceptance still require testing. The avatar is 2.5D illustration—not headset VR, a 3D model or phoneme-accurate lip sync.

## Start in three steps

**Requirements:** Node.js **22+**; Windows 10/11 for the native resident companion. The web/channel assistant also runs on Linux and macOS. No browser bundle, CDN or required runtime dependency is needed for basic local/web use; WhatsApp/QR support has optional packages.

### 1 · Get the code

```sh
git clone https://github.com/Quasynvo/Quasnooze.git
cd Quasnooze
```

### 2 · Choose your setup

```sh
npm run setup
npm run doctor
npm run brain
```

The guide walks through the model, workspace, access key and optional channels. Install/start **Ollama** and choose an installed model for real local reasoning. Setup does not make a model or microphone available by magic.

### 3 · Start your assistant

```sh
# Windows resident mode: native tray/widget, starts with microphone muted
npm run desktop

# Or the cross-platform web and configured-channel assistant
npm start
```

Open the panel URL printed by the launcher. The default port is `7777`; a keyless default server stays on loopback. **Do not expose an unauthenticated assistant or forward its port.**

<details>
<summary><b>Just looking? Try the canned demo first.</b></summary>

```sh
npm run demo
```

No model or account tokens are required. This is a **canned brain**, not a demonstration of real AI reasoning. It disables the panel key and is **not a security sandbox**: keep it local, do not expose its port, and treat any tool permissions seriously.

For an animation-only preview, visit `/cosmic.html?demo=1`. That explicit scripted mode makes no AI/tool/audio request. It does not mute a separately running native companion.
</details>

## Three ways to meet your assistant

| View | Where | What it is for |
|---|---|---|
| **Command deck** | `/` or `/desktop.html` | Everyday actions, actual native/mic/model state, results and approvals. |
| **Cosmic conversation** | `/cosmic.html` | Animated face-to-face sloth, real text streaming, existing approvals and optional native voice. |
| **Conversation history** | `/index.html` | Existing history, attachments, memory and advanced chat controls. |

![Quasnooze cosmic conversation — scripted UI preview, no active AI or microphone](docs/images/cosmic-conversation.png)

The avatar’s calm motion is decorative. Thinking means backend work; it does **not** mean spoken audio. Speaking animation follows reported Windows voice state, or an explicitly labelled silent preview. **Stop voice is not task cancellation.** Reduced-motion controls are available in the conversation settings and respect the OS preference.

## What can it do?

| You want to… | What is available | Important boundary |
|---|---|---|
| Ask, draft or plan | Conversation, local model selection, personas and remembered facts | Model answers can be wrong; memory/personas cannot grant permissions. |
| Get everyday help | Time/system status, bounded filename search and allowlisted app launches in resident mode | Native actions require the Windows companion; not arbitrary desktop automation. |
| Work with documents | Workspace document search, supported attachments and source/citation handling | Bounded access; citation provenance is not proof of answer correctness. |
| Use engineering tools | File reads/writes, command tools, calculations and optional MCP/custom tools | Workspace policy and approvals apply. Plugins are not OS-sandboxed. |
| Remember something | Reminders, schedules, local history and personal-data export | Sleeping/offline hosts and delivery failures have limitations; restore is separate planned work. |
| Meet in your chat app | Telegram, Discord, Slack, WhatsApp and web | Account setup is optional; external services receive the messages you send through them. |

See the [capability inventory](docs/CAPABILITIES.json) for implementation evidence and limitations—not marketing parity claims.

## How a request moves

![Quasnooze request flow: request, local intent or model, policy and approval, execution, visible result](assets/architecture.svg)

1. **Ask** from the resident companion, web or a configured channel.
2. **Route** a supported simple resident action directly; use the configured model when reasoning is needed.
3. **Check policy** and request approval for sensitive actions.
4. **Show the result** honestly—including failures, sources and uncertain effects.

Read-only shell commands such as `ls`, `cat`, `grep`, `git status` and friends
run straight through when they satisfy the risk classifier. Other commands ask; blocked commands remain blocked. [Exact policy and examples →](docs/GUIDE.md#commands-it-runs-without-asking)

## When the model does not answer

A failed turn is typed rather than guessed at: `RATE_LIMITED`, `NEED_AUTH`, `UNREACHABLE`,
`TIMEOUT`, `UPSTREAM_BROKEN`, `PAYLOAD_MISMATCH`, `BAD_INPUT`, `CONTEXT_LIMIT`, `STREAM_CUT`. Each
carries the one sentence that tells you what to do about it, and the reply says which provider
failed — not advice to restart a service that was running fine.

`quasnooze health` is the command to reach for when something breaks. It calls each provider for
real, prints status codes and latencies, shows whether a turn would survive losing its provider,
and exits non-zero so a script can act on it:

```
▲ routing   single provider (ollama) — a 429, 5xx or refused connection has nowhere to go
    Set LLM_FALLBACK=openai to survive an Ollama outage. That sends the turn's history to the
    cloud endpoint, so it stays off by default.
```

Falling back to a second provider is opt-in for that reason: Quasnooze is local-first, and quietly
sending a conversation to a cloud endpoint to keep a turn alive is your decision, not a default.
A reply that has already started on screen is never re-asked elsewhere — that would print the
answer's beginning twice. [The whole story →](docs/ROUTING.md)

## Privacy, permissions and honest limits

- Conversations and personal state live on the machine running Quasnooze. Local does **not** automatically mean encrypted or sandboxed.
- Native microphone use is opt-in and starts muted. A wake phrase is **not authentication**.
- Optional browser recognition may use the browser vendor; prefer the native companion for local Windows speech. Read [voice boundaries](docs/VOICE.md).
- Network tools, configured cloud providers and external messaging services have their own data flows. There is no mandatory cloud audio or hidden remote-model fallback in resident requests.
- JavaScript plugins run with the process’s privileges. Install only code you trust.
- An animation cannot approve an action. Disconnecting a page does not guarantee a backend task stopped.

Read [the audit and known limitations](docs/AUDIT.md), [security policy](SECURITY.md), [voice review](docs/VOICE-REVIEW.md) and [desktop guide](docs/DESKTOP.md) before enabling powerful integrations or exposing the service.

## Commands and configuration

From a checkout, use `node bin/quasnooze.js help`. The `pinch` entry remains a compatibility alias.

| Command | Purpose |
|---|---|
| `quasnooze setup` / `quasnooze doctor` | Guided configuration / readiness checks |
| `quasnooze health` | Provider matrix, routing plan and verdict; `--json` for scripts, exits 1 on failure |
| `quasnooze desktop` | Windows resident companion |
| `quasnooze chat` / `quasnooze ask "…"` | Terminal conversation / one-shot question |
| `quasnooze pair` / `quasnooze brain-test` | Phone pairing / model/tool probe |
| `quasnooze export` / `quasnooze cost` | Personal-data export / recorded token-cost estimate |
| `quasnooze audit` / `quasnooze radar` | Local guard rails / runtime and repository drift |

Use `.env` or process environment. New `QUASNOOZE_*` names are preferred; corresponding `PINCH_*` names remain accepted. Real environment overrides `.env`; within one layer the new spelling wins. Data paths are **not moved** by this rebrand. [Full migration rules →](docs/REBRANDING.md)

**npm release preparation:** metadata now uses `@quasynvo/quasnooze` with the `quasnooze` command and legacy `pinch` alias. **This is not proof that the npm scope/package is registered or published.** Use the Git checkout instructions until maintainers publish and verify a release. Never install an unrelated similarly named package expecting this project.

## Help build the next orbit

1. Choose an [open contributor task](https://github.com/Quasynvo/Quasnooze/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22).
2. Comment before starting to coordinate ownership.
3. Add focused regressions, run the checks, and open a small PR.

```sh
node --test --test-concurrency=4
node scripts/audit.js
node scripts/validate-roadmap.js
```

The bots maintain a bounded, evidence-backed queue—**up to ten open contributor tasks**, not ten invented issues per day. Independent review and human merges remain required. See [contributing](CONTRIBUTING.md), [queue operation](docs/CONTRIBUTOR-QUEUE.md) and the [product roadmap](docs/ROADMAP-PROPOSED.md).

## Learn more

[User guide](docs/GUIDE.md) · [Routing and diagnostics](docs/ROUTING.md) · [Desktop and local voice](docs/DESKTOP.md) · [Channels](docs/CHANNELS.md) · [Conversation behavior](docs/CONVERSATION.md) · [Runtime support](docs/SUPPORT.md) · [Brand and migration](docs/REBRANDING.md)

Maintained by **[Ranjith Rosan](https://github.com/RANJITHROSAN17)** and the [open-source contributors](https://github.com/Quasynvo/Quasnooze/graphs/contributors), under **[Quasynvo](https://github.com/Quasynvo)**. Previous author/contributor attribution is preserved. [MIT license](LICENSE).
