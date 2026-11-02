> **Historical proposal/evidence:** this document records the earlier Pinch-era proposal and its own checks. For the adopted Quasnooze / Quasynvo identity and current compatibility rules, see [the rebrand guide](../REBRANDING.md). Historical names, source links and results below are preserved rather than rewritten as new evidence.

# Cosmic conversation concept — validation

Review date: **2026-11-03**. Proposal baseline: `198f4bc` (merged ten-task queue PR).
No live name/organization avatar/package/default-route migration is included.

## Executed

- Full Node 22 suite: **510/510 passed**, zero failures/skips.
- Repository audit: **16/16 passed**. These are existing guard-rail checks, not an
  independent penetration test or performance/security certification.
- Roadmap validator: passed, 25 entries; roadmap contents not edited by this PR.
- Chromium through optional Python Playwright harness: **12 scenarios passed**.
  These use a local HTTP fixture backend, not model inference or real Windows:
  explicitly labelled demo produces no backend request; animation state/input
  locking; dialog/Escape/reduced motion; desktop and 390px mobile overflow;
  unavailable native voice disabled; real browser fetch/SSE/Unicode/safe text;
  explicit deny; explicit allow; interrupted streams; reported native speaking
  and stop-voice control; memory-only key/reconnect; no JS exceptions.
- The browser test exposed an approval-ack/final-response race during development.
  It was corrected: a submitted reply is removed from pending before awaiting
  its acknowledgement, so stream completion does not send a contradictory denial.
  The browser harness covers the fast-final-response case.
- Actual Pinch HTTP regression: opt-in concept, unchanged default deck, local
  CSS/JS/SVG assets and compressed WebP with correct MIME type and <200 KB size.
- Exact-name preliminary screen: combined quoted web search and five GitHub
  repository-name queries found no matches. This is not legal/name clearance.

## Reproduce

```sh
node --test --test-concurrency=4
node scripts/audit.js
node scripts/validate-roadmap.js
```

Optional browser checks (not a new runtime dependency):

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
# Linux browser libraries may also need: python3 -m playwright install-deps chromium
python3 scripts/test-cosmic-browser.py
```

The browser harness uses an ephemeral loopback fixture server, a synthetic key
and synthetic approval events; no model, native process or user account is used.
Screenshots/results are written to the printed temporary directory.

## Explicitly unverified

Physical Windows native speech/listening, actual microphone state and recognizer
latency, audio synchronization, GPU/frame-rate/battery use, model inference,
long-lived concurrency/reconnect recovery, real user accessibility, headset VR,
3D rigging, phoneme/viseme synchronization, domain/handle/trademark availability
and independent image-rights clearance. Screenshot/layout assertions are not
screen-reader usability certification. A reported native speaking state drives
illustrative motion, not an audio-derived waveform.

The first release of a fully rebranded product requires separate acceptance and
maintainer approval. Until then this is an optional illustrated concept page.
