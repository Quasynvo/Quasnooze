# Opt-in local support bundle

A personal export contains conversations, profile and memory; it is **not** an
appropriate default support attachment. `quasnooze support-bundle` is a separate,
strictly allowlisted diagnostic artifact. It neither imports personal-data stores
nor alters `quasnooze export`, telemetry rotation or task 012 readiness probes.

```sh
# Exact JSON preview only. No file is created and no network request is made.
quasnooze support-bundle

# Optional inputs must be explicitly selected; nothing is discovered/scanned.
quasnooze support-bundle --snapshot status.json --telemetry /chosen/telemetry.ndjson

# Preview, then type SAVE in an interactive terminal to save those exact bytes.
quasnooze support-bundle --snapshot status.json --out /chosen/support.json --write
```

`--out` alone does not write. `--write` requires a user-chosen destination and an
interactive, case-sensitive `SAVE` after the complete preview is printed. There
is no unattended `--yes`, upload, automatic issue attachment or default output
path. The preview's bytes and SHA-256 are shown; saving does not reload changing
inputs. Existing destinations (including symlinks) are refused using exclusive
creation. Parent folders are not created. New files request POSIX mode 0600;
on Windows, verify the destination's inherited ACLs yourself. A write/fsync error
is reported as failure and may leave a partial **new** file for inspection; it
never removes another pathname in an attempted rollback. Do not share a partial
file as a complete bundle.

Default output is the exact proposed JSON on stdout, with preview information on
stderr. Shell redirection can of course write stdout; that is a separate explicit
shell action, not the bundle's built-in confirmed save. Filenames and destination
paths are never included in the artifact or echoed in generic error messages.
Review the chosen destination argument as well as the preview before saving.

## Fixed allowlist

The bundle includes only:

- The installed app version, Node version, OS family, **numeric** OS version and
  architecture. Version suffixes, hostname, username, locale and raw paths are
  omitted. Unsupported version/architecture values become null.
- Readiness state enums from an explicitly supplied **schema_version 1 doctor
  report**, restricted to the existing task 012 state set. Only overall, text and
  voice states are retained: no hints, errors, models, URLs, owners, paths,
  speech, recent commands or check details. Data is labelled
  `supplied-snapshot-unverified`; a stale or forged snapshot is not a fresh probe.
  Missing, malformed, oversized, unsupported-schema or unreadable snapshots
  report readiness unavailable. A plain `/api/health` response without that
  contract is not silently promoted to readiness evidence.
- Aggregate `ms` and `firstTextMs` from literal `kind: "turn"` telemetry records:
  sample count, mean, p50 and p95. Only finite numeric values between zero and one
  hour are accepted. Strings, negative values, null and out-of-range numbers are
  discarded; no numeric coercion. Percentiles use the existing telemetry-style
  sorted `floor(p * sample_count)` position, capped to the final element. Mean
  is rounded to 0.001 ms. These are observations, not a benchmark or SLO claim.
- Fixed schema/privacy/limit information and bounded input/error counters. No raw
  diagnostic exception is retained.

No prompts, responses, clipboard, audio, memory, profile, credentials, tokens,
session IDs, channel names, model names, endpoints, filenames, telemetry source
records or environment-variable values enter the artifact. This is selection of
known fields, **not** "dump everything and try a secret regex afterward."

Readiness is read, never probed. If you need a doctor snapshot, create one
separately using the existing diagnostics command and its own documented consent/
network behavior (e.g. `node scripts/doctor.js --json`). Raw doctor output can
contain sensitive context: **do not share it instead of the bundle**. The support
command itself never starts doctor, calls a provider, opens a microphone, downloads
a model, reads `.env` or auto-selects a data directory. Snapshot/telemetry files
are read only when explicitly named.

## Bounds and incomplete input

- Snapshot: **64 KiB**; an oversized file is rejected before reading contents.
- Telemetry: **1 MiB prefix**, at most **200 records**, at most **8 KiB per
  record** before JSON parsing. Blank/malformed/oversized/ignored records count
  against the record budget. Truncated final records are discarded, not parsed.
- Input reads use one opened regular-file descriptor for metadata and bounded
  reads, with no-follow/nonblocking flags where available. A sentinel byte can
  be read to detect growth; retained input bytes remain within the stated cap.
  Directories and special files are rejected. Concurrent snapshot changes are
  rejected; changing/truncated telemetry is labelled partial.
- Output: maximum **16 KiB**, including fixed notices. Limits are fixed, not
  configurable via command-line flags. No file contents/errors/paths are echoed
  when an input is missing, malformed or unreadable.

Telemetry is a prefix sample of the selected file, not necessarily the newest
turns or all rotations. `recordLimitReached`, partial-input status and discarded
row counters must be considered alongside timing samples; `inputStatus: complete`
means the bounded file read completed, not that all rows were used. No valid
samples means null means/percentiles, not fabricated zero latency. A completed
preview can exit 0 with unavailable/partial inputs: the artifact explicitly shows
the limitations. Invalid options, refused confirmation or unsuccessful save exit 1.

## Redaction limitations and validation

Allowlisting substantially reduces accidental disclosure but **does not guarantee
anonymity**. Versions, readiness, counts and timings can fingerprint a machine,
workload or activity. A malicious input could encode information in otherwise
valid numeric/state fields; no heuristic can prove every permitted number is
non-sensitive. Only use inputs you trust, inspect the complete preview, and
choose whether/where to share the resulting local file. Saving is not consent
to upload. This feature never sends anything to GitHub or another service.

Synthetic tests use secret canaries in snapshots, telemetry, environment metadata
and injected exceptions. Tests cover malformed/oversized input, row/record/byte
limits, invalid timing numbers, strict output fields, no preview writes/network,
unknown readiness schemas, exact-preview confirmation, destination conflicts,
write failures and noninteractive-save refusal. Personal-export regression tests
remain unchanged. Independent maintainer review remains required. No physical
Windows/macOS, user-acceptance, native UI/ACL or hardware checks were performed or
claimed; CLI save success is exercised through the exact-preview save API, not a
physical interactive terminal session.
