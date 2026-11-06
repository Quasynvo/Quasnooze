# Local scoped memory

Memory is local to this installation's single owner; scopes organize that owner's facts, not accounts or access-control boundaries between people. Protect the server with `PINCH_KEY` and network restrictions. Anyone with the server's owner access can read or edit every scope and export all memory. There is no sharing, synchronization, embedding service or new network request.

By default the assistant sees only `user` memory. To opt into a project, set `QUASNOOZE_MEMORY_SCOPE=project:my-project` in the trusted local environment or .env and restart. Project names use lowercase letters, digits, `_` and `-` (up to 64 characters). Only that exact scope is used by prompts and remember/recall/forget; user facts are not automatically included. Model output and chat messages cannot choose a scope. Switching model does not change scope. This is organization for a single owner, not a security boundary against a model with other filesystem tools or an operator with owner access.

The existing owner-authenticated `/api/memory` supports `GET ?scope=project:my-project` and JSON POST bodies:

- `{"scope":"project:my-project","fact":"Deploy on Monday","tag":"project","source":"meeting notes"}`
- `{"scope":"project:my-project","correct":{"id":"<active fact id>","fact":"Deploy on Tuesday","source":"owner correction"}}`
- `{"scope":"project:my-project","forget":"Deploy on Monday"}`

Omit `scope` for the configured scope, and omit `source` if unknown. Corrections require the exact active ID returned by GET, create a new record and mark the old record superseded. Recall excludes superseded records, and a sourced recall cites the supplied source and saved time as a claim, not proof. Forgetting any revision deletes its complete correction chain in that scope, including active and stale copies. An empty query deletes nothing. Invalid individual records are retained but not recalled; malformed whole files and unsupported versions are not overwritten. The owner export contains all scopes and history, including malformed records, so treat it as sensitive.

## Migration, rollback, and deletion

Existing unversioned facts are interpreted in `user` scope. On the first change, the original `memory.json` is copied once to `memory.json.v1.bak` before the version 2 file is atomically written; existing backups are not overwritten. For rollback, stop Quasnooze, save a separate copy of the current version 2 file if needed, then replace `memory.json` with the backup and restart the older application. Rollback loses edits made after that backup. On upgrading again, explicitly archive or remove the old backup first if you want a fresh rollback copy.

The backup and any exports are **not active memory** and are not modified by forget; they may still contain deleted facts. Delete or securely manage these owner-controlled copies separately, including filesystem snapshots and backups. Removing an active fact does not erase conversations, logs, exports, or files in which it was separately recorded. Stop the application before restoring files so its in-process cache is refreshed on restart.
