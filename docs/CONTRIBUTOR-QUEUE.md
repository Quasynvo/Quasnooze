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
- At most four curated issues and three easy issues are open under current caps.
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
