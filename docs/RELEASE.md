# Releasing Quasnooze

The release gate is the point: a version number is a claim, and claims get
verified (roadmap F01, issue [#202](https://github.com/Quasynvo/Quasnooze/issues/202)).
`.github/workflows/release.yml` refuses to publish a release until the full
suite, the audit probes and the Bench freshness check all pass — the Bench
(`npm run bench:check`) fails the release if any published number in
README.md or docs/RESULTS.md has drifted from what the repo actually measures.

## Checklist (about a minute of decisions, then the gate runs itself)

1. **Numbers are fresh.** `npm run bench` re-measures everything and rewrites
   `test-fixtures/bench/v1/baseline.json`; update any number it flags in
   README.md and docs/RESULTS.md *in the same change*. `npm run bench:check`
   must be green.
2. **The gate is green.** `npm run verify` (tests + audit + bench) and the CI
   matrix on the release commit are green. The README test badge is a bench
   claim — the bench will not let it rot.
3. **The version is honest.** `package.json` `version` matches the tag.
   Breaking change to state files? Bump the migration note in
   `scripts/migrate-state.js` first.
4. **The demo still boots in under a minute.** `npm run demo` → panel on
   `http://localhost:7777` with the mock brain; the release workflow repeats
   this as a smoke test.
5. **Tag and push.** `git tag v1.2.3 && git push origin v1.2.3`. The workflow
   verifies, creates the GitHub release, and publishes to npm only when
   `NPM_TOKEN` is configured in the repository secrets (skipped otherwise —
   a missing token is not a failure).

## What the release notes must keep saying

- the honest limitations that live in README.md and docs/RESULTS.md travel
  with every release: synthetic-text speech numbers (no microphone), mock
  brain in the conversation bench's live tier, physical Windows microphone not
  yet hardware-tested;
- no number appears without its sample size and reproduce command;
- zero runtime dependencies is a release invariant — `npm publish` of a tree
  with a `dependencies` entry fails review.

## First release (v1.0.0)

The first release ships the current package as-is: install (`npx
@quasynvo/quasnooze demo` or clone + `npm run setup`), the web panel, CLI,
channels, voice engine and the permission-first control plane — plus the
skill compiler (`docs/SKILLS.md`) and the Bench (`npm run bench:check`).
