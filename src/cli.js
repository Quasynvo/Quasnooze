#!/usr/bin/env node
/**
 * cli.js — use Quasnooze without a browser.
 *
 *   node src/cli.js ask "explain this stack trace"
 *   node src/cli.js chat
 *   node src/cli.js tools [--json] [--strict]
 *
 * Same agent, same memory, same approval flow — just a terminal.
 * `tools` inspects static capability and trust metadata without loading plugins.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const C = {
  coral: (s) => `\x1b[38;5;87m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  teal: (s) => `\x1b[38;5;79m${s}\x1b[0m`,
  gold: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
};

const TOOLS_USAGE =
  "quasnooze tools [--json] [--strict]\n" +
  "Read-only capability and trust inventory across built-in tools, QUASNOOZE_TOOLS,\n" +
  "QUASNOOZE_TOOLS_DIR and QUASNOOZE_MCP. Never imports plugins, runs commands or spawns MCP servers.\n" +
  "See docs/TOOL-INVENTORY.md.";

async function runToolsInventoryCli(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(TOOLS_USAGE);
    return;
  }
  let json = false;
  let strict = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "--strict") strict = true;
    else {
      console.error(
        "Invalid tools inventory option; use --help. No plugins, commands or MCP servers were executed.",
      );
      process.exitCode = 1;
      return;
    }
  }
  try {
    const { buildToolInventory, renderToolInventory } = await import("./tool-inventory.js");
    const report = buildToolInventory();
    console.log(json ? JSON.stringify(report, null, 2) : renderToolInventory(report));
    if (strict && report.status !== "ok") process.exitCode = 1;
  } catch {
    console.error(
      "Tool inventory failed. Check local configuration and permissions; no plugins or commands were executed. See --help and docs/TOOL-INVENTORY.md.",
    );
    process.exitCode = 1;
  }
}

async function runProvidersCli(args) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("quasnooze providers [--json]\nList every brain provider preset (local and cloud), which key it needs, and whether it is configured. Never prints a key. Select one with LLM_PROVIDER=<id>. See docs/PROVIDERS.md.");
    return;
  }
  const json = args.includes("--json");
  if (args.some((a) => a !== "--json")) { console.error("Invalid providers option; use --help."); process.exitCode = 1; return; }
  const { providerCatalogue, renderProviderCatalogue } = await import("./providers.js");
  const { config } = await import("./config.js");
  const rows = providerCatalogue(process.env, config.llm.preset);
  console.log(json ? JSON.stringify(rows, null, 2) : renderProviderCatalogue(rows));
}

const SCOUT_USAGE = `quasnooze scout add --when "every 30m" --address web:main --source https://example.com/feed --allow-remote
quasnooze scout list
quasnooze scout delete <id>
Owner-only configuration. Remote GETs and the selected delivery channel create network egress; sources are untrusted. See docs/SCOUT.md.`;
async function runScoutCli(args) {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(SCOUT_USAGE); return; }
  const { ensureData } = await import('./store.js');
  const { addSchedule, listSchedules, deleteSchedule } = await import('./schedules.js');
  ensureData();
  const [action, ...rest] = args;
  if (action === 'list' && !rest.length) {
    const rows = listSchedules().filter(s => s.kind === 'scout');
    console.log(JSON.stringify(rows, null, 2)); return;
  }
  if (action === 'delete' && rest.length === 1) {
    if (!listSchedules().some(s => s.kind === 'scout' && s.id === rest[0])) throw new Error('Scout not found.');
    deleteSchedule(rest[0]); console.log('Scout deleted.'); return;
  }
  if (action !== 'add') throw new Error('Invalid scout command. Use scout --help.');
  const opts = { sources: [], remote: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--allow-remote' && !opts.remote) { opts.remote = true; continue; }
    if (!['--source', '--when', '--address'].includes(arg) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('Invalid scout option. Use scout --help.');
    const value = rest[++i];
    if (arg === '--source') opts.sources.push(value);
    else if (opts[arg.slice(2)] !== undefined) throw new Error('Duplicate scout option.');
    else opts[arg.slice(2)] = value;
  }
  if (!opts.remote) throw new Error('No scout created: explicitly pass --allow-remote to permit HTTPS source requests.');
  const result = addSchedule({ task: 'Owner-configured source briefing', when: opts.when, address: opts.address, scout: { enabled: true, remoteFetch: true, sources: opts.sources } });
  if (!result.ok) throw new Error(result.output);
  console.log(JSON.stringify(result.schedule, null, 2));
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "scout") { await runScoutCli(rest); return; }
  if (mode === "providers") { await runProvidersCli(rest); return; }
  if (mode === "tools" || mode === "tool-inventory") {
    await runToolsInventoryCli(rest);
    return;
  }

  const [{ formatActionPreview }, { loadLocalTools }, { runAgent, answerApprovalByChannel, pendingApprovals }] =
    await Promise.all([
      import("./action-preview.js"),
      import("./tools.js"),
      import("./agent.js"),
    ]);

  function render(event) {
    if (event.type === "status") process.stdout.write(C.dim(`  ${event.message}…\r`));
    else if (event.type === "tool") process.stdout.write(`${C.gold("  🔧")} ${C.dim(`${event.name}: ${event.label}`)}\n`);
    else if (event.type === "tool_done") {
      const icon = event.ok ? C.teal("  ✓") : "\x1b[31m  ✕\x1b[0m";
      process.stdout.write(`${icon} ${C.dim(String(event.preview).split("\n")[0].slice(0, 100))}\n`);
    } else if (event.type === "approval") {
      process.stdout.write(`\n  ${C.gold("✦ permission:")} ${event.description}${event.preview ? "\n" + formatActionPreview(event.preview) : ""}\n  ${C.dim("allow? [y/N] ")}`);
    }
  }

  async function turn(text, sessionId) {
    // A y/n answer resolves a pending prompt instead of starting a new turn.
    if (pendingApprovals("cli").length && /^(y|yes|n|no)$/i.test(text.trim())) {
      answerApprovalByChannel("cli", /^y/i.test(text.trim()));
      return;
    }
    process.stdout.write("\n");
    const result = await runAgent({
      sessionId,
      text,
      channel: "cli",
      onEvent: render,
    });
    process.stdout.write(`\n${C.coral("✦")} ${result.text}\n\n`);
  }

  // local modules loaded before terminal turns (never in `tools` inventory mode above)
  await loadLocalTools();
  const rl = createInterface({ input: stdin, output: stdout });

  if (mode === "ask") {
    const question = rest.join(" ").trim();
    if (!question) {
      console.error('usage: node src/cli.js ask "your question"');
      process.exit(1);
    }
    await turn(question, `cli-${new Date().toISOString().slice(0, 10)}`);
    rl.close();
    return;
  }

  const sessionId = `cli-${new Date().toISOString().slice(0, 10)}`;
  console.log(`
${C.coral("✦ Quasnooze")} ${C.dim("— terminal mode. /help for commands, /exit to leave.")}
`);
  while (true) {
    const text = (await rl.question(C.coral("you › "))).trim();
    if (!text) continue;
    if (["/exit", "/quit", "exit", "quit"].includes(text)) break;
    if (text === "/help") {
      console.log(`
  /exit   leave
  /help   this
  /persona list/save/use/show/delete local style presets
  /status show what is waiting for approval
  /tools  read-only capability and trust inventory
  anything else is sent to Quasnooze.
`);
      continue;
    }
    if (text === "/status") {
      console.log(`  pending approvals: ${pendingApprovals("cli").length}`);
      continue;
    }
    if (text === "/tools") {
      const { buildToolInventory, renderToolInventory } = await import("./tool-inventory.js");
      console.log(`\n${renderToolInventory(buildToolInventory())}\n`);
      continue;
    }
    await turn(text, sessionId);
  }
  rl.close();
}

main().catch((err) => {
  console.error(`\x1b[31m${err.message}\x1b[0m`);
  process.exit(1);
});
