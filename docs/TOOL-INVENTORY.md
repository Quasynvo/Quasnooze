# Static Tool Capability and Trust Inventory

`quasnooze tools` (`npm run tools`, `node src/cli.js tools`, or `/tools` inside `quasnooze chat`) produces a **read-only, execution-free** inventory of Quasnooze's four tool mechanisms and their approval/trust models.

```sh
quasnooze tools            # concise human-readable inventory
quasnooze tools --json     # machine-readable JSON report (schemaVersion: 1)
quasnooze tools --strict   # exit 1 if any configured source is rejected, partial or unavailable
```

## Why this exists

Quasnooze supports four distinct ways a model can call tools, and their trust models are deliberately different:

| Source | Configured via | Trust model | Default approval policy | Unattended scheduled runs | Static inventory state |
|---|---|---|---|---|---|
| **Built-in tools** (`src/tools.js`) | Always present | Shipped in-process code | `dangerous: true` tools ask (`shell` allows classified workspace reads when `QUASNOOZE_RISK_TIERS=true`); others run without prompt | `dangerous: true` refused (plus `schedule` creation) | `enabled` (`inspected: true`) |
| **Custom JSON manifest** (`src/custom-tools.js`) | `QUASNOOZE_TOOLS` | Declarative argv binary (`shell: false`, scrubbed `childEnv()`) | Always `approval-required` (`trusted` opt-out unsupported) | Always `refused` | `disabled`, `inspected`, `partial`, `unavailable` or `rejected` |
| **Local JS plugins** (`src/tools.js`) | `QUASNOOZE_TOOLS_DIR` | Arbitrary in-process Node.js ESM module | `approval-required` unless module exports literal `trusted: true` (and not `dangerous: true`) | Refused unless `trusted: true` | `disabled`, `uninspected`, `partial`, `unavailable` or `rejected` |
| **MCP stdio servers** (`src/mcp.js`) | `QUASNOOZE_MCP` / `QUASNOOZE_MCP_TRUSTED` | External child process speaking JSON-RPC over stdio | `approval-required` unless server name is listed in `QUASNOOZE_MCP_TRUSTED` | Refused unless listed in `QUASNOOZE_MCP_TRUSTED` | `disabled`, `uninspected`, `partial` or `rejected` |

Without a static inventory, inspecting `QUASNOOZE_TOOLS_DIR` or `QUASNOOZE_MCP` through normal startup would execute top-level plugin code or spawn MCP child processes before you could review what was configured.

## What `quasnooze tools` never does

- **Never imports `.js` / `.mjs` plugin modules.** Module top-level code in `QUASNOOZE_TOOLS_DIR` is never evaluated, and plugin file contents are not read. Dynamic module exports (`toolName`, `parameters`, `declaredTrust`) remain `"unknown"` until loaded through normal startup.
- **Never executes manifest commands or probes `PATH`.** Manifest JSON in `QUASNOOZE_TOOLS` is validated structurally (`<= 64 KiB`, `<= 32` tools, `<= 32` string arguments), but binaries are neither searched on `PATH` nor spawned (`executableVerified: false`).
- **Never spawns MCP servers or sends JSON-RPC requests.** Configured servers in `QUASNOOZE_MCP` are parsed statically (`<= 32` servers); remote tool lists and schemas remain `"unknown"` (`toolCount: null`).
- **Never creates or mutates files or directories**, including when `QUASNOOZE_DATA` does not yet exist.
- **Never makes network requests.**

## Bounded reads, symlink/traversal refusal, and redaction

- **Bounds:** Custom manifest reads are capped at `65,536` bytes (`64 KiB`) and `32` tools; plugin directory scans stop after `64` directory entries; MCP server inspection stops after `32` servers; sanitized text fields are capped at `200` characters.
- **Traversal and symlink refusal:** Configured paths containing `..` segments, protected credential directories (such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`), direct symlinks, or ancestor-directory symlinks are rejected (`O_NOFOLLOW` descriptor checks plus canonical path verification). Plugin directories and manifest command paths resolving inside `QUASNOOZE_WORKSPACE` are rejected.
- **Redaction:** Configured filesystem paths, home/user paths (`~`, `$HOME`, `/home/...`, `/Users/...`, `C:\Users\...`), raw `args` vectors, MCP `env` maps, credential-shaped JSON keys (`apiKey`, `token`, `secret`, `password`, `headers`, `env`, etc.), inline bearer/token strings, and control/bidi characters are withheld or replaced with `[REDACTED]` / `[REDACTED_PATH]`.

## What this does not claim

- **Configured or listed does not mean safe, verified, trusted, or sandboxed.** Every source reports `sandboxed: false` and top-level `osSandboxed: false`.
- **Workspace path confinement applies only to built-in workspace file tools** (`read_file`, `write_file`, `list_dir`, `grep`, `scan_project`, `search_documents`). Approved `shell` commands, custom manifest binaries, local JS plugins, and MCP servers run with your OS user account's permissions.
- **Normal startup still executes `QUASNOOZE_TOOLS_DIR` module initialization** before any tool-call approval prompt when you run `quasnooze`, `quasnooze chat`, `quasnooze ask`, or `quasnooze desktop`. Leave `QUASNOOZE_TOOLS_DIR` unset unless you have reviewed every file in that directory.
- **Concurrent local processes are out of scope.** Descriptor and canonical-path checks guard against accidental symlinks and static misconfiguration, not a privileged or concurrent local attacker mutating directories on the same OS account.
