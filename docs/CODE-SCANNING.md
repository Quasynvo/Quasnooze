# Code-scanning findings and repository-policy limits

This records the triage of the three open alerts reported against `main` at
`4dff678554064f808486f4a82c1aa0b24872ab28`. It is a snapshot, not a claim that future
scans will be clean or that the project is vulnerability-free.

## Source findings addressed in this change

| Alert | Finding | Change | Regression coverage |
|---|---|---|---|
| [56](https://github.com/Quasynvo/Quasnooze/security/code-scanning/56) | `js/trivial-conditional` in Telegram reply formatting | The header-shrinking loop always truncates, so it now appends the ellipsis directly instead of assigning `true` and immediately testing it. The initial, conditional ellipsis remains necessary. | Exact 400-character serialized boundary; one character over; valid JSON escaping for quotes, backslashes and control characters; supplementary Unicode; unchanged incoming body. |
| [55](https://github.com/Quasynvo/Quasnooze/security/code-scanning/55) | `js/unused-local-variable`: unused `readJson` helper in exports | Remove the unused helper. Actual store loading and telemetry parsing remain unchanged. | Existing export/corrupt-session tests plus malformed telemetry lines, preserved valid records, missing optional telemetry and default telemetry exclusion. |

These are CodeQL correctness/maintainability findings, not confirmed exploitable
vulnerabilities. The changes preserve intended behavior; the new tests pin that
behavior rather than claim to reproduce an exploit. No query is disabled and no
alert is manually dismissed. A successful PR analysis validates the proposed
source revision; default-branch alert closure requires merge and a subsequent
`main` analysis.

## Alert 1: branch protection — independent-review rollout

[OpenSSF Scorecard's Branch-Protection finding](https://github.com/Quasynvo/Quasnooze/security/code-scanning/1)
is a repository-governance finding, not a JavaScript defect. It cannot be resolved
by changing application code or dismissing the alert.

### Owner-approved policy, 2026-11-02

The owner superseded the earlier decision to defer stricter governance, selected
`@kaitoayohama1` as an independent reviewer, explicitly approved granting Write
access, and approved the one-reviewer policy below. GitHub confirmed that access
change. `@RANJITHROSAN17` remains the administrator; no other collaborator's access
was changed.

The accompanying repository-settings rollout is intended to enforce:

- One required independent approving review, including code-owner review once
  this CODEOWNERS file is merged to the base branch.
- Stale-review dismissal and approval of the most recent reviewable push in both
  classic protection and the existing ruleset.
- Classic administrator enforcement for `main`.
- Existing up-to-date, required `test (22)`, `test (24)`, `test (26)` and `smoke`
  checks, with their existing GitHub Actions app binding, unchanged.
- Existing prohibitions on force push and branch deletion unchanged.

`.github/CODEOWNERS` names both verified eligible owners. This permits reciprocal
review: the maintainer can review the independent reviewer's work, and the reviewer
can review the maintainer's work. An author cannot approve their own PR; neither
an approval by the last pusher nor a stale approval satisfies the new policy.
The owner accepted that reviewer availability is now required to merge.

### Bypass review and remaining limits

The existing `merge` ruleset targets **all branches**, not only `main`. It contains
Write/Maintain/Admin role bypasses plus deploy-key and application bypass entries.
The authenticated inventory returned no deploy keys and no organisation app
installations. These unused-looking entries are not evidence of an active app's
identity or future requirements. They are retained in this narrowly approved
rollout: deleting role bypasses from the all-branch ruleset could also block ordinary
feature-branch pushes. No broad ruleset scope or bypass change is hidden in this PR.

Classic protection independently enforces the new review requirements on `main`,
including administrators. A ruleset bypass is not an exception to an independently
applicable classic protection rule. Nonetheless Scorecard can still penalise the
presence of ruleset bypass actors, and the one-reviewer policy is deliberately not
the maximum two-reviewer tier. A future main/release-specific ruleset and individually
approved exception cleanup require a separate scope/automation review.

### Verification and closure

This source PR supplies CODEOWNERS but does not merge it. GitHub evaluates code
owners from the PR's **base branch**, so existing PRs do not gain automatic code-owner
coverage merely because this file exists on an unmerged branch. Request the named
reviewer explicitly during this rollout.

After applying settings, reread the actual protections, required checks, ruleset
and reviewer permission; verify GitHub reports no CODEOWNERS syntax errors on the
proposed branch; request an independent review; and run the Security workflow on
`main`. Required approval is an expected blocker, not a reason to bypass or weaken
the policy. This change does not merge any PR, remove protections, alter Scorecard
thresholds, suppress rules or dismiss alerts. Do not call alert #1 fixed until a
fresh default-branch analysis actually reports that result. CODEOWNERS coverage
requires review and merge, followed by another default-branch scan.
