# Fluid Motion identity — validation record

**Date:** 2026-11-03. **Base revision inspected:** `c33bd55e04744e010d4584e29a9f6f1219984e72`.
**Environment:** Linux sandbox, Node.js 22.23.4, Python 3.13, Pillow and Chromium via Playwright.

This record describes checks run on the supplied refactor. It is not a claim that changes were pushed, merged, published to npm or deployed to GitHub Pages.

## Automated checks

| Check | Result | Boundary |
|---|---|---|
| Baseline `node --test --test-concurrency=4` | 554 passed before edits | Existing repository behavior |
| Revised `node --test --test-concurrency=4` | 571 passed | Includes 20 new motion/audio/asset tests and removed obsolete character-art tests |
| `node scripts/audit.js` | 16 passed | Existing local security guardrails |
| `node scripts/validate-roadmap.js` | Passed | Roadmap structure; not a product feature test |
| Visualizer browser script | 11 scenarios passed | Chromium synthetic audio device, mocked denial and unavailable Canvas 2D |
| Voice conversation browser script | 12 scenarios passed | Disposable mocked API/SSE fixture |
| Command deck / advanced history script | 2 scenarios passed | Mocked API; no native host |
| Static website browser script | 17 checks passed | Nine viewport widths, five states, reduced motion, FAQ/copy behavior and no external/API requests |
| Asset rebuild | Passed | Deterministic SVG, PNG and five-state GIF; shared static-site engine copies synchronized |

The revised suite count is not a performance measurement. Browser checks cover browser behavior, not universal device support.

## What the motion/browser checks establish

- All five canonical states have distinct geometry and state labels.
- State buttons expose pressed semantics and work with the keyboard.
- Default previews do not call `getUserMedia`, a model or a tool.
- Reduced motion stops continuous RAF and produces a pixel-stable canvas between unchanged states.
- Explicit microphone activation runs the real Web Audio graph against Chromium's synthetic input.
- Mute, page hide and page exit end the test media tracks.
- Permission denial produces an actionable message and leaves state controls usable.
- Missing Canvas 2D support retains the SVG fallback and usable controls.
- The playground makes no external or backend API requests.
- 320 px and 390 px playground layouts have no horizontal overflow; the product website was checked at nine widths.
- Existing conversation approval/denial, safe text rendering, interrupted-stream messaging and authentication behavior still pass.

Unit checks additionally cover signal normalization/expiry, native scalar semantics, aborting a pending capture, late-stream cleanup, resume failure, device-ended invalidation, renderer disposal and visibility/intersection pauses.

## Updated visual evidence

- [`assets/banner.png`](../../assets/banner.png): static README banner.
- [`assets/quasnooze-showcase.gif`](../../assets/quasnooze-showcase.gif): silent five-state walkthrough, approximately 1.3 MB.
- [`../images/cosmic-conversation.png`](../images/cosmic-conversation.png): refreshed browser conversation screenshot in explicit scripted mode.
- [`../images/command-deck.png`](../images/command-deck.png): refreshed command-deck screenshot with a mocked API and no native host.

The README GIF uses the same signature/palette and ribbon equations as the canvas engine. It is generated artwork, not a recording of live audio or inference. The screenshots do not demonstrate physical microphone accuracy, speech quality, model speed or Windows hardware behavior.

## Not validated here

- Physical microphone input, speakers, acoustic echo, accents or noisy-room recognition.
- Real Windows System.Speech execution, wake grammar, hotkeys, audio-device switching or login startup.
- Compilation of the modified native C# source on Windows; the supplied Windows CI job must compile it before merge.
- OS screen-reader behavior, every browser/engine, low-end mobile GPU/CPU performance or 200%-zoom acceptance across all surfaces.
- True output-frequency analysis for native TTS. The current native speaking spectrum is explicitly decorative.
- Trademark clearance, npm package availability, upstream merge or production deployment.

## Reproduce

```sh
node --test --test-concurrency=4
node scripts/audit.js
node scripts/validate-roadmap.js
python3 scripts/build-brand-assets.py
```

Optional browser checks require Python Playwright and Chromium. The conversation and panel scripts create their own disposable fixture servers. For the static website script, serve `site/` on port 8891 or set `QUASNOOZE_SITE_BASE`.

```sh
python3 scripts/test-visualizer-browser.py
python3 scripts/test-cosmic-browser.py
python3 scripts/test-panel-browser.py
python3 scripts/test-brand-browser.py
```

Before merging, run the Windows compile/self-test job and a consented hardware/accessibility acceptance pass. Do not convert the synthetic-device results into a physical-hardware claim.
