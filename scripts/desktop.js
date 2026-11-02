#!/usr/bin/env node
// Must run before config.js is loaded; no .env or machine policy is rewritten.
if (process.platform !== "win32") {
  console.error("Quasnooze's resident companion requires Windows 10/11 and Node.js 22+. Use npm start for the cross-platform web/channel assistant. See docs/DESKTOP.md.");
  process.exitCode = 1;
} else if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Quasnooze desktop requires Node.js 22 or newer.");
  process.exitCode = 1;
} else {
  process.env.QUASNOOZE_DESKTOP = "1";
  process.env.PINCH_DESKTOP = "1";
  await import("../src/index.js");
}
