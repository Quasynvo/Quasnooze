# Quasnooze by Quasynvo — brand and compatibility

**Product:** Quasnooze. **Organization:** Quasynvo. **Tagline:** Intelligence, in your orbit.
Repository: https://github.com/Quasynvo/Quasnooze

The maintainer selected the cosmic sloth for the assistant and the orbital Q for
its organization. This change applies the identity across current documentation,
README visuals, landing page, command deck, conversation pages, launch/setup text,
native UI, package metadata and active repository links. It does not publish npm,
change repository protection, migrate personal data or merge itself.

## Upgrading an existing checkout

1. Back up `.env` and `data/` **privately**. Never commit or upload secrets.
2. Update your remote if needed: `git remote set-url origin https://github.com/Quasynvo/Quasnooze.git`.
3. Update through the normal reviewed branch/release process. Existing files stay
   in place; run `npm run doctor` before changing configuration.
4. Use `node bin/quasnooze.js help` from a checkout. `bin/pinch.js` and the `pinch`
   npm executable remain working aliases; existing launchers need not be rewritten.
5. On Windows the displayed wake phrase becomes **Hey Quasnooze**. It still needs
   explicit microphone consent and starts muted. The new phrase/recognizer behavior
   needs actual Windows speech-pack/hardware acceptance; it is not benchmarked here.
   Old “Hey Pinch” is no longer an advertised/registered native wake grammar.

## Configuration precedence

New configuration uses `QUASNOOZE_*`; every corresponding `PINCH_*` name remains
accepted. The alias normalizer acts separately on `.env` and real environment:

1. Real process environment wins over `.env`, even when its spelling is legacy.
2. Within one layer, an explicitly present `QUASNOOZE_*` value wins over `PINCH_*`,
   including an empty value. Avoid configuring conflicting spellings.
3. The Windows resident flag must be **exactly `1` in the process environment**
   on Windows. Neither legacy nor new `.env` assignment enables native residency.
   The launcher sets it explicitly. Resident safety overrides remain unchanged.
4. Setup reads existing legacy values but writes preferred names. No automatic
   `.env` rewrite or state relocation occurs merely by starting the app.

Examples: `QUASNOOZE_DATA`, `QUASNOOZE_WORKSPACE`, `QUASNOOZE_KEY`,
`QUASNOOZE_PORT`, `QUASNOOZE_HOST`, `QUASNOOZE_MCP`, `QUASNOOZE_TOOLS`.
See [`.env.example`](../.env.example) for active options and legacy aliases.

## Intentional compatibility identifiers

A blanket string replacement would break installations and issue automation.
The following internal/legacy names are intentionally retained:

- Historical `pinch-…` roadmap IDs and hidden issue markers: changing them would
  re-file already completed work. Old issue URLs/commit snapshots remain evidence.
- The legacy `pinch` command, `bin/pinch.js` wrapper and `createPinchServer` factory alias.
- `PINCH_*` option aliases, existing browser storage/session keys, and the
  `pinch_key` static-asset cookie. They do not bypass authentication.
- `x-pinch-key` / `x-pinch-session` HTTP headers remain accepted; current clients
  use `x-quasnooze-key` / `x-quasnooze-session`. Cross-origin restrictions remain.
- Existing service identifiers (`pinch.service`, `com.pinch.assistant`) and the
  Startup `Pinch.lnk` filename avoid duplicate resident launches. Their visible
  product labels are Quasnooze. No service is installed/enabled by the rebrand.
- The version-1 `pinch-export/1` schema identifier, existing session IDs and all
  personal-state paths remain stable. New exports identify the generator as
  Quasnooze. Restore is still a separately gated feature.
- Historical research/proposal files preserve their original product names,
  review dates, source citations and test results. They are not current release claims.
- Contributor identity, copyright/license text and unrelated projects are not renamed.

## Visuals and motion

The selected AI-generated organization logo is reused—not replaced with a new
concept. Raster crops/size variants and SVG containers of that raster provide
README, favicons and app marks. They are not claimed to be hand-traced vectors.
The supplied sloth remains the companion. The README GIF is a labelled illustrative
state walkthrough; [its static alternative](../assets/banner.png) avoids animation.

The landing page has responsive layout, animated orbit/presence, interactive
capability explanations, copyable checkout steps, FAQ and reduced-motion support.
It is **a static product explanation**, not a hosted personal assistant. It does
not call the AI, capture a microphone, install anything or manufacture live status.
GitHub Pages publishing still requires the normal reviewed deployment workflow;
new canonical URLs are configured but deployment is not asserted by this commit.

## Package and rollout

Metadata uses **`@quasynvo/quasnooze`** and exposes `quasnooze` plus the legacy alias.
The scope/package registration, release availability and npm ownership are **not
verified**. No publication occurred. Use the documented Git checkout until a
maintainer publishes and verifies a release. Optional channel dependencies remain
optional; no visual framework/CDN/runtime dependency was added.

The root app remains the resident command deck; `/cosmic.html` is the face-to-face
conversation and `/index.html` retains advanced history/attachments. New navigation
connects them. No working feature is removed just to force the new look.

## Reproducing visual assets and browser checks

The exact selected original is [`assets/quasynvo-logo-source.png`](../assets/quasynvo-logo-source.png).
Optimized crops are derived from it; the generator does not generate/redesign a logo.

On a Linux developer machine with Python 3, Pillow and DejaVu Sans installed:

```sh
python3 scripts/build-brand-assets.py
```

The website and panel checks additionally need Python Playwright and Chromium,
**developer-only**, not installed into the assistant's runtime dependencies.
Serve `site/` locally on port 8891 (or set `QUASNOOZE_SITE_BASE`), then run:

```sh
python3 scripts/test-brand-browser.py
python3 scripts/test-panel-browser.py
python3 scripts/test-cosmic-browser.py
```

The tests report temporary screenshot/result paths. The site test exercises nine
viewport widths, illustrated state/category controls, reduced motion, FAQ,
copy feedback and no unexpected network calls. The other scripts use disposable
mocked API fixtures. Their screenshots are illustrations of the UI wiring,
**not live native-hardware, audio, model-quality or performance evidence**.
