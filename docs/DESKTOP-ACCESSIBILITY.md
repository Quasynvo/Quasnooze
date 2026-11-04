# Desktop keyboard and assistive-technology acceptance matrix

Issue #94 · `roadmap:pinch-024-desktop-accessibility-audit` · recorded 2026-11-04.

## Scope and evidence boundary

This evaluates the **existing command deck** (`public/desktop.html` and
`public/desktop.js`), which already used native controls, labels, dialogs and
status regions. It is not a claim that accessibility was previously absent, a
WCAG conformance certification, or the broader five-journey study. It does not
change #86 or advance gated roadmap work ahead of NOW #85–#87.

**Windows keyboard and screen-reader acceptance remains unperformed.** No
consented human, Windows build, physical microphone, Narrator/NVDA/JAWS session,
or independent reviewer was available for this run. Automated keyboard/DOM
results below must not be reported as a screen-reader or native-host pass.

## Repeatable checks

Dependency-free regressions (included in the normal Node suite):

```sh
node --test test/desktop-ui.test.js
node --test --test-concurrency=4
node scripts/audit.js
node scripts/validate-roadmap.js
```

The optional real-browser checker serves the actual static files on a temporary
loopback port and intercepts **all API requests with synthetic responses**. It
requires no running Quasnooze service, native companion, model or cloud service.
It blocks page requests to other origins and closes its browser/server on exit.
Install Playwright and its Chromium browser as **external developer tooling**,
not production dependencies. For example, with an external tooling directory:

```sh
npm install --prefix /path/to/a11y-tools playwright
/path/to/a11y-tools/node_modules/.bin/playwright install chromium
NODE_PATH=/path/to/a11y-tools/node_modules node scripts/check-desktop-accessibility.cjs
```

PowerShell users can set `$env:NODE_PATH` before invoking Node. Alternatively,
`playwright-core` with `QUASNOOZE_CHROMIUM_EXECUTABLE` pointing at a compatible
installed Chromium is supported. Installation may need browser/system libraries;
the repository does not install them or introduce a runtime/browser dependency.
This headless developer fixture disables the browser sandbox for container
compatibility; do not adapt it to browse untrusted content.

### Observed automated environment

Linux x64, kernel `6.1.158+`; Node `v22.22.3`; `playwright-core` `1.64.1`;
headless Chromium `153.0.8010.0` (developer-only `@sparticuz/chromium` `153.0.0`).
Viewport 1280 × 1000, reduced motion requested. Synthetic API; no native host,
Ollama, browser audio or physical microphone. Assistive technology: **not run**.
The script emits JSON with its actual environment, scenarios and limitations.

### Recorded validation results

- `node --test test/desktop-ui.test.js`: 11 passed, 0 failed.
- `node --test --test-concurrency=4`: 669 passed, 0 failed/skipped/cancelled;
  duration 25390.392199 ms.
- `node scripts/audit.js`: 16 passed.
- `node scripts/validate-roadmap.js`: OK, 53 items, 4 filing candidates, cap 3;
  existing contributor-label warnings remain (no roadmap changes).
- Optional Chromium checker: 9 scenarios passed; no page errors.
- `git diff --check`: passed.
- Independent review, physical Windows/microphone and screen-reader checks:
  **unperformed**, not implied by any result above.

## Acceptance matrix

“Browser pass” means observed keyboard/DOM behavior in the environment above.
The Node double checks state/event logic, not native dialog focus or spoken output.
Every Windows/AT row remains **manual unperformed** until observations are recorded.

| Area / actual controls | Repeatable steps and acceptance | Evidence now | Windows / AT |
| --- | --- | --- | --- |
| Navigation and command input | Tab reaches Overview, Cosmic, Activity and Settings in document order. Focus command input; a visible outline is present. No positive tabindex or new global mic shortcut. | Browser pass; Node markup hook regression | Unperformed: full-page forward/reverse order, zoom/high contrast and focus visibility |
| Native help dialog | Keyboard-activate native-help button. Dialog has name “Your Windows voice host” and description; initial focus is close button. Tab stays in modal interaction; Escape closes and returns to opener. | Browser pass, including wrap; Node name/description hook regression | Unperformed: spoken name/description, close button, native modal announcement |
| Model dialog | Space opens model button; focus enters model select, then Save and Refresh. Escape returns to opener without model-save POST. | Browser pass; Node hooks | Unperformed: read select options/status, reverse Tab, Save/Close focus and spoken feedback |
| Key dialog | Synthetic 401 opens “Connect securely”; focus enters password input. Escape returns to original command focus without connecting. | Browser pass; Node hooks | Unperformed: secure input announcement, Connect/Close feedback and repeated auth failure |
| Permission arrival/status | Inject pending exact-ID request while typing. Named region and visible polite permission status appear without stealing command focus. Description remains text, not executable markup. | Browser pass; Node no-focus-theft/unchanged-live-text checks | Unperformed: useful timely announcement, verbosity, discoverability and action preview reading |
| Deny and Escape | Tab through inline Allow once / Deny. Escape **inside** permission controls sends deny for current ID, hides resolved request and restores command focus; Escape elsewhere does not deny. Space on Deny does likewise. An open modal prevents the inline Escape action. | Browser pass; Node scoped Escape/modal/disabled-control regressions | Unperformed: AT browse/forms modes, no accidental denial outside the region |
| Allow once / changing requests | Explicit Enter activates Allow once with exact ID. Disable both controls in flight; suppress duplicate submission; never replay a decision onto a replacement ID. Background changes must not steal typing focus. | Browser pass for activation/focus; Node in-flight/replacement-ID regression | Unperformed: changed action announcement, double activation and failure recovery |
| Mic state and permission boundary | No navigation, dialog, approval or Escape step sends listen/mute. Only explicit Talk Enter / Mute Space do so. Synthetic ON/OFF/UNKNOWN labels agree; unavailable Talk disabled. | Browser pass; Node UNKNOWN-label regression. **No microphone activated.** | Unperformed: native consent prompt, tray, real release, wake mode, hotkey safety and state announcements |
| Connection failure | Lost connection disables approval controls; permission status says unknown, never implicitly grants permission. | Node regression; synthetic 401 dialog browser check | Unperformed: reconnect/error announcements, real service/native-host failure |

Native `<dialog>` owns modal focus behavior; no custom focus trap was added.
Chromium may cross the browser-chrome Tab boundary (BODY in headless DOM) before
wrapping. The checker advances one more Tab in that case and verifies focus is
inside the modal, not another page control. This does not establish behavior in
other browsers, Windows chrome, or assistive-technology virtual cursors.

## Reproduced findings and bounded fixes

Against baseline `c5dc727`, actual Chromium with synthetic API responses showed:

- Help dialog opened but lookup by its visible heading as accessible name failed.
  All three native dialogs now have explicit heading/description associations;
  model/key dialogs have explicit initial input targets.
- Command input's computed outline was `none`. A final input `:focus-visible`
  outline now overrides the earlier composer reset.
- UNKNOWN mic state contradicted “not capturing” / “MIC OFF” elsewhere. UNKNOWN is
  now consistent in the audio label/footer, with a polite mic status region.
- Escape on focused Deny sent no denial and left the request visible. Escape is
  now scoped to the inline permission controls, never global or a mic shortcut.
- During the fix's browser check, disabling the focused approval button moved
  focus to BODY. Exact-request focus tracking now returns focus after resolution
  without stealing it from another control. Single-flight submission also avoids
  overlapping decisions. These are UI safeguards, not changes to server policy.

Permission status has visible live text and unchanged status text is not rewritten
on each poll. Actual announcement timing/quality still needs a screen reader.
No speculative follow-up defect issues were filed. Any further defect must include
reproduction steps and actual observations; unperformed checks are not defects.

## Consented Windows / screen-reader session (not yet performed)

Use a disposable local profile and synthetic, non-destructive permission request
first. Obtain explicit participant consent; do not collect personal speech, keys,
files or recordings without separate consent. Do not activate Talk/wake listening
merely to test navigation. Ask separately before the physical microphone test and
stop/mute on request. Approval remains explicit and exact-action; no voice approval
or cloud fallback is introduced. Escape/Stop voice does not cancel an already
running side effect, and uncertain outcomes must be inspected before retrying.

Record **actual**, not expected, results in a copy of this template:

- Date, tester/reviewer and consent scope (no identifying personal data needed): **not run**.
- Commit, Windows edition/build, Node and browser/version: **not run**.
- AT/version (Narrator, NVDA or JAWS), speech/input language, browse/forms mode:
  **not run**.
- Display scale, zoom, contrast theme, keyboard/layout: **not run**.
- Native companion version, microphone/device and permission state (if separately
  consented), local model/provider or synthetic fixture: **not run**.
- For each matrix row: starting state; exact keys; focused control before/after;
  actual visible text; actual spoken announcement/order; action/API/native effect;
  pass/fail/not-run and reproduction notes: **not run**.
- Mic-only steps after consent: verify navigation does not arm capture; explicitly
  Talk and observe native permission prompt, then native ON, Mute and confirmed
  release; inspect UNKNOWN during disconnection without claiming release:
  **not run**.
- Cleanup: mute/quit and verify native release, remove disposable data; independent
  reviewer and follow-up links for reproduced failures: **not run**.

Read headings/status and traverse the entire page forward and backward, not only
scripted controls. Exercise each modal's Escape and explicit Close, approved and
denied synthetic actions, in-flight/replaced requests and service loss/reconnect.
Record skipped steps and why. Independent maintainer review and physical Windows /
AT checks remain outstanding; automated green checks alone do not close that gap.
