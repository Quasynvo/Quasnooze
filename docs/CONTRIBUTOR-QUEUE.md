# Continuous product contributor queue

The [proposed product roadmap](ROADMAP-PROPOSED.md) is translated into bounded,
contributor-ready entries in `.github/roadmap.json`. The initial public batch is
readiness/performance evidence, muted resident recovery, and durable user state.
These are medium/hard engineering tasks, not good-first-issue labels.

## How work appears

- The existing `Contributor queue` workflow runs hourly (at minute 23), on issue
  closure, on relevant pushes to main, and by manual dispatch. GitHub scheduling
  is best-effort, not a guaranteed exact-hour service.
- Complete `ready` entries are preferred, then complete `backlog` entries. Historical
  markers `<!-- roadmap:ID -->` prevent duplicate filing across open **and closed**
  issues. Closing a declined task does not cause it to be re-filed.
- At most ten open contributor tasks share the board across roadmap and Growth
  publishers; the easy roadmap-task cap remains three. This is a ceiling, not ten
  new issues daily. PRs and the rolling status dashboard do not occupy task slots.
  Markers or contributor labels identify tasks; ordinary unlabelled user reports
  are not automatically treated as approved contributor work.
  Ordinary analysis may still produce no eligible work; the bot never invents tasks.
- `auto_file: false` is an explicit gate even when the body is complete and status
  is `ready`. NEXT entries remain gated until a maintainer reviews prerequisite
  acceptance evidence and promotes them through a PR. Merely merging code or
  closing a prerequisite issue is not proof of Windows/hardware acceptance.
- Missing `auto_file` preserves existing eligible-task behavior. Non-boolean values
  fail manifest validation. Selection is tested in `test/roadmap-queue.test.js`.

The existing Growth loop continues separate evidence gathering and analysis.
New feature ideas must be reviewed for duplication, value and safety before
becoming approved queue entries; this change does not authorize a model to choose
unreviewed features or install plugins. More reviewed entries can be added over
successive delivery cycles, so the queue is replenishable, not an infinite task
factory.

## Why the board can look empty

A quiet board and a finished roadmap look identical from the outside: four open
issues either way. They are not the same thing, and the status issue now says
which one you are looking at.

Every unfiled item is held by exactly one gate, and the reason is printed in the
**Filing queue** section of the rolling status issue and in the workflow run
summary:

| Gate | Meaning | How it clears |
|---|---|---|
| `not_before` | Staged release date (UTC). The item is complete and approved; it is simply scheduled. | The calendar. The queue files it on that date, at the hourly run. |
| `depends_on` | A prerequisite is not finished. | The manifest marking it `shipped`, **or** its issue closing. |
| `auto_file: false` | A maintainer veto on automatic filing, even for a complete item. | A human promotes it in a PR, or drops the flag. |
| caps | Ten open contributor tasks, three of them easy. | Closing an issue. |

Two rules exist because the alternative was a queue that stopped filing and said
nothing:

- **A closed issue is shipped.** Dependency checks accept either the manifest's
  `status` or a closed, non-PR issue carrying `<!-- roadmap:ID -->`. The manifest
  is reviewed at review speed; the tracker records what happened. When they
  disagree, the tracker wins, because otherwise every dependent item waits for a
  field nobody wrote.
- **Refusals name themselves.** `node scripts/roadmap-queue.js .github/roadmap.json all.json --report`
  prints what would file today, what each waiting item is blocked on, and the
  soonest date any of them opens. `--check`-style silence is not allowed: a skip
  reason without a date reads like "finished".

`.github/roadmap.json` is still the reviewed source of truth, and the daily
`Roadmap reconciliation` workflow keeps it honest: it derives `status: shipped`,
`issue` and `shipped_at` from closed issues, then opens **one pull request**
(branch `bot/roadmap-reconcile`) for a human to merge. It never pushes to main,
never marks anything unshipped, and never edits a title, body, label or date.

To pull a staged cohort forward without editing dates — for example to test the
queue itself — dispatch `Contributor queue` with `as_of: YYYY-MM-DD`. That date
replaces "today" for the gate comparison **only**: `auto_file: false` and unmet
dependencies still refuse.

## Contributing

Comment on an issue before starting to coordinate ownership. Include targeted
regressions, exact full-suite/audit results and explicit unperformed hardware checks
in a small PR. N2/N3 design may proceed alongside N1, but agree its diagnostics/path
contracts before integration. See the acceptance criteria in each issue.

Human review, code-owner/last-push protections and human merges stay in place.
No bot closes human-created issues under the shipped-item automation; merge-linked
`Closes #…` and deliberate maintainer decisions retain normal behavior. Release
metadata remains separate from implementation acceptance. Keep the current rolling status issue open as the
dashboard; gated rows must be displayed as requiring maintainer approval.

## Verification

```sh
node scripts/validate-roadmap.js
node --test test/roadmap.test.js test/roadmap-queue.test.js
node --test --test-concurrency=4
node scripts/audit.js
```

Before a non-dry run, inspect selection against real issue history:
`node scripts/roadmap-queue.js .github/roadmap.json /path/to/issues.json`.
Input is an array with issue `body` and `state`, not a secret-bearing dump. Preserve
markers when editing issues; use the workflow's dry-run input to inspect candidates
without filing, commenting or closing.


## Ten-task shared board

The reviewed manifest sets `open_curated_cap: 10`. Both automatic publishers use
that ceiling and the same Actions concurrency group to serialize publishing.
Growth keeps its separate earned quota and proposal sub-cap; these are not raised.
Roadmap selection counts open growth proposals and contributor-labelled tasks as
well as roadmap markers. Growth counts the same board before proposing anything.
All open issues are considered for Growth board counts even when the recent history
window contains many PRs. Existing deduplication rules and NEXT manual gates remain.

If people manually open tasks during a run, they can race the snapshot; this is a
bot-side ceiling, not an atomic GitHub server quota. The bot does not delete or close
human reports to force a count of ten. More than ten manually opened tasks causes
future automatic filing to pause. Hourly checks cover every day, but an empty
eligible backlog is a valid no-op; no issues are fabricated to fill ten slots.

The seven additional entries distinguish one reproduced Growth planner state-case
bug from six feature/evaluation proposals. See each issue for source evidence,
prerequisites, acceptance criteria and unperformed physical Windows checks.

### Initial ten-task board (2026-11-03)

This is a publication snapshot, not a live completion claim; issue state is authoritative.

| Issue | Task type | Scope |
|---|---|---|
| [#85](https://github.com/Quasynvo/Quasnooze/issues/85) | Feature/evidence | Readiness and latency baseline |
| [#86](https://github.com/Quasynvo/Quasnooze/issues/86) | Reliability improvement | Muted resident recovery |
| [#87](https://github.com/Quasynvo/Quasnooze/issues/87) | Portability improvement | Durable user state/migration |
| [#89](https://github.com/Quasynvo/Quasnooze/issues/89) | Reproduced bug | Growth state normalization and its own proposal cap |
| [#90](https://github.com/Quasynvo/Quasnooze/issues/90) | Feature proposal | Structured approval previews |
| [#91](https://github.com/Quasynvo/Quasnooze/issues/91) | Feature proposal | Read-only retention preview |
| [#92](https://github.com/Quasynvo/Quasnooze/issues/92) | Evaluation | Labelled retrieval-quality corpus |
| [#93](https://github.com/Quasynvo/Quasnooze/issues/93) | Feature proposal | Allowlisted local support bundle |
| [#94](https://github.com/Quasynvo/Quasnooze/issues/94) | Evaluation | Desktop accessibility acceptance |
| [#95](https://github.com/Quasynvo/Quasnooze/issues/95) | Feature proposal | Static tool/trust inventory |
