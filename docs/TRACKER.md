# Local ticket tracker

Per-repository tickets as **plain Markdown files in a directory you choose**.
No account, no token, no network — the tracker is a directory, and the assistant
reads and drafts files in it.

The feature is **off by default**. While it is off, the three tracker tools are
not offered to the model at all (`toolSchemas()` omits them), and a model that
remembers a name from an earlier session gets a refusal rather than a filesystem
read.

```sh
# 1. turn the feature on (see .env.example)
QUASNOOZE_TRACKER=on

# 2. see what a repository already has; this creates nothing
quasnooze tracker discover ./my-project

# 3. record the directory you want, answering the prompt yourself
quasnooze tracker setup ./my-project/tickets --repo ./my-project --name "My project"

# what is configured, and where
quasnooze tracker status
```

## What the tools do

| Tool | Approval | Effect |
| --- | --- | --- |
| `tracker_list_tickets` | none (read-only) | Lists `*.md` tickets: id, title, labels, a bounded summary. |
| `tracker_read_ticket` | none (read-only) | Returns one ticket's body by validated id. |
| `tracker_draft_ticket` | **every call** | Creates exactly one new ticket file. Never overwrites, never deletes. |

Drafting shows you the exact title, labels and body size before anything is
written, in the same approval prompt every other write tool uses. A draft costs
one prompt; a denial writes nothing.

## The ticket format

Deliberately not YAML. Front matter is a fixed `key: value` subset, because a
general parser is a large attack surface for a file whose only job is to say
"title" and "labels".

```markdown
---
title: Fix the login timeout
created: 2026-01-01T00:00:00.000Z
labels: bug, auth
---

The token refresh loops forever.
```

Accepted keys are `title`, `created` and `labels`. An unknown key, a duplicate
key, a line that is not `key: value`, a missing or unclosed front matter block,
and control or bidirectional characters are all refused — the ticket is
reported as invalid rather than repaired, because a repaired ticket is not the
one the human wrote. `tracker_list_tickets` shows invalid files as rows so the
owner can see and fix them; it never silently drops them.

## Bounds

Every limit is a refusal, never a truncation:

| Limit | Value |
| --- | --- |
| Files listed per directory | 500 |
| One ticket file | 256 KiB |
| Body length | 20,000 characters |
| Title | 200 characters |
| Labels | 10, each at most 40 characters |
| Ticket id | `[a-z0-9][a-z0-9-]{0,63}` |

A file over the size limit is refused, not half-read: half a ticket looks like
a whole one.

## What is refused

- **Traversal and hostile ids.** `..`, `../x`, `/etc/passwd`, `a/b`, `a\b`,
  leading dots, uppercase, spaces and NUL bytes are rejected against the id
  pattern *before* a path is built, and the assembled path is additionally
  required to be inside the tracker directory. Two independent checks.
- **Symlinks.** Listing uses `withFileTypes` and takes only regular files, so a
  symlink named `good-ticket.md` pointing at `~/.ssh/id_rsa` never appears as a
  ticket, and reading it directly is refused rather than followed.
- **File-system races.** The reader validates the *opened descriptor*
  (`O_NOFOLLOW` + `fstat`) rather than stat-ing the name and opening it later,
  so there is no window in which a path could be swapped for a symlink or a
  larger file between the check and the read.
- **Credential stores as roots.** `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`,
  `~/.config/gh` and friends can never be a tracker directory, even inside your
  own home directory. `test/tracker-local.test.js` asserts this list still
  agrees with the one in `src/tools.js`.
- **Overwrites.** Drafting uses an exclusive create (`wx`), so the existence
  check and the write cannot be split by another process. An existing id is an
  error, never a replacement.

## Consent

- The first configuration of a repository records the owner's choice; the CLI
  asks before writing and a refusal writes nothing.
- **Changing** where a repository's tracker points requires an approval token
  minted after a human said yes. The agent cannot reconfigure itself.
- **Disabling** never requires approval. Taking a capability away is always
  allowed; requiring consent to stop something would be a trap.
- Configuration lives in `<state>/data/tracker-config.json` (see
  `docs/USER-STATE.md`), **never in the repository**. Discovery and setup do not
  run git, do not open a remote, and do not touch `.git/config`, remote URLs or
  repository policy files. `test/tracker-local.test.js` asserts `.git/config` is
  byte-identical after discovery.

## Relationship to the GitHub contributor automation

None. The contributor queue, roadmap bots and PR governance are repository
workflows under `.github/`; this is a local runtime feature under `src/tracker/`.
They share no code, and a test asserts the contributor workflow neither mentions
these tools nor the feature switch. The remote GitHub/GitLab adapters are a
separate, later roadmap item (`harness-11-tracker-remote`) and are not part of
this one.
