# Read-only retention preview

`quasnooze retention-plan` inventories **file metadata only** under the same
configured data directory that runtime uses (including `PINCH_DATA` /
`QUASNOOZE_DATA` overrides and the shared packaged-install resolver).
It never deletes, writes, saves policy, starts a scheduler, loads record content,
or calls a service. Existing `deleteSession()` and telemetry rotation are
unchanged and are not invoked by this command.

```sh
quasnooze retention-plan
quasnooze retention-plan --json
quasnooze retention-plan --sessions-days 90 --telemetry-days 30 --json
```

All policies default **off** on every invocation. The optional `--CATEGORY-days N`
flags (`sessions`, `memory`, `reminders`, `schedules`, `telemetry`) accept positive
whole days from 1 to 36500; they simulate thresholds for this report only. There
is deliberately no `--delete`, `--apply`, saved policy, purge or scheduling flag.
Output goes only to stdout; redirecting it is an explicit shell operation, not an
implicit report file. Errors use generic reasons, not filesystem error messages,
paths or file contents. The command's normal config loader can load the existing
private `.env` as usual to obtain configured paths; no credentials enter the
inventory or output.

## What the categories mean

| Category | Recognized files | Candidate eligibility when policy is enabled |
| --- | --- | --- |
| Sessions | Direct, regular `sessions/<valid-session-id>.json` files | Modification time at least N days old |
| Memory | `memory.json` | Always excluded: shared record store |
| Reminders | `reminders.json` | Always excluded: shared record store |
| Schedules | `schedules.json` | Always excluded: shared record store |
| Telemetry | `telemetry.ndjson`, `.1`, `.2`, `.3` | Old rotated archives only; active log always excluded |

**Counts are files, not records.** In particular, one old `reminders.json` is not
evidence that its reminders are completed/expired. Reading it to decide would
expose record content and go beyond this metadata-only feature. For shared
stores, an explicit policy shows age-eligible file counts but never proposes the
whole store as a candidate. Empty or malformed JSON is still just a regular
file; its content is not opened or validated. Modification time is a heuristic,
not last conversation activity, record age, obligation to erase, or proof that
something is safe to delete.

Each category reports `policy`, `observedFiles`, `approximateBytes`,
`ageEligibleFiles`, `candidateFiles`, `candidateApproximateBytes`, and counted
`exclusions`. Sizes are logical lengths, not allocated/reclaimable disk blocks.
Hard-linked files can be counted more than once. Future/unknown modification
times are excluded from candidates. The age clock is injectable in the module;
the CLI uses the current time. Nothing in the report is an executable deletion
manifest: no filenames, session IDs, targets, credentials or message text are
included.

Profiles, credentials, tasks, personas, attachments, screenshots, diagnostic state,
backups, unrecognized telemetry rotations and other files are **out of scope**, not
implicitly disposable. Unknown names count only as `outside-inventory`; their
metadata/content is not inspected. Explicit external profile/tool paths are not
visited. No directory is recursively explored: only the root and direct session
entries are inventoried. Symlinks and nonregular files are excluded.

## Bounds, filesystem safety and limitations

The default budget is **2,000 directory entries and 1,000 ms**, across both levels.
Module callers may choose smaller limits (hard ceilings: 10,000 entries / 5,000
ms). Directory entries are streamed rather than loading an unbounded listing.
The time budget is checked between operations: a blocked OS/filesystem syscall
cannot be interrupted by this synchronous preview. Counts are lower bounds when
truncated; there is no attempt to extrapolate an entire directory from a sample.
The report is non-atomic: writers, permission changes and file replacement may
make observations stale even during the scan.

Traversal is anchored to open directory descriptors with no-follow directory
opens, using Linux `/proc/self/fd` or, where supported, macOS `/dev/fd`. Parent
replacement therefore cannot redirect a scan into an unrelated directory. The
configured root itself must not be a symlink. No file descriptor is opened for
contents; only directory handles, directory entries and `lstat` metadata are used.
No external data symlink is followed. The OS may update directory access times as
a consequence of enumeration; "read-only" means **zero application filesystem
mutations**, not a promise to freeze access-time accounting or concurrent writers.

**Windows and systems without safe descriptor traversal fail closed.** They
report unavailable, rather than falling back to a path walk with a replacement/
symlink race. This version does not claim native Windows inventory support.
On macOS, unavailable descriptor-directory enumeration is reported as partial;
actual native behavior has not been validated in this Linux sandbox. There is
no hidden fallback to content-reading store loaders or a cloud service.

`status` is `complete`, `partial`, `missing` or `unavailable`. Missing data is not
created. Partial/unavailable reports cause CLI exit code 1, so automation cannot
mistake incomplete zero counts for an empty store. Complete and missing reports
exit 0; excluded files are still reported in counts/reasons. Reports expose their
bounds and truncation flag; an exactly exhausted budget conservatively marks the
report partial even if the final observed entry might have been the last entry.

## Verification boundary

Synthetic Linux fixtures verify category separation, off defaults, injected-clock
age boundaries, protected aggregates, no content/credential leakage, missing roots,
permission errors, bounds, symlinks, root replacement, CLI path overrides and zero
application mutations. Before/after snapshots compare file bytes, names, modes,
sizes, modification and change timestamps. An injected filesystem adapter rejects
all content-read and mutating operations. OS access times are deliberately not
claimed unchanged.

Independent maintainer review remains required. No physical Windows/macOS,
hardware, user acceptance or manually consented personal-data checks were
performed. A future deletion mechanism would need its own review, explicit
confirmation and safety contract; this preview is not authorization for it.
