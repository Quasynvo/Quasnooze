# Quasnooze by Quasynvo — identity and compatibility

**Product:** Quasnooze. **Organization:** Quasynvo. **Assistant identity:** Fluid Motion Voice Engine.

The assistant is represented by three phase-offset interference ribbons around a dark glass core—not a character. The organization's orbital Q remains its separate organization mark. The current design, integration contract and accessibility requirements are in [VISUALIZER.md](VISUALIZER.md).

## Scope of this identity refresh

- New README animation, static SVG/PNG alternatives, voice mark and native-widget PNG.
- Shared Canvas 2D renderer in the command deck, voice conversation and static product website.
- A separate, explicitly opt-in microphone analysis playground at `/visualizer.html`.
- Audio/motion-centered feature descriptions and assistant instructions.
- Removal of retired character images, image aliases and character-based metaphors from current product surfaces.

The renderer does not change model routing, approvals, storage, authentication, channel support or native speech recognition. `Companion.cs` and `src/windows-companion.js` remain historical code filenames for the Windows voice host; they are not visual identity modules.

## Upgrading an existing checkout

1. Back up `.env` and `data/` privately. Never commit secrets.
2. Update through the normal reviewed branch/release process.
3. Run `npm run doctor`; no visual setting or audio permission is required for text use.
4. Reload the browser to pick up the new assets. The server sends static assets with `no-cache`.
5. Update any custom integration that directly referenced a retired character image. Those URLs now return 404; use `/brand/voice-engine.svg` for the static mark or mount the canvas component.

The existing `/cosmic.html` URL remains a compatibility route for the **voice conversation** view. Its filename does not designate a separate character experience. `/visualizer.html` is the new standalone motion playground.

## Configuration and data compatibility

New configuration uses `QUASNOOZE_*`; corresponding `PINCH_*` names remain accepted. The normalizer acts separately on `.env` and process environment:

1. Process environment wins over `.env`, even when its spelling is legacy.
2. Within one layer, an explicit `QUASNOOZE_*` value wins over `PINCH_*`, including an empty value.
3. Native residency requires the appropriate process-environment flag on Windows; a file assignment alone does not enable it.
4. Setup reads legacy values and writes preferred names. The identity refresh does not relocate data or rewrite configuration.

The following remain stable:

- `pinch` CLI alias, `bin/pinch.js`, `createPinchServer` and existing service identifiers.
- `PINCH_*` aliases, existing browser storage/session keys and the `pinch_key` asset cookie.
- Accepted `x-pinch-key` / `x-pinch-session` headers alongside current `x-quasnooze-*` headers.
- `pinch-export/1` export schema, session IDs and personal-state paths.
- Contributor attribution, licenses, historical issue IDs and external project names.

There is no new visualizer environment variable, account, npm runtime dependency or cloud audio service. Microphone permission remains a browser/OS decision, not an `.env` switch.

## Assets and publication

Run `python3 scripts/build-brand-assets.py` with Python 3 and Pillow to rebuild deterministic brand assets. The GIF is a **silent state walkthrough**, not recorded AI, speech synthesis or live microphone input. The static alternative is [`assets/banner.svg`](../assets/banner.svg).

The static website copies the shared engine into `site/assets/` during the asset build; edit `public/visualizer.js`, not the generated copy. The website remains a product explanation with synthetic previews. It does not call a model, capture audio or execute tools.

Metadata still uses `@quasynvo/quasnooze`. This refresh does not publish an npm package, deploy GitHub Pages or push to the upstream repository. Use the Git checkout until a release is published and verified.
