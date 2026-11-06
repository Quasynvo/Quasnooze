# Structured approval previews

Approval events and pending-approval snapshots may now include an additive
`preview` object. Existing approval IDs, descriptions, answers, timeout, ownership,
session/channel routing, deny behavior, and unattended/dangerous-tool policy
remain unchanged. Metadata never authorizes an operation: only the existing
approval gate does. Original validated tool arguments still reach the tool;
preview text must never be parsed back into executable arguments.

Version 1 fields:

| Field | Meaning / maximum characters |
| --- | --- |
| `version` | `1` |
| `status` | `supported` or `unknown`; not an execution-success prediction |
| `tool`, `action` | Tool and requested action, 80 characters each |
| `target` | Requested target, 240 characters; not a sandbox/path resolution proof |
| `riskRationale` | Why the action warrants review, 320 characters |
| `effectSummary` | Expected effect or explicit unknown, 320 characters |
| `redactions` | Fixed reason codes for withholding, sensitive/control text or truncation |

Supported summaries cover shell execution, file writes, opening URLs, screenshots,
system/window/app actions, and clipboard read/write requests. Unknown/custom tools expose no arguments and report
unknown targets/effects rather than inventing a dry run. Shell summaries describe
the working directory and explicitly unknown side effects, **not** a parsed or
predicted list of affected files. File-write content is never copied into metadata;
URLs omit credentials, query and fragment. Screenshot summaries warn about visible
personal information. Clipboard read summaries never read or show current clipboard
contents before approval; clipboard write summaries show the proposed replacement
text (subject to secret/control redaction and field bounds) so you can inspect what
would overwrite your clipboard. A generated/default target is labelled unresolved.

The original human-readable description remains alongside the preview, with
redaction and a 2,000-character limit. A preview is not an exhaustive view of a
long command: if target/effect/command details are unknown or clipped, deny and
request a smaller, inspectable action. `supported` means a summary template
exists, not that an action is safe or policy-approved.

## Rendering and privacy

Web conversation UIs and the command deck assign preview text using `textContent`.
The shared browser formatter also caps received fields. Native approval text,
CLI prompts and channel callbacks carry the same display-only information.
Telegram button prompts use plain text rather than interpreting untrusted
preview text as Markdown. Preview data cannot change approval IDs or answer
payloads. Disconnect/stale-ID behavior remains governed by existing approval
and desktop-generation controls.

Redaction removes configured process-environment credential values (key/token/
secret/password/credential names, at least four characters), configured app/model/
chat credentials, URL credentials and common token/credential assignment patterns.
Known values are removed before clipping, including percent-encoded values.
Control and bidi-control characters are replaced. Redaction is best effort, not
a promise to discover arbitrary personal information or every encoding of a
secret. Do not put secrets in paths or commands. `none detected` is not a privacy
or safety guarantee. New metadata never includes clipboard contents or raw shell
commands, and unsupported argument payloads are withheld entirely.

Preview objects live only with pending approvals/events and are not added to
session traces, telemetry, logs or a persistent action timeline. Existing user
messages, tool traces and channel-provider messages retain their existing storage
behavior; this feature does not retroactively scrub their content or assert
that the rest of the application never records a command. No new clipboard read,
raw-command persistence, cloud service or cancellation/timeline subsystem is
introduced.

## Verification boundary

Synthetic tests check bounded fields, unknown tools, secret canaries, literal
hostile HTML, immutable snapshots, allow/deny/stale IDs, desktop disconnection,
and unattended blocks with mock tools. Existing regression tests exercise current
approval/scoping policies. Linux automated tests are not physical Windows, native
UI, browser accessibility or user-acceptance validation. Those manual/hardware
checks were not performed. Independent maintainer review remains required.
