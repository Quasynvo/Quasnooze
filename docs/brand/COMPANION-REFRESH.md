# Companion artwork refresh — 2026-11-03

Follow-up to merged PR #98. The approved Quasynvo orbital-Q organization logo is
unchanged. The new AI-generated companion illustration replaces the older sloth
art in the current README and application surfaces.

## Where the new image is used

- README: `assets/quasnooze-showcase.gif`, with a static `assets/banner.png` fallback.
  Orbit tracer, illustrated waveform and labelled states are silent illustration,
  not live microphone/AI/model-performance evidence. The GIF is 133,667 bytes.
- Command deck and cosmic conversation: `/brand/quasnooze-companion.webp`.
- Static website: `site/assets/quasnooze-companion.webp` and regenerated social art.
- Native Windows widget: a 160px PNG portrait beside status/detail text. System.Drawing
  does not natively load WebP, so the widget uses the small PNG derivative. The
  illustration is decorative, has an accessible name and takes no keyboard focus.
  Existing controls, mic consent, approval handling and OS tray logo are unchanged.
- Existing `cosmic-sloth.webp` and `assets/demo.gif` URLs remain compatibility aliases
  containing the new artwork, not the previous image. New primary URLs prevent
  an old cached image from remaining the advertised companion.

The exact new source is `assets/quasnooze-companion-source.png`. The optional
Pillow builder (`scripts/build-brand-assets.py`) now derives all artwork variants,
README animation/static banner and social images from that source. Existing
speaking overlays are aligned to the new image; they remain illustrative, not
phoneme-accurate lipsync. Existing OS/manual reduced-motion behavior is preserved.

## Local verification

- Node.js 22 full suite: **520 passed, 0 failed/skipped**.
- Security audit: **16 probes passed**.
- Runtime npm dry run: **604,275 compressed bytes / 79 files**, below 1 MB; not published.
- Website: **17 checks** including nine viewport widths (320–1440px), controls,
  reduced motion and no unexpected external/API calls.
- Cosmic conversation: **12 mocked browser scenarios**.
- Command deck and advanced chat: **2 mocked browser scenarios**.
- Refreshed README/app screenshots are supplied in the repository. Their API/demo
  state is scripted, not actual hardware, live reasoning or speech evidence.
- New regressions check canonical image references, identical app/site/legacy alias
  bytes, the native PNG dimensions and non-focusable decorative native control.

The Windows widget modification has **not** been compiled or inspected on physical
Windows in this Linux session. Existing Windows CI compilation/contract checks are
preserved and must pass before merge; physical visual/accessibility acceptance
remains pending. No merge, Pages deployment, npm publication, repository protection
change, sensitive-action policy change or automatic microphone activation is part
of this update. Existing installs only pick up the new files after updating the
code through the normal reviewed process and restarting the app.
