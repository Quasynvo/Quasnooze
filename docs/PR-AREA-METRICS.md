# PR area change metrics

The **PR area change metrics** workflow maintains one bot-owned comment on each opened, updated or reopened PR, including fork PRs. It compares the PR head with the merge base of the current base and head, not with the eventual merge result. Existing open PRs can be refreshed by rerunning the workflow from Actions with `pr_number`; after the workflow is merged, normal PR events update the comment automatically. For local inspection:

```sh
node scripts/pr-growth.js <full-base-commit-sha> <full-head-commit-sha>
```

The table groups tracked paths into product runtime (`src`, `bin`, `desktop`), tests and fixtures, documentation, automation and CI, and other. It shows changed paths, tracked non-binary text line counts before and after, net lines, and `(after - before) / before * 100`. The overall row sums the areas. A zero baseline yields `N/A`, not infinity or a fabricated percentage. Binary files, submodules and untracked files do not contribute to line counts; changed paths count renames as a deletion plus an addition. The head and baseline SHAs make results reproducible.

**These percentages measure changes in repository text size, not implementation quality or project growth.** Lines can shrink during a good refactor or grow without adding value. They do not measure functionality, test coverage, security, performance, users, revenue, or completeness. Use independent area-specific measurements and verification to make claims about those outcomes.

The fork-safe `pull_request_target` workflow runs only code from the trusted default branch. It fetches PR Git objects for data-only inspection; it does not check out the PR, run its scripts, install dependencies, or interpolate PR text into shell commands. It checks the head before publishing and updates only comments authored by `github-actions[bot]` with its own marker. No credentials are persisted in the checkout. If a run cannot calculate reliable metrics, it fails rather than posting fabricated numbers.
