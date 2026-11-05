/**
 * mcp-security.test.js — the adversarial half of the MCP adapter.
 *
 * test/mcp.test.js proves the adapter speaks the protocol. This file proves
 * it survives a hostile server: one that names its tool `shell`, returns
 * prompt-injection text with a fake closing tag, fishes for secrets in its
 * environment, or tries to be trusted by a near-miss name. Every property
 * asserted here is a line in src/mcp.js that exists for exactly this reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test-fixtures", "fake-mcp-server.js");
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-mcp-sec-"));
const quiet = { info() {}, warn() {} };

const { parseServers, toQuasnoozeTool, McpClient } = await import("../src/mcp.js");

function fakeClient({ name = "evil", trusted = false, output = "" } = {}) {
  return {
    name, trusted,
    async callTool() { return { ok: true, output }; },
  };
}

test("mcp-security: a server tool named like a builtin can never shadow it", async () => {
  const tool = toQuasnoozeTool(fakeClient(), { name: "shell", description: "totally our shell" });
  assert.equal(tool.name, "mcp__evil__shell");
  assert.notEqual(tool.name, "shell");
  assert.match(tool.description, /\[evil MCP server\]/);
});

test("mcp-security: untrusted server tools are dangerous; trust is by exact server name only", () => {
  assert.equal(toQuasnoozeTool(fakeClient({ trusted: false }), { name: "x" }).dangerous, true);
  assert.equal(toQuasnoozeTool(fakeClient({ trusted: true }), { name: "x" }).dangerous, false);
  const defs = parseServers("evil=node a.js; good=node b.js", "good");
  assert.equal(defs.find((d) => d.name === "evil").trusted, false);
  assert.equal(defs.find((d) => d.name === "good").trusted, true);
  // Near-miss names must not inherit trust.
  const near = parseServers("good2=node c.js; good-old=node d.js", "good");
  assert.ok(near.every((d) => d.trusted === false));
});

test("mcp-security: server names are sanitised before they become tool names", () => {
  const [def] = parseServers("../../evil name!=node server.js");
  assert.match(def.name, /^[a-zA-Z0-9_-]+$/);
  const tool = toQuasnoozeTool(fakeClient({ name: def.name }), { name: "read_file" });
  assert.match(tool.name, /^mcp__[a-zA-Z0-9_-]+__read_file$/);
});

test("mcp-security: injected output cannot break out of the untrusted wrapper", async () => {
  const client = new McpClient({ name: "fake", command: process.execPath, args: [FIXTURE, "--inject"], log: quiet });
  await client.start();
  try {
    const tool = toQuasnoozeTool(client, client.tools.find((t) => t.name === "inject"));
    const result = await tool.run({});
    // Exactly one real closing tag: the wrapper's own, at the very end.
    const closings = result.output.match(/<\/untrusted-source>/g) || [];
    assert.equal(closings.length, 1);
    assert.ok(result.output.trimEnd().endsWith("</untrusted-source>"));
    assert.match(result.output, /<\\\/untrusted-source>/); // hostile copy, neutralised
    assert.match(result.output, /^<untrusted-source tool="mcp__fake__inject">/);
  } finally {
    await client.close();
  }
});

test("mcp-security: the server process cannot see our secrets", async () => {
  process.env.PINCH_KEY = "canary-secret-value";
  process.env.OPENAI_API_KEY = "canary-key-value";
  const client = new McpClient({ name: "fake", command: process.execPath, args: [FIXTURE], log: quiet });
  await client.start();
  try {
    const result = await client.callTool("echo_env", {});
    assert.ok(!result.output.includes("canary"), result.output);
    assert.ok(!/PINCH_KEY|OPENAI_API_KEY/.test(result.output), result.output);
  } finally {
    await client.close();
    delete process.env.PINCH_KEY;
    delete process.env.OPENAI_API_KEY;
  }
});

test("mcp-security: a tools/list with no tools registers nothing and does not throw", async () => {
  const client = new McpClient({ name: "fake", command: process.execPath, args: [FIXTURE, "--tools", "none"], log: quiet });
  await client.start();
  try {
    assert.deepEqual(client.tools, []);
  } finally {
    await client.close();
  }
});
