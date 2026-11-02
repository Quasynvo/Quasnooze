#!/usr/bin/env node
/**
 * scripts/doctor.js — the machine-readable half of diagnostics.
 *
 *   npm run health              the provider matrix, the turn's routing plan, and the verdict
 *   npm run health -- --json    the same as one JSON object, for scripts and agents
 *   npm run health -- --no-network   skip every request (what is configured, nothing more)
 *
 * `pinch doctor` (scripts/setup.js --check) stays as it was: prose for a person setting things up.
 * This one exits non-zero when a check fails, so it can gate a deploy or a CI job.
 */
import { config } from "../src/config.js";
import { planFor } from "../src/failure.js";
import { renderDoctor, renderJson, runDoctor } from "../src/doctor.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const json = args.includes("--json");
const network = !args.includes("--no-network");

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
  npm run health [-- --json] [-- --no-network]

  Checks the runtime, the access settings, the data directory, every model provider (with real
  requests and latencies), and whether a turn would survive its provider failing.
  Exits 1 when any check fails, so it can gate CI.
`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

const report = await runDoctor({
  cfg: config,
  pkg,
  plan: planFor(config.llm.provider === "mock" ? { provider: "mock", model: "mock" } : { provider: config.llm.provider, model: config.llm.provider === "openai" ? config.llm.openaiModel : config.llm.ollamaModel }),
  network,
});

process.stdout.write(json ? renderJson(report) : `${renderDoctor(report)}\n`);
if (!report.ok) process.exitCode = 1;
