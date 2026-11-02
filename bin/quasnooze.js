#!/usr/bin/env node
/**
 * bin/quasnooze.js — the one command you type.
 *
 *   quasnooze              start the assistant (panel + chat apps)
 *   quasnooze setup        guided onboarding: brain, channels, voice, key
 *   quasnooze doctor       check what is configured and what is broken
 *   quasnooze ask "..."    one-shot question in the terminal
 *   quasnooze chat         terminal chat session (no browser)
 *   quasnooze pair         print the URL + QR for your phone
 *   quasnooze brain-test   measure the model and check it can call tools
 * *   quasnooze service      autostart snippet for systemd / launchd / Task Scheduler
 *   quasnooze supervise    restart-on-crash wrapper (any OS)
 *   quasnooze audit        run the adversarial self-check against this install
 *   quasnooze radar        what has drifted: runtime, CI, pinned actions
 *   quasnooze export       everything Quasnooze knows, in one portable JSON file
 *   quasnooze cost         token spend for the last 30 days, from telemetry
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [command = "start", ...rest] = process.argv.slice(2);

const c = {
  coral: (s) => `\x1b[38;5;87m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function usage() {
  console.log(`
${c.coral("✦ quasnooze")} — local, private, yours

  ${c.bold("quasnooze")}                 start Quasnooze (web panel + configured chat apps)
  ${c.bold("quasnooze setup")}           guided setup — brain, Telegram, Discord, Slack, WhatsApp, voice
  ${c.bold("quasnooze desktop")}         Windows resident assistant; microphone starts muted
  ${c.bold("quasnooze doctor")}          verify configuration and connectivity
  ${c.bold("quasnooze health")}          provider matrix, routing plan, and a verdict (--json for scripts)
  ${c.bold("quasnooze chat")}            chat in the terminal
  ${c.bold("quasnooze ask")} "question"  one-shot answer
  ${c.bold("quasnooze pair")}            print a QR + URL to open Quasnooze on your phone
  ${c.bold("quasnooze brain-test")}      measure model speed and tool-calling support
  ${c.bold("quasnooze service")}         autostart config for systemd / launchd / Windows
  ${c.bold("quasnooze supervise")}       restart Quasnooze automatically if it ever crashes
  ${c.bold("quasnooze audit")}           run the adversarial self-check against this install
  ${c.bold("quasnooze radar")}           what has drifted: runtime, CI, pinned actions
  ${c.bold("quasnooze growth")}          what to build next, measured from this checkout
  ${c.bold("quasnooze export")}          write everything Quasnooze knows to one JSON file
  ${c.bold("quasnooze cost")}            what the last 30 days of turns would have cost

Everything is configured in .env — no accounts, no cloud, no telemetry.
`);
}

function run(script, args = []) {
  const child = spawn(process.execPath, [join(root, script), ...args], {
    stdio: "inherit",
    cwd: root,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

switch (command) {
  case "start":
  case "serve":
    run("src/index.js");
    break;
  case "desktop":
    run("scripts/desktop.js", rest);
    break;
  case "audit":
    run("scripts/audit.js", rest);
    break;
  case "growth":
    run("scripts/growth.js", rest);
    break;
  case "radar":
    run("scripts/tech-radar.js", rest);
    break;
  case "setup":
    run("scripts/setup.js");
    break;
  case "doctor":
  case "check":
    run("scripts/setup.js", ["--check"]);
    break;
  case "health":
    run("scripts/doctor.js", rest);
    break;
  case "chat":
    run("src/cli.js", ["chat"]);
    break;
  case "pair":
    run("scripts/pair.js");
    break;
  case "brain-test":
  case "braintest":
    run("scripts/braincheck.js");
    break;
  case "service":
    run("scripts/service.js", rest);
    break;
  case "supervise":
  case "daemon":
    run("scripts/supervise.js");
    break;
  case "ask": {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error("Usage: quasnooze ask \"your question\"");
      process.exit(1);
    }
    run("src/cli.js", ["ask", text]);
    break;
  }
  case "-v":
  case "--version":
    console.log(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    break;
  case "export": {
    const outIdx = rest.indexOf("--out");
    const out = outIdx >= 0 ? rest[outIdx + 1] : null;
    const includeTelemetry = rest.includes("--include-telemetry");
    if (rest.includes("--help")) {
      console.log(`\n  quasnooze export [--out FILE] [--include-telemetry]\n
  Writes sessions, memory, reminders and schedules as one JSON document.
  Default is stdout, so:  quasnooze export > backup.json
  --out FILE           write to a file (mode 0600) instead
  --include-telemetry  also include the per-turn timing log
  .env is never included: keys are not part of your data dump.\n`);
      process.exit(0);
    }
    const { writeExport, describeExport } = await import("../src/export.js");
    const res = writeExport({ path: out, includeTelemetry });
    if (res.path) {
      console.error(describeExport(res));
    } else {
      process.stdout.write(res.json);
      console.error(`\n${describeExport(res)}\n`);
    }
    process.exit(0);
  }

  case "cost": {
    const { costReport } = await import("../src/cost.js");
    console.log(costReport({ days: Number(rest[0]) || 30, json: rest.includes("--json") }));
    process.exit(0);
  }

  case "help":
  case "-h":
  case "--help":
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
