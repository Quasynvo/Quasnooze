# Durable local state

Setup and runtime share `src/state-paths.js`. Package assets remain read-only;
configuration and personal data are not tied to a package version or npx cache.

| Install / OS | Default state home |
| --- | --- |
| Git checkout (including worktree `.git` file) | Checkout root, for compatibility |
| Linux packaged install | `$XDG_STATE_HOME/quasnooze`, or `~/.local/state/quasnooze` |
| macOS packaged install | `~/Library/Application Support/quasnooze` |
| Windows packaged install | `%LOCALAPPDATA%\quasnooze`, or `~/AppData/Local/quasnooze` |

The state home contains `.env` and `data/`. Relative XDG/LOCALAPPDATA values are
ignored. Set **process-environment** `QUASNOOZE_STATE_HOME` (legacy
`PINCH_STATE_HOME`) to an absolute path to override the state home, including in
a checkout. Do not put that selector inside `.env`: its location must be known
before loading configuration. Preserve this environment setting in launchers.
Explicit `QUASNOOZE_DATA` / `PINCH_DATA` and profile paths still work, including
existing relative paths (relative to the launcher's working directory). New-brand
aliases take precedence within each layer; process environment wins over files.
There is no new cloud fallback, updater, publication, or approval bypass.

Task 012 (#85) readiness state and latency baselines already use `config.dataDir`;
these inherit the same durable location. No independent baseline store is added.

## Migrating an existing package installation

1. Stop **all** Quasnooze processes, including desktop, supervisors and services.
   Keep them stopped until copying and verification finish. This is an offline
   copy, not a concurrent database snapshot.
2. In the **old installation that still holds the state**, run
   `quasnooze migrate-state`. This prints a preview of locations and top-level
   entries, never file contents or credentials. No state is copied by preview.
3. Inspect that preview. Run `quasnooze migrate-state --apply` from an interactive
   terminal and type `COPY` to confirm that processes are stopped and authorize
   the copy. There is deliberately no noninteractive yes flag.
4. Verify the new location before restarting. A checkout continues using its
   original state unless you explicitly set `QUASNOOZE_STATE_HOME` to the copied
   location. Packaged installs use the platform location automatically.

The destination must not already exist: migration never merges or replaces even
identical files. Source and destination must not overlap. Symlinks and special
files are refused. Originals are **always retained**, including on failures;
ordinary copy failures remove the new destination. If an ACL prevents cleanup,
the error asks for owner intervention and an incomplete marker prevents startup.
Do not simply delete the marker: inspect/remove the failed destination and retry
from the untouched originals. Parent directories created for a destination may
remain empty after a failed attempt. External explicit data/profile locations are
not relocated; their configuration values remain unchanged. Keep old npx cache
state until migration is verified; a cache already removed cannot be recovered.

New directories request mode 0700 and migration/config/profile files request
0600 on POSIX. Existing permissions are not silently changed. On Windows, POSIX
modes do **not** prove ACL isolation: use an owner-controlled profile directory and
inspect inherited ACLs. Network/removable filesystems may lack equivalent
permission or atomicity guarantees. Permission errors fail locally, never trigger
cloud storage or elevation. Native Windows ACL and hardware checks still require
consented manual validation; path simulation is not such validation.

## Uninstall versus deletion

Uninstalling the npm package or clearing npx caches does **not** delete the new
personal state directory. Reinstallation/restarts resolve the same user location.
Intentional personal-data deletion is separate: stop every process, identify the
resolved state home and any explicit external data/profile directories, back up
what you wish to keep, then manually remove only those locations you intend to
purge. Also consider migration originals, `.env.backup-*`, exports and backups.
There is no automatic destructive purge command. Checkout deletion still deletes
checkout-local state; migrate or back it up first.
