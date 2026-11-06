import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describeBuiltinTools } from "../src/tools.js";
import { inspectManifestData } from "../src/custom-tools.js";
import { inspectMcpConfig } from "../src/mcp.js";
import {
  INVENTORY_LIMITS,
  buildToolInventory,
  redactInventoryText,
  renderToolInventory,
} from "../src/tool-inventory.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "src", "cli.js");
const quasnoozeBin = join(repoRoot, "bin", "quasnooze.js");
const pinchBin = join(repoRoot, "bin", "pinch.js");

function makeSandbox() {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "quasnooze-inv-")));
  const workspace = join(base, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return {
    base,
    workspace,
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function snapshotTree(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = [];
  const walk = (cur, relPrefix) => {
    for (const item of fs.readdirSync(cur, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name;
      const full = join(cur, item.name);
      const st = fs.lstatSync(full);
      entries.push(`${rel}:${st.isSymbolicLink() ? "L" : st.isDirectory() ? "D" : st.size}`);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(full, rel);
    }
  };
  walk(dir, "");
  return entries;
}

test("default static inventory describes built-in capabilities, approval policies, disabled sources, and non-sandbox posture", () => {
  const { workspace, cleanup } = makeSandbox();
  try {
    const report = buildToolInventory({
      env: {
        QUASNOOZE_WORKSPACE: workspace,
        QUASNOOZE_TOOLS: "",
        QUASNOOZE_TOOLS_DIR: "",
        QUASNOOZE_MCP: "",
        QUASNOOZE_MCP_TRUSTED: "",
        QUASNOOZE_AUTO_APPROVE: "false",
        QUASNOOZE_RISK_TIERS: "true",
      },
    });

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.mode, "static-read-only");
    assert.equal(report.status, "ok");
    assert.equal(report.executedAnyCode, false);
    assert.equal(report.spawnedAnyProcess, false);
    assert.equal(report.networkRequests, 0);
    assert.equal(report.osSandboxed, false);

    assert.equal(report.sources.builtin.state, "enabled");
    assert.equal(report.sources.builtin.sandboxed, false);
    assert.equal(report.sources.builtin.total, 30);
    assert.equal(report.sources.builtin.dangerousCount, 8);
    assert.equal(report.sources.builtin.nonDangerousCount, 22);

    const shell = report.sources.builtin.tools.find((t) => t.name === "shell");
    const writeFile = report.sources.builtin.tools.find((t) => t.name === "write_file");
    const readFile = report.sources.builtin.tools.find((t) => t.name === "read_file");
    assert.equal(shell.approvalPolicy, "conditional-shell-risk-tiers");
    assert.equal(shell.effectiveInteractivePolicy, "conditional-shell-risk-tiers");
    assert.equal(shell.unattendedPolicy, "refused");
    assert.equal(shell.sandboxed, false);
    assert.equal(writeFile.approvalPolicy, "approval-required");
    assert.equal(writeFile.unattendedPolicy, "refused");
    assert.equal(readFile.approvalPolicy, "no-prompt");
    assert.equal(readFile.unattendedPolicy, "allowed");

    assert.equal(report.sources.customManifest.state, "disabled");
    assert.equal(report.sources.localPlugins.state, "disabled");
    assert.equal(report.sources.mcp.state, "disabled");

    const text = renderToolInventory(report);
    assert.match(text, /OS sandbox: none/);
    assert.match(text, /neither verified safe, trusted by default, nor OS\/VM\/container sandboxed/);
  } finally {
    cleanup();
  }
});

test("policy posture reflects riskTiers, autoApprove, desktop override, and unattended refusal", () => {
  const noRiskTiers = describeBuiltinTools({ riskTiers: false, autoApprove: false });
  assert.equal(noRiskTiers.find((t) => t.name === "shell").approvalPolicy, "approval-required");

  const autoApproved = buildToolInventory({
    env: {
      QUASNOOZE_AUTO_APPROVE: "true",
      QUASNOOZE_RISK_TIERS: "true",
    },
  });
  assert.equal(autoApproved.policy.autoApprove, true);
  assert.equal(autoApproved.policy.interactiveGate, "bypassed-by-auto-approve-config");
  const shellAuto = autoApproved.sources.builtin.tools.find((t) => t.name === "shell");
  assert.equal(shellAuto.effectiveInteractivePolicy, "auto-approved-by-config");
  // Unattended scheduled runs still refuse dangerous tools even when autoApprove=true.
  assert.equal(shellAuto.unattendedPolicy, "refused");
  assert.ok(autoApproved.limitations.some((line) => line.includes("QUASNOOZE_AUTO_APPROVE=true")));

  const desktopForcedOff = buildToolInventory({
    env: {
      QUASNOOZE_AUTO_APPROVE: "true",
      QUASNOOZE_DESKTOP: "true",
    },
  });
  assert.equal(desktopForcedOff.policy.desktopMode, true);
  assert.equal(desktopForcedOff.policy.autoApprove, false);
  assert.equal(desktopForcedOff.policy.interactiveGate, "dangerous-tools-require-human-approval");
});

test("side-effect canary plugin, manifest command, and MCP server are never imported or executed", () => {
  const { base, workspace, cleanup } = makeSandbox();
  const originalFetch = globalThis.fetch;
  try {
    const pluginDir = join(base, "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });

    const pluginMarker = join(base, "plugin-canary-executed.txt");
    const manifestMarker = join(base, "manifest-canary-executed.txt");
    const mcpMarker = join(base, "mcp-canary-executed.txt");

    // Top-level side effect + immediate throw if anything imports this module.
    fs.writeFileSync(
      join(pluginDir, "canary.mjs"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pluginMarker)}, "imported");\n` +
        `throw new Error("canary plugin top-level code executed");\n`,
    );
    fs.writeFileSync(join(pluginDir, "notes.txt"), "ignored non-js file");

    const manifestPath = join(base, "custom-tools.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        tools: [
          {
            name: "run_canary",
            description: "Declarative manifest canary command that must not run.",
            command: process.execPath,
            args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(manifestMarker)}, "ran")`],
            parameters: { query: { description: "search text", required: true } },
            trusted: true,
          },
        ],
      }),
    );

    const mcpSpec =
      `files=${process.execPath} -e require('fs').writeFileSync(${JSON.stringify(mcpMarker)},'ran');` +
      `docs=npx -y @modelcontextprotocol/server-everything`;

    globalThis.fetch = async () => {
      throw new Error("unexpected network fetch during static inventory");
    };

    const report = buildToolInventory({
      env: {
        QUASNOOZE_WORKSPACE: workspace,
        QUASNOOZE_TOOLS: manifestPath,
        QUASNOOZE_TOOLS_DIR: pluginDir,
        QUASNOOZE_MCP: mcpSpec,
        QUASNOOZE_MCP_TRUSTED: "files,unused_server",
      },
    });

    assert.equal(fs.existsSync(pluginMarker), false, "canary plugin was imported");
    assert.equal(fs.existsSync(manifestMarker), false, "manifest command was executed");
    assert.equal(fs.existsSync(mcpMarker), false, "MCP server was spawned");

    // Local JS plugin remains uninspected with unknown dynamic metadata.
    const plugins = report.sources.localPlugins;
    assert.equal(plugins.state, "uninspected");
    assert.equal(plugins.imported, false);
    assert.equal(plugins.executed, false);
    assert.equal(plugins.eligibleModules, 1);
    assert.equal(plugins.ignoredEntries, 1);
    assert.equal(plugins.candidates.length, 1);
    assert.equal(plugins.candidates[0].module, "canary.mjs");
    assert.equal(plugins.candidates[0].imported, false);
    assert.equal(plugins.candidates[0].toolName, "unknown");
    assert.equal(plugins.candidates[0].declaredTrust, "unknown");
    assert.equal(plugins.candidates[0].sandboxed, false);

    // Custom manifest tool is inspected statically, never trusts `trusted: true`.
    const manifest = report.sources.customManifest;
    assert.equal(manifest.state, "inspected");
    assert.equal(manifest.executed, false);
    assert.equal(manifest.trustedOptOutSupported, false);
    assert.ok(manifest.warnings.includes("unsupported-trusted-field-ignored"));
    assert.equal(manifest.tools.length, 1);
    assert.equal(manifest.tools[0].name, "run_canary");
    assert.equal(manifest.tools[0].state, "configured-unverified");
    assert.equal(manifest.tools[0].executableVerified, false);
    assert.equal(manifest.tools[0].dangerous, true);
    assert.equal(manifest.tools[0].trusted, false);
    assert.equal(manifest.tools[0].approvalPolicy, "approval-required");
    assert.equal(manifest.tools[0].unattendedPolicy, "refused");
    assert.equal(manifest.tools[0].command, "[REDACTED_PATH]");

    // MCP servers remain uninspected with unknown remote tool lists.
    const mcp = report.sources.mcp;
    assert.equal(mcp.state, "uninspected");
    assert.equal(mcp.spawned, false);
    assert.equal(mcp.unusedTrustedNames, 1);
    assert.equal(mcp.servers.length, 2);
    const filesSrv = mcp.servers.find((s) => s.name === "files");
    const docsSrv = mcp.servers.find((s) => s.name === "docs");
    assert.equal(filesSrv.trusted, true);
    assert.equal(filesSrv.dangerous, false);
    assert.equal(filesSrv.approvalPolicy, "trusted-opt-out");
    assert.equal(filesSrv.unattendedPolicy, "allowed");
    assert.equal(filesSrv.dynamicTools, "unknown");
    assert.equal(filesSrv.toolCount, null);
    assert.equal(docsSrv.trusted, false);
    assert.equal(docsSrv.dangerous, true);
    assert.equal(docsSrv.approvalPolicy, "approval-required");
    assert.equal(docsSrv.unattendedPolicy, "refused");
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

test("CLI entrypoints (`src/cli.js tools`, `quasnooze tools`, `pinch tools`) never import canary plugins or create state files", () => {
  const { base, workspace, cleanup } = makeSandbox();
  try {
    const pluginDir = join(base, "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    const pluginMarker = join(base, "cli-canary-imported.txt");
    fs.writeFileSync(
      join(pluginDir, "boom.mjs"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(pluginMarker)}, "imported");\n` +
        `throw new Error("CLI imported plugin");\n`,
    );
    const nonExistentDataDir = join(base, "data-must-not-be-created");

    const beforeSnapshot = snapshotTree(base);
    const childEnv = {
      ...process.env,
      PINCH_WORKSPACE: workspace,
      QUASNOOZE_WORKSPACE: workspace,
      PINCH_DATA: nonExistentDataDir,
      QUASNOOZE_DATA: nonExistentDataDir,
      PINCH_TOOLS_DIR: pluginDir,
      QUASNOOZE_TOOLS_DIR: pluginDir,
      PINCH_TOOLS: "",
      QUASNOOZE_TOOLS: "",
      PINCH_MCP: "gh=npx -y @mcp/github",
      QUASNOOZE_MCP: "gh=npx -y @mcp/github",
      LLM_PROVIDER: "mock",
    };

    const jsonRes = spawnSync(process.execPath, [quasnoozeBin, "tools", "--json"], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(jsonRes.status, 0, jsonRes.stderr);
    const parsed = JSON.parse(jsonRes.stdout);
    assert.equal(parsed.status, "ok");
    assert.equal(parsed.sources.localPlugins.candidates[0].module, "boom.mjs");
    assert.equal(parsed.sources.localPlugins.candidates[0].imported, false);
    assert.equal(fs.existsSync(pluginMarker), false);
    assert.equal(fs.existsSync(nonExistentDataDir), false, "inventory CLI created PINCH_DATA");

    const textRes = spawnSync(process.execPath, [pinchBin, "tools"], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(textRes.status, 0, textRes.stderr);
    assert.match(textRes.stdout, /boom\.mjs: uninspected/);
    assert.equal(fs.existsSync(pluginMarker), false);

    // Invalid flag exits 1 without importing plugins or echoing untrusted flag values.
    const badArgCanary = "--unknown=/Users/secretperson/token-sk-999999999999";
    const badRes = spawnSync(process.execPath, [cliPath, "tools", badArgCanary], {
      cwd: repoRoot,
      env: childEnv,
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(badRes.status, 1);
    assert.equal(fs.existsSync(pluginMarker), false);
    assert.equal(badRes.stderr.includes("secretperson"), false);
    assert.equal(badRes.stderr.includes("sk-999999999999"), false);

    assert.deepEqual(snapshotTree(base), beforeSnapshot, "CLI mutated filesystem during static inventory");
  } finally {
    cleanup();
  }
});

test("redacts credential fields, inline secrets, control characters, and personal paths across JSON and rendered output", () => {
  const { base, workspace, cleanup } = makeSandbox();
  try {
    const envSecret = "quas-secret-key-val-882910";
    const inlineOpenAi = "sk-liveSecretTokenValue123456";
    const inlineGh = "ghp_secretGitHubPatValue987654321";
    const urlCreds = "https://dbadmin:hunter2pass@db.internal.local:5432/prod?api_key=querySecret777";
    const personalPosix = "/home/ranjith/Documents/private-ledger.csv";
    const personalMac = "/Users/alice/Library/Keychains/login.keychain-db";
    const personalWin = "C:\\Users\\Bob\\AppData\\Roaming\\secret.json";
    const tildePath = "~/vault/recovery-codes.txt";

    const pluginDir = join(base, "plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(join(pluginDir, `plugin-${inlineGh}.mjs`), "export default {};\n");

    const manifestPath = join(base, "manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        $comment: `Owner config at ${personalPosix} with ${envSecret}`,
        apiKey: inlineOpenAi,
        tools: [
          {
            name: "sync_records",
            description: `Sync ${personalPosix}, ${personalMac}, ${personalWin} and ${tildePath} via ${urlCreds} with --token ${inlineOpenAi}\u0007\u202e`,
            command: "/opt/custom/bin/sync-tool",
            args: ["--api-key", inlineOpenAi, "--config", personalPosix, "{{filter}}"],
            headers: { Authorization: `Bearer ${envSecret}` },
            parameters: {
              filter: {
                description: `Filter rows in ${personalPosix}`,
                clientSecret: envSecret,
              },
            },
          },
        ],
      }),
    );

    const report = buildToolInventory({
      home: "/home/ranjith",
      env: {
        QUASNOOZE_WORKSPACE: workspace,
        QUASNOOZE_TOOLS: manifestPath,
        QUASNOOZE_TOOLS_DIR: pluginDir,
        QUASNOOZE_MCP: `vault=/usr/local/bin/mcp-vault --password=${envSecret} ${personalMac};OPENAI_API_KEY=${inlineOpenAi}`,
        QUASNOOZE_KEY: envSecret,
      },
      mcpServers: undefined,
    });

    const combined = `${JSON.stringify(report)}\n${renderToolInventory(report)}`;
    for (const forbidden of [
      envSecret,
      inlineOpenAi,
      inlineGh,
      "hunter2pass",
      "querySecret777",
      "ranjith",
      "private-ledger.csv",
      "alice",
      "login.keychain-db",
      "Bob",
      "AppData",
      "recovery-codes.txt",
      "/opt/custom/bin/sync-tool",
      base,
      workspace,
      "\u0007",
      "\u202e",
    ]) {
      assert.equal(
        combined.includes(forbidden),
        false,
        `expected "${forbidden}" to be redacted from output`,
      );
    }

    const syncTool = report.sources.customManifest.tools[0];
    assert.ok(syncTool.redactions.includes("credential-field"));
    assert.ok(syncTool.redactions.includes("arguments-withheld"));
    assert.ok(syncTool.redactions.includes("personal-or-filesystem-path"));
    assert.ok(syncTool.redactions.includes("control-characters"));
    assert.equal(report.sources.mcp.skippedSpecs, 1, "secret-key-shaped MCP chunk must be skipped");

    // Also verify MCP servers array env redaction when passed programmatically.
    const mcpWithEnv = inspectMcpConfig({
      servers: [
        {
          name: "internal",
          command: "node",
          args: [personalPosix],
          env: { API_TOKEN: inlineOpenAi },
          trusted: false,
        },
      ],
      sanitizeText: (v) => redactInventoryText(v, { secrets: [inlineOpenAi] }),
      isCredentialKey: (k) => /token|secret|key/i.test(k),
    });
    assert.equal(JSON.stringify(mcpWithEnv).includes(inlineOpenAi), false);
    assert.equal(JSON.stringify(mcpWithEnv).includes("ranjith"), false);
    assert.ok(mcpWithEnv.servers[0].redactions.includes("environment-values-withheld"));
    assert.ok(mcpWithEnv.servers[0].redactions.includes("credential-field"));
  } finally {
    cleanup();
  }
});

test("rejects traversal, direct and ancestor symlinks, workspace-overlapping plugins/commands, protected paths, and non-regular files", () => {
  const { base, workspace, cleanup } = makeSandbox();
  try {
    // 1. Lexical `..` traversal in customToolsPath and toolsDir
    const traversalReport = buildToolInventory({
      workspaceRoots: [workspace],
      customToolsPath: `${base}/sub/../manifest.json`,
      toolsDir: "../escape-plugins",
    });
    assert.equal(traversalReport.status, "partial");
    assert.equal(traversalReport.sources.customManifest.state, "rejected");
    assert.equal(traversalReport.sources.customManifest.reason, "traversal-rejected");
    assert.equal(traversalReport.sources.localPlugins.state, "rejected");
    assert.equal(traversalReport.sources.localPlugins.reason, "traversal-rejected");

    // 2. Protected credential store paths (~/.ssh, ~/.aws)
    const sshPath = join(homedir(), ".ssh", "config");
    const awsDir = join(homedir(), ".aws");
    const protectedReport = buildToolInventory({
      workspaceRoots: [workspace],
      customToolsPath: sshPath,
      toolsDir: awsDir,
    });
    assert.equal(protectedReport.sources.customManifest.state, "rejected");
    assert.equal(protectedReport.sources.customManifest.reason, "protected-path-rejected");
    assert.equal(protectedReport.sources.localPlugins.state, "rejected");
    assert.equal(protectedReport.sources.localPlugins.reason, "protected-path-rejected");

    // 3. Plugin directory inside workspace (including `..plugins` dot-prefixed folder)
    const dotPluginsInWorkspace = join(workspace, "..plugins");
    fs.mkdirSync(dotPluginsInWorkspace, { recursive: true });
    fs.writeFileSync(join(dotPluginsInWorkspace, "inside.mjs"), "export default {};\n");
    const insideWsReport = buildToolInventory({
      workspaceRoots: [workspace],
      toolsDir: dotPluginsInWorkspace,
    });
    assert.equal(insideWsReport.sources.localPlugins.state, "rejected");
    assert.equal(insideWsReport.sources.localPlugins.reason, "inside-workspace-rejected");

    // 4. Manifest entries with command inside workspace, traversal, or protected path
    const manifestCheck = inspectManifestData(
      {
        tools: [
          {
            name: "ws_bin",
            description: "Points inside model-writable workspace",
            command: join(workspace, "evil.sh"),
            args: [],
            parameters: {},
          },
          {
            name: "trav_bin",
            description: "Uses parent traversal in command",
            command: "/usr/local/../bin/id",
            args: [],
            parameters: {},
          },
          {
            name: "ssh_bin",
            description: "Points into protected ssh directory",
            command: join(homedir(), ".ssh", "helper"),
            args: [],
            parameters: {},
          },
        ],
      },
      {
        workspaceRoots: [workspace],
        home: homedir(),
        isProtectedPath: (p) => p.includes(`${join(homedir(), ".ssh")}`),
      },
    );
    assert.equal(manifestCheck.tools.length, 0);
    assert.deepEqual(manifestCheck.skipped, [
      { name: "ws_bin", reason: "command-inside-workspace" },
      { name: "trav_bin", reason: "command-traversal-rejected" },
      { name: "ssh_bin", reason: "protected-command-path" },
    ]);

    // 5. Direct symlink, ancestor symlink, and symlinked/directory plugin entries
    const outsideDir = join(base, "outside");
    fs.mkdirSync(outsideDir, { recursive: true });
    const outsideManifest = join(outsideDir, "secret-manifest.json");
    fs.writeFileSync(outsideManifest, JSON.stringify({ tools: [] }));

    const directManifestLink = join(base, "manifest-link.json");
    let symlinksSupported = false;
    try {
      fs.symlinkSync(outsideManifest, directManifestLink);
      symlinksSupported = true;
    } catch {
      symlinksSupported = false;
    }

    if (symlinksSupported) {
      let readCount = 0;
      const countingIo = new Proxy(fs, {
        get(target, prop, receiver) {
          if (prop === "readSync") {
            return (...args) => {
              readCount += 1;
              return Reflect.apply(target.readSync, target, args);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });

      const directLinkReport = buildToolInventory({
        io: countingIo,
        workspaceRoots: [workspace],
        customToolsPath: directManifestLink,
      });
      assert.equal(directLinkReport.sources.customManifest.state, "rejected");
      assert.equal(directLinkReport.sources.customManifest.reason, "symlink-rejected");
      assert.equal(readCount, 0, "symlinked manifest bytes must never be read");

      const ancestorLink = join(base, "linked-parent");
      fs.mkdirSync(join(outsideDir, "nested-plugins"), { recursive: true });
      fs.symlinkSync(outsideDir, ancestorLink);
      const ancestorManifestReport = buildToolInventory({
        io: countingIo,
        workspaceRoots: [workspace],
        customToolsPath: join(ancestorLink, "secret-manifest.json"),
        toolsDir: ancestorLink,
      });
      assert.equal(ancestorManifestReport.sources.customManifest.state, "rejected");
      assert.equal(ancestorManifestReport.sources.customManifest.reason, "symlink-rejected");
      assert.equal(ancestorManifestReport.sources.localPlugins.state, "rejected");
      assert.equal(ancestorManifestReport.sources.localPlugins.reason, "symlink-rejected");
      assert.equal(readCount, 0, "ancestor-symlinked manifest bytes must never be read");

      const nestedViaAncestorReport = buildToolInventory({
        io: countingIo,
        workspaceRoots: [workspace],
        toolsDir: join(ancestorLink, "nested-plugins"),
      });
      assert.equal(nestedViaAncestorReport.sources.localPlugins.state, "rejected");
      assert.equal(nestedViaAncestorReport.sources.localPlugins.reason, "symlink-rejected");

      const fileAsToolsDirReport = buildToolInventory({
        io: countingIo,
        workspaceRoots: [workspace],
        toolsDir: outsideManifest,
        customToolsPath: outsideDir,
      });
      assert.equal(fileAsToolsDirReport.sources.localPlugins.state, "rejected");
      assert.equal(fileAsToolsDirReport.sources.localPlugins.reason, "not-directory");
      assert.equal(fileAsToolsDirReport.sources.customManifest.state, "rejected");
      assert.equal(fileAsToolsDirReport.sources.customManifest.reason, "not-regular-file");

      // Valid plugin directory containing a symlinked .mjs and a directory named dir.mjs
      const mixedPlugins = join(base, "mixed-plugins");
      fs.mkdirSync(mixedPlugins, { recursive: true });
      const outsidePlugin = join(outsideDir, "ext.mjs");
      fs.writeFileSync(outsidePlugin, "throw new Error('should not run');\n");
      fs.symlinkSync(outsidePlugin, join(mixedPlugins, "linked.mjs"));
      fs.mkdirSync(join(mixedPlugins, "folder.mjs"));
      fs.writeFileSync(join(mixedPlugins, "valid.mjs"), "export default {};\n");

      const mixedReport = buildToolInventory({
        workspaceRoots: [workspace],
        toolsDir: mixedPlugins,
      });
      assert.equal(mixedReport.sources.localPlugins.state, "uninspected");
      assert.equal(mixedReport.sources.localPlugins.eligibleModules, 1);
      assert.equal(mixedReport.sources.localPlugins.rejectedEntries, 2);
      const byName = new Map(mixedReport.sources.localPlugins.candidates.map((c) => [c.module, c]));
      assert.equal(byName.get("linked.mjs").state, "rejected-symlink");
      assert.equal(byName.get("linked.mjs").eligible, false);
      assert.equal(byName.get("folder.mjs").state, "rejected-non-regular");
      assert.equal(byName.get("folder.mjs").eligible, false);
      assert.equal(byName.get("valid.mjs").state, "uninspected");
      assert.equal(byName.get("valid.mjs").eligible, true);
    }
  } finally {
    cleanup();
  }
});

test("enforces strict size and entry bounds without reading oversized manifests or plugin file contents", () => {
  const { base, workspace, cleanup } = makeSandbox();
  try {
    // Oversized manifest (> 64 KiB) rejected before reading bytes
    const hugeManifest = join(base, "huge.json");
    fs.writeFileSync(hugeManifest, `{"tools":[],"pad":"${"x".repeat(INVENTORY_LIMITS.manifestBytes + 1024)}"}`);

    let readCalls = 0;
    const writeCalls = [];
    const guardedIo = new Proxy(fs, {
      get(target, prop, receiver) {
        if (prop === "readSync" || prop === "readFileSync") {
          return (...args) => {
            readCalls += 1;
            return Reflect.apply(target[prop], target, args);
          };
        }
        if (/^(?:write|append|unlink|rm|rmdir|mkdir|rename|chmod|chown|truncate|copyFile)/i.test(String(prop))) {
          return () => {
            writeCalls.push(String(prop));
            throw new Error(`forbidden mutation call: ${String(prop)}`);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const pluginDir = join(base, "many-plugins");
    fs.mkdirSync(pluginDir, { recursive: true });
    for (let i = 0; i < 6; i += 1) {
      fs.writeFileSync(join(pluginDir, `mod-${i}.mjs`), "throw new Error('never read');\n");
    }

    const mcpSpec = Array.from({ length: 5 }, (_, i) => `srv${i}=npx -y @mcp/s${i}`).join(";");
    const report = buildToolInventory({
      io: guardedIo,
      workspaceRoots: [workspace],
      customToolsPath: hugeManifest,
      toolsDir: pluginDir,
      mcpSpec,
      limits: {
        pluginEntries: 4,
        mcpServers: 3,
      },
    });

    assert.equal(readCalls, 0, "oversized manifest and plugin scan must perform zero file-body reads");
    assert.deepEqual(writeCalls, []);
    assert.equal(report.status, "partial");
    assert.equal(report.sources.customManifest.state, "rejected");
    assert.equal(report.sources.customManifest.reason, "oversized");

    assert.equal(report.sources.localPlugins.state, "partial");
    assert.equal(report.sources.localPlugins.reason, "entry-limit-reached");
    assert.equal(report.sources.localPlugins.scannedEntries, 4);
    assert.equal(report.sources.localPlugins.truncated, true);

    assert.equal(report.sources.mcp.state, "partial");
    assert.equal(report.sources.mcp.reason, "server-limit-reached");
    assert.equal(report.sources.mcp.configuredServers, 3);
    assert.equal(report.sources.mcp.truncated, true);

    // `--strict` exits non-zero when a configured source is degraded/rejected.
    const strictFail = spawnSync(process.execPath, [cliPath, "tools", "--strict"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        QUASNOOZE_WORKSPACE: workspace,
        QUASNOOZE_TOOLS: hugeManifest,
      },
      encoding: "utf8",
      timeout: 15_000,
    });
    assert.equal(strictFail.status, 1);
  } finally {
    cleanup();
  }
});

test("redaction stays linear-time on adversarial 50k-character inputs", () => {
  const adversarial = [
    "token".repeat(5000),
    `https://${"a:".repeat(4000)}no-at-sign`,
    "--api-key ".repeat(3000),
    `/${"segment/".repeat(3000)}leaf`,
  ].join(" ");

  const start = performance.now();
  const out = redactInventoryText(adversarial, {
    secrets: ["super-secret-value"],
    sensitivePaths: ["/home/exampleuser"],
    maxLength: 200,
  });
  const elapsedMs = performance.now() - start;

  assert.ok(elapsedMs < 500, `redaction took ${elapsedMs.toFixed(1)}ms on adversarial input`);
  assert.ok(out.text.length <= 200);
});
