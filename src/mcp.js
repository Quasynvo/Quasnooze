/**
 * mcp.js — third-party tools over the Model Context Protocol.
 *
 * The gap this closes: every comparable assistant lets you point it at someone
 * else's tools, and Quasnooze required editing src/tools.js. An MCP server is a
 * process that speaks JSON-RPC on stdin/stdout and can list and call tools; that
 * is close enough to Quasnooze's own tool shape (name, schema, async run) that the
 * whole adapter is a translator, not a subsystem.
 *
 * The one line that matters is `dangerous: !trusted`. An MCP server is
 * arbitrary third-party code that was written by someone else and installed
 * from a registry. It must not inherit the trust of a tool Quasnooze shipped, so an
 * untrusted server's tools go through the same in-chat approval gate as `shell`.
 * Trust is opt-in per server, by name, in your own .env.
 *
 * Transport: stdio. The HTTP transport needs a server-side SSE endpoint, a
 * session id and its own retry rules; stdio needs a pipe. Start with the pipe.
 */
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { childEnv } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_LINE_BYTES = 4 * 1024 * 1024; // a tool result, not an essay
const RESTART_BACKOFF_MS = 5_000;

/* ──────────────────────────────── client ──────────────────────────────── */

/**
 * One MCP server, spoken to over its stdin/stdout.
 *
 * JSON-RPC is newline-delimited here: one JSON object per line, in both
 * directions. Requests are correlated by id, every request has a deadline, and
 * a server that dies rejects everything still in flight rather than leaving the
 * caller waiting for a reply that will never come.
 */
export class McpClient {
  constructor({ name, command, args = [], env = {}, log = console }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.log = log;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer, method }
    this.buffer = "";
    this.tools = [];
    this.info = null;
    this.closed = false;
    this.stderrTail = "";
  }

  /** Start the process and complete the handshake. Throws if it cannot. */
  async start() {
    this.child = spawn(this.command, this.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      // Same scrub as the shell tool: an MCP server is third-party code and has
      // no business seeing PINCH_KEY or an API key it was not given explicitly.
      env: { ...childEnv(), ...this.env, PINCH_MCP_SERVER: this.name },
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    this.child.on("error", (err) => this._failAll(`server "${this.name}" could not start: ${err.message}`));
    this.child.on("exit", (code, signal) => {
      if (!this.closed) {
        this._failAll(`server "${this.name}" exited (${signal || code})${this.stderrTail ? `: ${this.stderrTail.slice(-300)}` : ""}`);
      }
    });

    this.info = await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "quasnooze", version: "1.0.0" },
    });
    this._notify("notifications/initialized", {});

    const listed = await this._request("tools/list", {});
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    return { info: this.info, tools: this.tools };
  }

  _write(message) {
    if (!this.child?.stdin?.writable) throw new Error(`server "${this.name}" is not accepting input`);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _notify(method, params) {
    try {
      this._write({ jsonrpc: "2.0", method, params });
    } catch {
      /* a notification has no reply to lose */
    }
  }

  _request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`server "${this.name}" did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._write({ jsonrpc: "2.0", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  _onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      this.buffer = "";
      return this._failAll(`server "${this.name}" sent a line larger than ${MAX_LINE_BYTES} bytes`);
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue; // a server that logs to stdout is wrong, but not fatal
      }
      if (message.id === undefined || message.id === null) continue; // server-initiated notification
      const entry = this.pending.get(message.id);
      if (!entry) continue;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
    }
  }

  _failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  /** Call a tool and flatten its content blocks into text. */
  async callTool(toolName, args = {}) {
    const result = await this._request("tools/call", { name: toolName, arguments: args });
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .map((block) => {
        if (block?.type === "text") return String(block.text ?? "");
        if (block?.type === "resource") return String(block.resource?.text ?? "");
        if (block?.type) return `[${block.type} content omitted]`;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .slice(0, 12_000);
    return { ok: !result?.isError, output: text || "(the tool returned no text)" };
  }

  async close() {
    this.closed = true;
    this._failAll(`server "${this.name}" closed`);
    try {
      this.child?.stdin?.end();
    } catch {}
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (child.exitCode === null) child.kill("SIGKILL");
        } catch {}
      }, 2000).unref?.();
    }
  }
}

/* ──────────────────────────── configuration ───────────────────────────── */

/**
 * Parse PINCH_MCP into server definitions.
 *
 *   PINCH_MCP="files=npx -y @modelcontextprotocol/server-filesystem /home/me"
 *   PINCH_MCP_TRUSTED="files"
 *
 * Semicolons separate servers, the first `=` splits name from command, and the
 * command is split with a deliberately simple tokeniser — quoting rules that
 * nobody can remember are how a config parser becomes a bug.
 */
export function parseServers(spec, trusted = "") {
  const trustedNames = new Set(String(trusted || "").split(",").map((s) => s.trim()).filter(Boolean));
  const out = [];
  for (const chunk of String(spec || "").split(";")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    if (eq === -1) continue;
    const name = entry.slice(0, eq).trim().replace(/[^a-zA-Z0-9_-]/g, "-");
    const [command, ...args] = entry
      .slice(eq + 1)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!name || !command) continue;
    out.push({ name, command, args, trusted: trustedNames.has(name) });
  }
  return out;
}

const clients = new Map();

/**
 * Turn MCP tools into Quasnooze tools.
 *
 * The name is namespaced (`mcp__files__read_file`) so a third-party server can
 * never shadow a built-in tool — a server that ships a `shell` tool must not be
 * able to intercept calls meant for ours.
 */
export function toQuasnoozeTool(client, definition) {
  const remoteName = definition.name;
  return {
    name: `mcp__${client.name}__${remoteName}`,
    description: `[${client.name} MCP server] ${definition.description || remoteName}`,
    parameters: definition.inputSchema || { type: "object", properties: {} },
    // Third-party code, unless the user said otherwise by name.
    dangerous: !client.trusted,
    mcp: { server: client.name, tool: remoteName },
    async run(args) {
      const result = await client.callTool(remoteName, args || {});
      // Tool output is a prompt-injection surface like any other fetched text.
      return {
        ok: result.ok,
        output: `<untrusted-source tool="mcp__${client.name}__${remoteName}">\n${result.output}\n</untrusted-source>`,
      };
    },
  };
}

/**
 * Start every configured server and register its tools.
 *
 * A server that fails to start is logged and skipped — losing one third-party
 * tool set must never take the assistant down. Returns the tools registered, so
 * the boot log can say what actually arrived.
 */
export async function startMcpTools({ registerTool, log = console, servers = config.mcpServers, spec = config.mcpSpec } = {}) {
  const defs = servers?.length ? servers : parseServers(spec, config.mcpTrusted);
  const registered = [];

  for (const def of defs) {
    const client = new McpClient({ name: def.name, command: def.command, args: def.args, env: def.env, log });
    client.trusted = Boolean(def.trusted);
    try {
      await client.start();
      clients.set(def.name, client);
      for (const definition of client.tools) {
        try {
          registerTool(toQuasnoozeTool(client, definition));
          registered.push(`${client.name}:${definition.name}`);
        } catch (err) {
          log.warn?.(`mcp ${client.name}: could not register ${definition.name} — ${err.message}`);
        }
      }
      log.info?.(
        `mcp ${client.name}: ${client.tools.length} tool(s)${client.trusted ? "" : " (each call needs your approval)"}`,
      );
    } catch (err) {
      await client.close();
      log.warn?.(`mcp ${def.name}: unavailable — ${err.message}`);
    }
  }

  return {
    registered,
    servers: [...clients.keys()],
    async stop() {
      await Promise.all([...clients.values()].map((c) => c.close()));
      clients.clear();
    },
  };
}

/** For tests: the live clients. */
export function mcpClients() {
  return clients;
}

export { RESTART_BACKOFF_MS };

export const MCP_INVENTORY_LIMITS = Object.freeze({
  maxServers: 32,
});

const BARE_MCP_COMMAND_RE = /^[A-Za-z0-9._+-]{1,64}$/;
const PATH_LIKE_MCP_COMMAND_RE =
  /(?:[\\/]|^~(?=$|[\\/])|^\$(?:\{?HOME\}?|USERPROFILE)\b|^%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%|^[A-Za-z]:)/i;

/**
 * Static, execution-free inspection of configured MCP stdio servers.
 *
 * Never spawns server processes or sends JSON-RPC `initialize` / `tools/list`
 * requests. Remote tool names and schemas therefore stay `"unknown"` until the
 * user starts Quasnooze with MCP enabled through the normal consent path.
 */
export function inspectMcpConfig({
  spec = config.mcpSpec,
  trusted = config.mcpTrusted,
  servers = config.mcpServers,
  autoApprove = false,
  maxServers = MCP_INVENTORY_LIMITS.maxServers,
  sanitizeText = (v) => ({ text: String(v ?? ""), redactions: [] }),
  isCredentialKey = () => false,
} = {}) {
  const sourceRedactions = new Set();
  const trustedNames = new Set(
    String(trusted || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const item of trustedNames) {
    for (const kind of sanitizeText(item).redactions) sourceRedactions.add(kind);
  }

  const rawDefs = [];
  let skippedSpecs = 0;
  let configured = false;

  if (Array.isArray(servers) && servers.length > 0) {
    configured = true;
    for (const def of servers) {
      if (!def || typeof def !== "object" || Array.isArray(def)) {
        skippedSpecs += 1;
        continue;
      }
      const rawName = typeof def.name === "string" ? def.name.trim() : "";
      const cleanName = rawName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
      const command = typeof def.command === "string" ? def.command.trim() : "";
      const nameSanitized = sanitizeText(rawName);
      if (!cleanName || !command || nameSanitized.redactions.length > 0) {
        for (const kind of nameSanitized.redactions) sourceRedactions.add(kind);
        skippedSpecs += 1;
        continue;
      }
      rawDefs.push({
        name: cleanName,
        command,
        args: Array.isArray(def.args) ? def.args : [],
        env: def.env && typeof def.env === "object" && !Array.isArray(def.env) ? def.env : null,
        trusted: Boolean(def.trusted) || trustedNames.has(cleanName),
      });
    }
  } else {
    const rawSpec = String(spec || "");
    if (!rawSpec.trim()) {
      return {
        configured: false,
        state: "disabled",
        reason: null,
        trustModel: "external-stdio-mcp-server",
        inspected: false,
        spawned: false,
        executed: false,
        sandboxed: false,
        configuredServers: 0,
        skippedSpecs: 0,
        unusedTrustedNames: trustedNames.size,
        truncated: false,
        dynamicDetails: "unknown-until-started",
        redactions: [...sourceRedactions],
        servers: [],
      };
    }
    configured = true;
    for (const chunk of rawSpec.split(";")) {
      const entry = chunk.trim();
      if (!entry) continue;
      const eq = entry.indexOf("=");
      if (eq === -1) {
        for (const kind of sanitizeText(entry).redactions) sourceRedactions.add(kind);
        skippedSpecs += 1;
        continue;
      }
      const rawName = entry.slice(0, eq).trim();
      const nameSanitized = sanitizeText(rawName);
      const name = rawName.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);
      const [command, ...args] = entry
        .slice(eq + 1)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (!name || !command || isCredentialKey(rawName) || nameSanitized.redactions.length > 0) {
        if (isCredentialKey(rawName)) sourceRedactions.add("credential-field");
        for (const kind of nameSanitized.redactions) sourceRedactions.add(kind);
        for (const kind of sanitizeText(entry.slice(eq + 1)).redactions) sourceRedactions.add(kind);
        skippedSpecs += 1;
        continue;
      }
      rawDefs.push({
        name,
        command,
        args,
        env: null,
        trusted: trustedNames.has(name),
      });
    }
  }

  const seenNames = new Set();
  const matchedTrusted = new Set();
  const inspectedServers = [];
  let truncated = false;

  for (const def of rawDefs) {
    if (seenNames.has(def.name)) {
      skippedSpecs += 1;
      continue;
    }
    if (inspectedServers.length >= maxServers) {
      truncated = true;
      break;
    }
    seenNames.add(def.name);
    if (trustedNames.has(def.name)) matchedTrusted.add(def.name);

    const serverRedactions = new Set();
    let commandKind = "bare";
    let commandDisplay = def.command;
    if (PATH_LIKE_MCP_COMMAND_RE.test(def.command)) {
      commandKind = "path";
      commandDisplay = "[REDACTED_PATH]";
      serverRedactions.add("personal-or-filesystem-path");
      sourceRedactions.add("personal-or-filesystem-path");
    } else {
      const cmdSanitized = sanitizeText(def.command);
      if (!BARE_MCP_COMMAND_RE.test(def.command) || cmdSanitized.redactions.length > 0) {
        commandKind = "redacted";
        commandDisplay = "[REDACTED]";
        for (const kind of cmdSanitized.redactions) {
          serverRedactions.add(kind);
          sourceRedactions.add(kind);
        }
      }
    }

    if (def.args.length > 0) {
      serverRedactions.add("arguments-withheld");
      sourceRedactions.add("arguments-withheld");
      for (const arg of def.args) {
        for (const kind of sanitizeText(String(arg ?? "")).redactions) {
          serverRedactions.add(kind);
          sourceRedactions.add(kind);
        }
      }
    }

    if (def.env) {
      const envEntries = Object.entries(def.env);
      if (envEntries.length > 0) {
        serverRedactions.add("environment-values-withheld");
        sourceRedactions.add("environment-values-withheld");
      }
      for (const [key, val] of envEntries) {
        if (isCredentialKey(key)) {
          serverRedactions.add("credential-field");
          sourceRedactions.add("credential-field");
        }
        for (const kind of sanitizeText(String(val ?? "")).redactions) {
          serverRedactions.add(kind);
          sourceRedactions.add(kind);
        }
      }
    }

    const isTrusted = Boolean(def.trusted);
    const approvalPolicy = isTrusted ? "trusted-opt-out" : "approval-required";
    const effectiveInteractivePolicy = isTrusted
      ? "trusted-opt-out"
      : autoApprove
        ? "auto-approved-by-config"
        : "approval-required";
    const unattendedPolicy = isTrusted ? "allowed" : "refused";

    inspectedServers.push(
      Object.freeze({
        name: def.name,
        namespacePrefix: `mcp__${def.name}__`,
        state: "uninspected",
        spawned: false,
        executed: false,
        transport: "stdio",
        trusted: isTrusted,
        dangerous: !isTrusted,
        approvalPolicy,
        effectiveInteractivePolicy,
        unattendedPolicy,
        sandboxed: false,
        commandKind,
        command: commandDisplay,
        argCount: def.args.length,
        dynamicTools: "unknown",
        toolCount: null,
        redactions: Object.freeze([...serverRedactions]),
      }),
    );
  }

  const unusedTrustedNames = [...trustedNames].filter((name) => !matchedTrusted.has(name)).length;
  const state = !configured
    ? "disabled"
    : inspectedServers.length === 0 && skippedSpecs > 0
      ? "rejected"
      : truncated || skippedSpecs > 0
        ? "partial"
        : "uninspected";

  return {
    configured,
    state,
    reason: !configured
      ? null
      : inspectedServers.length === 0 && skippedSpecs > 0
        ? "invalid-mcp-spec"
        : truncated
          ? "server-limit-reached"
          : null,
    trustModel: "external-stdio-mcp-server",
    inspected: false,
    spawned: false,
    executed: false,
    sandboxed: false,
    configuredServers: inspectedServers.length,
    skippedSpecs,
    unusedTrustedNames,
    truncated,
    dynamicDetails: "unknown-until-started",
    redactions: [...sourceRedactions],
    servers: inspectedServers,
  };
}
