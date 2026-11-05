# Security scanners — what runs, what gates, what is report-first

All scanners run in `.github/workflows/scanners.yml` (plus CodeQL for
actions/C#/Python in `codeql.yml`; JavaScript CodeQL lives in
`security.yml`). Every third-party action is pinned to a commit SHA —
`test/roadmap.test.js` enforces that — and every scanner that produces
SARIF publishes it to the repository Security tab.

| Scanner | Covers | Mode | Why |
|---|---|---|---|
| CodeQL (`security-and-quality`) | JavaScript/TypeScript; actions, C#, Python | **Gating** (existing) | Already shipping; `codeql.yml` adds the non-JS languages without duplicating JS |
| Semgrep 1.184.0 (`p/security-audit`, `p/secrets`) | `src scripts bin public desktop` | **Gating** | Verified locally before landing: 0 findings on the scanned tree |
| Gitleaks 8.30.1 (checksum-verified binary) | Full git history, redacted | **Gating** | Verified locally over 163 commits; the only hits were canary fixtures in two test files, allowlisted by rule+path in `.gitleaks.toml` |
| OSV-Scanner v2.7.0 (checksum-verified binary) | Dependency vulnerabilities (CI-resolved lockfile, 116 packages; none is committed) | Report-first | First report needs triage before it may block merges |
| Trivy v0.76.2 (checksum-verified binary; fs: vuln+secret+misconfig, HIGH/CRITICAL) | Whole tree | Report-first (`--exit-code 0`) | Same reason; SARIF still lands in the Security tab |
| zizmor 1.32.0 (PyPI; the zizmor GitHub Action is refused by the org Actions policy) | The workflow files themselves | **Gating**, one reviewed suppression | `zizmor.yml` suppresses `dangerous-triggers` for `welcome.yml` only — reviewed 2026-11-06: it never checks out PR code (its header documents this) |

## Promotion rule

A report-first scanner becomes gating only in a PR that links its first
triage: findings fixed, or explicitly accepted with a reason in this file.
Never flip a scanner to gating unread — a red X nobody trusts gets ignored,
which is worse than a report everybody reads.

## MCP-specific security tests

`test/mcp-security.test.js` is the adversarial half of the MCP adapter
(the protocol half is `test/mcp.test.js`). It proves, against a real
server process: a server tool named `shell` can never shadow the builtin
(namespaced `mcp__<server>__<tool>`); untrusted tools are `dangerous` and
trust attaches to the exact server name only; server names are sanitised
before becoming tool names; tool output cannot break out of the
`<untrusted-source>` wrapper (closing tags inside output are neutralised —
this test caught and fixed a real escape); and the server process cannot
see our secrets (`childEnv` scrub, canary-verified).

Run them: `node --test test/mcp-security.test.js`
