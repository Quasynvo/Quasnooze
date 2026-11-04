# Awesome-list submissions

Ready-to-paste entries and PR notes for the curated GitHub lists where
Quasnooze genuinely belongs, plus the lists where it does not.

The rules that shape everything below:

- **One entry per pull request.** Every list here enforces it.
- **Match the list's own format.** These lists do not share one. Awesome Ollama
  uses a four-column table; the local-first lists use a bullet with a trailing
  period, and one of them uses an en dash instead of a hyphen.
- **Say what it does, not how it feels.** No badges, no emoji, no
  "blazing-fast", no feature checklist. A rejected PR is usually a marketing
  paragraph.
- **Do not claim more than the repository can prove.** See
  [claim guardrails](#claim-guardrails) — several plausible-sounding lines
  about this project are false.

---

## 1 · Awesome Ollama — `EndoTheDev/Awesome-Ollama` (≈490★)

The best single fit: the list has an **Assistants** section, is actively
maintained, and covers apps that use a local model as their default brain.

### The entry (table row, `## Assistants`)

```markdown
| [Quasnooze](https://github.com/Quasynvo/Quasnooze) | Local-first personal assistant with permission-gated tools | Source | MIT |
```

- **Description** — six words, factual, and deliberately does **not** mention
  Ollama: that list's `CONTRIBUTING.md` says "Don't mention Ollama (implied)".
- **Install** — `Source`, not `npm`. The package metadata names
  `@quasynvo/quasnooze`, but [publication is not established](../README.md),
  so `npm` would send readers to a 404. Change it to `Source, npm` the day a
  release actually installs.
- **License** — `MIT`, the SPDX identifier, matching [LICENSE](../LICENSE).
- **Linting** — that repository requires `python scripts/lint.py README.md` to
  pass; run it with `--fix` for cell padding before pushing.
- Longer alternative if a reviewer asks for more detail: *"Local-first
  assistant for the desktop and five chat channels, with a visible
  risk-classified approval gate."*

### PR title

```text
Add Quasnooze to Assistants
```

### PR body

```markdown
Adds **Quasnooze** to *Assistants*.

Quasnooze is a local-first personal AI assistant: Ollama is the default
provider, and tools, memory, reminders and conversation history live on the
machine running it. Optional cloud providers, browser speech, network tools and
messaging channels each have a separate, explicit boundary that the user turns
on.

Why it meets the bar for this list:

- **Local model first, not local as a fallback.** `src/brain.js` defaults to
  Ollama; an openai-compatible provider only activates when the user configures
  a key. Fallback between providers is opt-in and never silently restarts a
  stream that already reached the user.
- **Zero runtime dependencies.** Everything is Node 22+ built-ins — including a
  hand-written RFC 6455 WebSocket client for the Discord gateway instead of a
  bot framework. Nothing is installed to try it but the checkout.
- **Documented permission model, not a system prompt.** Shell and file tools
  pass a deterministic risk classifier (`src/risk.js`): read-only commands run,
  anything else asks for approval in the UI, and a blocklist stays blocked even
  if approved. The animation is presentation; it can never approve an action.
- **Tested and reviewed like software, not a demo.** 669 `node:test` cases in 54
  files, CI on Node 22 and 24 plus a Windows job, CodeQL, and a nightly audit of
  the guard rails. MIT licensed.
- **Honest about limits.** The README states which surfaces are previews, that
  the voice visual is a canvas signal rather than a 3D avatar, that local does
  not mean encrypted, and that plugins are not OS-sandboxed.
  `docs/CAPABILITIES.json` ties every claimed capability to a file you can open.

Runs on Windows for the native speech host; the web and chat-channel assistant
also runs on Linux and macOS. I checked the entry against `scripts/lint.py` and
kept it to a single row in the existing table. Happy to adjust the wording,
section or install value if you'd prefer it elsewhere.
```

---

## 2 · Awesome Local-First — `royalpinto007/awesome-local-first`

Bullet format, description ends with a period, section **Applications →
Productivity**. No `CONTRIBUTING.md` in that repo, so the safest rule is: match
the neighbouring lines exactly.

```markdown
- [Quasnooze](https://github.com/Quasynvo/Quasnooze) - Local-first personal AI assistant with permission-gated tools.
```

Alphabetical placement matters more than the line itself: in `### Productivity`
the entries run **A**FFiNE → **O**rkas, so Quasnooze goes **after Orkas**. That
section's house style favours a longer, two-sentence description — the local
variation is acceptable if a maintainer prefers it:

```markdown
- [Quasnooze](https://github.com/Quasynvo/Quasnooze) - Local-first personal AI assistant with a local Ollama default, on-disk conversation state and an explicit approval gate for shell and file tools.
```

**PR body**

```markdown
Adds Quasnooze to *Applications → Productivity*.

Quasnooze is a local-first personal assistant. Conversations, memory, reminders,
schedules and settings are files on the machine running it, and Ollama is the
default reasoning provider; cloud models, browser speech and chat channels are
opt-in with separate boundaries. It is Node 22+ with **zero runtime
dependencies**, MIT licensed, and tested with 669 `node:test` cases.

The part that seemed relevant to this list: the local/tool boundary is explicit
rather than implied. Read-only shell commands run, anything else requires
approval in the interface, and a blocklist is enforced regardless of approval —
the model cannot talk its way past the gate. Called out in the README rather
than buried: local is not a synonym for encrypted, and plugins are not
OS-sandboxed.

Single entry, alphabetised after Orkas. Happy to reword or move it.
```

---

## 3 · Awesome Local-First — `alexanderop/awesome-local-first` (≈240★)

Same family, different punctuation: **en dash**, no trailing period, under
**Example Applications → Productivity & Collaboration**.

```markdown
- [Quasnooze](https://github.com/Quasynvo/Quasnooze) – Local-first personal AI assistant with a local Ollama default and an explicit tool-approval gate
```

Submit this **after** the previous list has accepted the entry, and space the two
PRs at least a few days apart — the lists share maintainers and readers, and
back-to-back submissions read as a campaign.

---

## 4 · Where this repository does not belong

Submitting to these is worse than not submitting: a closed PR with "does not
fit" is public, and it is attached to the repo name.

| List | Why not |
|---|---|
| `awesome-selfhosted` | Requires software a non-technical user can self-host for a group, typically Docker-first. Quasnooze is one person on one laptop, distributed as a Node checkout, and says so. |
| `awesome-nodejs` | That list is libraries and tools, not end-user applications. |
| `awesome-privacy` | Its inclusion criteria are audited, hardened client software; a project whose own README says "local does not mean encrypted" does not clear that bar yet. |
| `sindresorhus/awesome` | Meta-list; only accepts lists. |

Revisit `awesome-privacy` only after encryption at rest and a completed
independent review exist. Revisit `awesome-selfhosted` never, unless the product
identity changes.

---

## Claim guardrails

Lines that sound right and are wrong, in a repository whose README is careful
about exactly this:

| Don't write | Write instead |
|---|---|
| "Fully offline" | "Local by default" — cloud providers and network tools exist and are opt-in. |
| "Private / encrypted" | "Your data stays on your machine" — it is not encrypted at rest and not sandboxed. |
| "Secure sandbox" | "Permission-gated tools" — JavaScript plugins run with the process's privileges. |
| "Production-ready" / "stable release" | "Preview" — the native Windows voice host and browser conversation experience are previews, and no npm release is published. |
| Anything about wake-word security | A wake phrase is explicitly **not** authentication. |
| Star counts, benchmark wins, "better than X" | Nothing. This repository has no published benchmark and no competitor comparisons it stands behind. |

## Order of operations

1. `EndoTheDev/Awesome-Ollama` — strongest fit, table row, linted.
2. `royalpinto007/awesome-local-first` — bullet format, alphabetised after Orkas.
3. `alexanderop/awesome-local-first` — en dash variant, a few days later.
4. Stop. Three lists is a signal; ten is spam, and the same maintainers read
   all of them.

Track the outcome in the issue that references this document rather than adding
a status table here — a stale "submitted" claim is the same failure mode as a
stale capability claim in [`CAPABILITIES.json`](CAPABILITIES.json).
