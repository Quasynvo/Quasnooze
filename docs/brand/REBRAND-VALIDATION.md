# Full Quasnooze / Quasynvo rebrand — local validation

Date: **2026-11-03** (maintainer timezone). Branch: `feat/full-quasnooze-rebrand`.
Base: `196df43`. This report is for the full rebrand, not the earlier proposal.

## Implemented

- Adopted product/organization names, active repository links, package/CLI/help,
  setup, prompts, docs, workflow display text and native/UI labels.
- Selected orbital-Q logo integrated into current marks/favicons, social image,
  README art and website. Original and deterministic crop/illustration builder included.
- New animated illustrative README header with static alternative, request-flow
  SVG, beginner setup, capability/boundary explanations and three-view navigation.
- Responsive static website: orbit/character motion, explicitly simulated state
  controls, capability categories, FAQ, copyable setup and OS/manual reduced motion.
- Command deck restyled; full history/attachments retained; companion stays optional.
- Canonical command/config/HTTP headers added with compatibility aliases and
  documented precedence. No personal-state migration or service duplication.
- Extracted-package regression covers both CLI launchers and bundled Growth imports;
  the missing runtime queue-helper allowlist entry is included. Published-package
  Growth reports retain the documented ten-task cap when `.github` is absent.

## Executed on this Linux workspace

| Check | Observed result |
|---|---|
| Node.js 22 test suite, concurrency 4 | **517 passed, 0 failed, 0 skipped** |
| `node scripts/audit.js` | **16 probes passed** |
| `node scripts/validate-roadmap.js` | **25 items valid; 4 candidates; per-run cap 3** |
| `npm pack --dry-run --json` | **558,357 compressed bytes, 77 runtime files**, below 1 MB; not published |
| Static website browser script | **17 checks passed**, including 320/360/390/740/768/900/1024/1280/1440px widths |
| Cosmic conversation browser script | **12 scenarios passed**, including mock SSE, explicit approval/denial, interrupted stream, authentication and reduced motion |
| Command deck + advanced history browser script | **2 scenarios passed**; fresh-session mark renders, navigation retained, no JS exceptions |
| `git diff --check` | Passed |

The runtime archive byte count is a local npm-pack observation, not a guaranteed
future registry artifact size. Developer scripts/artwork are outside its allowlist.
The roadmap's per-run cap of three is separate from its ten-open-task board policy;
neither was increased by this rebrand.

New regressions cover new-vs-legacy environment precedence, explicit empty new
values, process-over-file precedence across spellings, process-only Windows
residency and safety overrides, setup rendering, both CLI aliases, both auth/session
header names, wrong/empty canonical auth rejection, upload ownership/isolation,
legacy server-factory identity and extracted-package imports. Genuine unknown
environment reads remain audited; the new helper avoids the scanner's ambiguous
`env.js` filename shape rather than suppressing undocumented-variable checks.

## Evidence boundaries

- Browser screenshots use explicit scripted UI or disposable mocked APIs. They
  are **not** model-quality, speed, live-audio, native-hardware or 3D/VR evidence.
- This Linux session did **not** compile/run the Windows companion, test a physical
  microphone/wake phrase/startup, or complete the Windows accessibility acceptance.
  Existing Windows CI compile/contract jobs are preserved; no remote CI result is claimed.
- The avatar is illustrated 2.5D with illustrative mouth motion, not a 3D model
  or phoneme-timed lipsync. Stop voice is not backend task cancellation.
- No npm publication, package/scope availability verification, trademark clearance,
  GitHub Pages deployment or repository social-preview setting upload was performed.
- No merge, collaborator change, branch-protection change or quota inflation occurred.
- At report time, GitHub push/PR creation was **blocked by missing authentication**.
  The local branch/update pack is ready for maintainer review; the default branch
  has not been changed by this session. The social-preview image is `site/og-image.png`.

Historical names survive only where compatibility, contributor/license attribution
or dated evidence requires them. See [migration rules](../REBRANDING.md).
