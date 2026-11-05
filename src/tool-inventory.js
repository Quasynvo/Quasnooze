/**
 * tool-inventory.js — read-only static capability and trust inventory.
 *
 * Inspects Quasnooze's four tool mechanisms without importing local JavaScript
 * plugins, executing manifest binaries, probing PATH, spawning MCP servers, or
 * performing network/IPC calls:
 *
 *   1. Shipped built-in tools (`src/tools.js` `TOOLS`)
 *   2. Declarative JSON command manifests (`QUASNOOZE_TOOLS`, `src/custom-tools.js`)
 *   3. Opt-in local JavaScript plugin directory (`QUASNOOZE_TOOLS_DIR`, `src/tools.js`)
 *   4. Stdio MCP server configuration (`QUASNOOZE_MCP` / `QUASNOOZE_MCP_TRUSTED`, `src/mcp.js`)
 *
 * Security invariants:
 *   - Configured, installed, or listed entries are NEVER marked verified safe,
 *     trusted by default, or OS/VM/container sandboxed.
 *   - Dynamic details that require executing code or starting a process (plugin
 *     exports/trust flags, MCP remote tool schemas, binary existence on PATH)
 *     remain explicitly `"unknown"` / unverified.
 *   - Metadata reads enforce byte/entry bounds, reject `..` traversal, symlinks
 *     (direct and ancestor), non-regular files, and protected credential stores,
 *     and redact credential values/fields and personal filesystem paths.
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { config } from "./config.js";
import { normalizeBrandEnv } from "./brand-config.js";
import { describeBuiltinTools, isProtected } from "./tools.js";
import { MANIFEST_LIMITS, inspectManifestData } from "./custom-tools.js";
import { MCP_INVENTORY_LIMITS, inspectMcpConfig } from "./mcp.js";

export const INVENTORY_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  manifestTools: MANIFEST_LIMITS.maxTools,
  pluginEntries: 64,
  mcpServers: MCP_INVENTORY_LIMITS.maxServers,
  pathLength: 512,
  textLength: 200,
});

const CONTROL_CHAR_RE = /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]+/g;
const PATH_STOP_RE = /[\s'"`,;<>()[\]{}]/;

const SECRET_KEY_RE =
  /(?:^|[_.-])(?:pass(?:word|phrase)?|secret|token|api[_.-]?key|auth(?:[_.-]?(?:key|token|header))?|authorization|bearer|cookie|session(?:[_.-]?(?:id|key|token))?|private[_.-]?key|client[_.-]?secret|webhook|access[_.-]?key|signing[_.-]?key|credentials?|pinch[_.-]?key|quasnooze[_.-]?key)(?:$|[_.-])/i;

const CREDENTIAL_FIELD_RE =
  /(?:pass(?:word|phrase)?|secret|token|api[_.-]?key|auth|bearer|cookie|private[_.-]?key|webhook|access[_.-]?key|signing[_.-]?key|credentials?|^env$|^headers?$)/i;

const URL_USERINFO_RE = /([A-Za-z][A-Za-z0-9+.-]{0,15}:\/\/)([^\s/@:]{1,128}:[^\s/@]{1,256})@/g;
const URL_QUERY_PARAM_RE = /([?&])([A-Za-z0-9_.-]{1,64})=([^&#\s"']{1,512})/g;
const AUTH_SCHEME_RE = /\b(Bearer|Basic)([ \t]+)([^\s,;"']+)/gi;
const KEY_ASSIGN_RE =
  /(?<![A-Za-z0-9_.-])(--?[A-Za-z0-9_.-]{1,80}|[A-Za-z_][A-Za-z0-9_.-]{0,79})([ \t]*[=:][ \t]*)(?:"[^"\r\n]{0,512}"|'[^'\r\n]{0,512}'|[^\s,;&"']{1,512})/g;
const CLI_SECRET_FLAG_RE =
  /(?<![A-Za-z0-9_-])(--?[A-Za-z0-9][A-Za-z0-9_-]{0,79})([ \t]+)(?:"[^"\r\n]{0,512}"|'[^'\r\n]{0,512}'|[^\s,;&"'-][^\s,;&"']{0,511})/g;
const KNOWN_TOKEN_RE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|pk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g;

const FILE_URL_RE = /\bfile:\/\/[^\s'"`,;<>()[\]{}]+/gi;
const TILDE_PATH_RE = /(?<=^|[\s'"=:(])~(?:$|[\\/][^\s'"`,;<>()[\]{}]*)/g;
const HOME_VAR_PATH_RE =
  /(?<=^|[\s'"=:(])(?:\$(?:HOME|USERPROFILE)\b|\$\{(?:HOME|USERPROFILE)\}|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|HOMEPATH)%)[^\s'"`,;<>()[\]{}]*/gi;
const WIN_DRIVE_PATH_RE = /(?<=^|[\s'"=:(])[A-Za-z]:[\\/][^\s'"`,;<>()[\]{}]*/g;
const OS_ROOT_PATH_RE =
  /(?<=^|[\s'"=:(])\/(?:home|Users|root|private|var|tmp|etc|opt|usr|mnt|media|srv|proc|sys|dev)(?=$|[\\/.\s'"`,;<>()[\]{}])[^\s'"`,;<>()[\]{}]*/g;
const POSIX_MULTI_SEG_PATH_RE = /(?<=^|[\s'"=:(])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+/g;

export function isCredentialKey(key) {
  const name = String(key || "").trim();
  if (!name) return false;
  return CREDENTIAL_FIELD_RE.test(name) || SECRET_KEY_RE.test(name);
}

export function collectInventorySecrets({ env = process.env, extraSecrets = [] } = {}) {
  const values = new Set();
  const add = (val) => {
    if (typeof val !== "string") return;
    const trimmed = val.trim();
    if (trimmed.length >= 4) values.add(trimmed);
  };

  add(config.authKey);
  add(config.llm?.openaiKey);
  add(config.telegram?.token);
  add(config.discord?.token);
  add(config.slack?.token);
  add(config.slack?.appToken);
  for (const item of extraSecrets) add(item);

  if (env && typeof env === "object") {
    for (const [key, val] of Object.entries(env)) {
      if (SECRET_KEY_RE.test(key)) add(val);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

function collectSensitivePaths({
  home = homedir(),
  workspaceRoots = [],
  dataDir = "",
  customToolsPath = "",
  toolsDir = "",
  extraPaths = [],
} = {}) {
  const paths = new Set();
  const add = (raw) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed.length < 2 || trimmed === "." || /^[\\/]+$/.test(trimmed)) return;
    let end = trimmed.length;
    while (end > 0 && (trimmed[end - 1] === "/" || trimmed[end - 1] === "\\")) {
      end -= 1;
    }
    const clean = trimmed.slice(0, end);
    if (clean.length >= 2 && clean !== ".") {
      paths.add(clean);
      paths.add(clean.replace(/\\/g, "/"));
    }
  };

  add(home);
  add(dataDir);
  add(customToolsPath);
  add(toolsDir);
  for (const root of workspaceRoots) {
    add(root);
    if (typeof root === "string" && root.trim()) {
      const expanded = home ? root.trim().replace(/^~(?=$|[\\/])/, home) : root.trim();
      add(resolve(expanded));
    }
  }
  for (const p of extraPaths) add(p);

  return [...paths].sort((a, b) => b.length - a.length);
}

function replacePathTokenPrefix(text, prefix) {
  if (!prefix || prefix.length < 2) return { text, changed: false };
  let idx = text.indexOf(prefix);
  if (idx === -1) return { text, changed: false };
  let out = "";
  let cursor = 0;
  while (idx !== -1) {
    out += text.slice(cursor, idx);
    let end = idx + prefix.length;
    while (end < text.length && !PATH_STOP_RE.test(text[end])) {
      end += 1;
    }
    let tokenEnd = end;
    let trailing = "";
    while (tokenEnd > idx + prefix.length && (text[tokenEnd - 1] === "." || text[tokenEnd - 1] === ":")) {
      trailing = text[tokenEnd - 1] + trailing;
      tokenEnd -= 1;
    }
    out += `[REDACTED_PATH]${trailing}`;
    cursor = end;
    idx = text.indexOf(prefix, cursor);
  }
  out += text.slice(cursor);
  return { text: out, changed: true };
}

function redactMatchedPath(match) {
  let end = match.length;
  while (end > 2 && (match[end - 1] === "." || match[end - 1] === ":")) {
    end -= 1;
  }
  return `[REDACTED_PATH]${match.slice(end)}`;
}

/**
 * Redact secrets, inline credentials, control/bidi characters, and personal or
 * OS filesystem paths in untrusted metadata text using linear-time patterns.
 */
export function redactInventoryText(
  value,
  {
    secrets = [],
    sensitivePaths = [],
    maxLength = INVENTORY_LIMITS.textLength,
  } = {},
) {
  const redactions = new Set();
  let text = String(value ?? "");

  if (CONTROL_CHAR_RE.test(text)) {
    CONTROL_CHAR_RE.lastIndex = 0;
    text = text.replace(CONTROL_CHAR_RE, " ");
    redactions.add("control-characters");
  }
  text = text.replace(/\s+/g, " ").trim();

  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    if (text.includes(secret)) {
      text = text.split(secret).join("[REDACTED]");
      redactions.add("credential-value");
    }
    const encoded = encodeURIComponent(secret);
    if (encoded.length >= 4 && encoded !== secret && text.includes(encoded)) {
      text = text.split(encoded).join("[REDACTED]");
      redactions.add("credential-value");
    }
  }

  text = text.replace(URL_USERINFO_RE, (_whole, scheme) => {
    redactions.add("credential-pattern");
    return `${scheme}[REDACTED]@`;
  });

  text = text.replace(URL_QUERY_PARAM_RE, (whole, sepChar, key) => {
    if (!SECRET_KEY_RE.test(key)) return whole;
    redactions.add("credential-pattern");
    return `${sepChar}${key}=[REDACTED]`;
  });

  text = text.replace(AUTH_SCHEME_RE, (_whole, scheme, space) => {
    redactions.add("credential-pattern");
    return `${scheme}${space}[REDACTED]`;
  });

  text = text.replace(KEY_ASSIGN_RE, (whole, key, sepText) => {
    const bareKey = key.replace(/^--?/, "");
    if (!SECRET_KEY_RE.test(bareKey)) return whole;
    redactions.add("credential-pattern");
    return `${key}${sepText}[REDACTED]`;
  });

  text = text.replace(CLI_SECRET_FLAG_RE, (whole, flag, space) => {
    const bareFlag = flag.replace(/^--?/, "");
    if (!SECRET_KEY_RE.test(bareFlag)) return whole;
    redactions.add("credential-pattern");
    return `${flag}${space}[REDACTED]`;
  });

  text = text.replace(KNOWN_TOKEN_RE, () => {
    redactions.add("credential-pattern");
    return "[REDACTED]";
  });

  for (const prefix of sensitivePaths) {
    const replaced = replacePathTokenPrefix(text, prefix);
    if (replaced.changed) {
      text = replaced.text;
      redactions.add("personal-or-filesystem-path");
    }
  }

  for (const pattern of [
    FILE_URL_RE,
    TILDE_PATH_RE,
    HOME_VAR_PATH_RE,
    WIN_DRIVE_PATH_RE,
    OS_ROOT_PATH_RE,
    POSIX_MULTI_SEG_PATH_RE,
  ]) {
    text = text.replace(pattern, (match) => {
      redactions.add("personal-or-filesystem-path");
      return redactMatchedPath(match);
    });
  }

  if (Number.isFinite(maxLength) && maxLength > 1 && text.length > maxLength) {
    text = `${text.slice(0, maxLength - 1)}…`;
    redactions.add("truncated");
  }

  return { text, redactions: [...redactions] };
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function sameNonSymlinkPath(abs, real, platform) {
  if (typeof abs !== "string" || typeof real !== "string") return false;
  if (platform === "darwin") {
    const normAbs = abs.replace(/^\/(tmp|var|etc)(?=\/|$)/, "/private/$1");
    return normAbs === real || abs === real;
  }
  if (platform === "win32") {
    const normAbs = abs.replace(/^[a-z]:/, (d) => d.toUpperCase());
    const normReal = real.replace(/^[a-z]:/, (d) => d.toUpperCase());
    return normAbs === normReal;
  }
  return abs === real;
}

function prepareSafeTargetPath(rawPath, { home = homedir() } = {}) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { ok: false, reason: "empty-path", abs: null };
  }
  const trimmed = rawPath.trim();
  if (trimmed.includes("\0") || trimmed.length > INVENTORY_LIMITS.pathLength) {
    return { ok: false, reason: "invalid-path", abs: null };
  }
  if (trimmed.split(/[\\/]+/).includes("..")) {
    return { ok: false, reason: "traversal-rejected", abs: null };
  }
  const expanded = home ? trimmed.replace(/^~(?=$|[\\/])/, home) : trimmed;
  if (expanded.split(/[\\/]+/).includes("..")) {
    return { ok: false, reason: "traversal-rejected", abs: null };
  }
  const abs = resolve(expanded);
  if (isProtected(abs)) {
    return { ok: false, reason: "protected-path-rejected", abs: null };
  }
  return { ok: true, reason: null, abs };
}

function isInsideAnyWorkspace(targetPath, workspaceRoots, { io, home }) {
  for (const ws of workspaceRoots) {
    if (typeof ws !== "string" || !ws.trim()) continue;
    const expanded = home ? ws.trim().replace(/^~(?=$|[\\/])/, home) : ws.trim();
    const wsAbs = resolve(expanded);
    if (isWithin(wsAbs, targetPath)) return true;
    try {
      const wsReal = io.realpathSync(wsAbs);
      if (isWithin(wsReal, targetPath)) return true;
    } catch {}
  }
  return false;
}

function readBoundedManifestFile(
  rawPath,
  {
    io = fs,
    home = homedir(),
    platform = process.platform,
    maxBytes = INVENTORY_LIMITS.manifestBytes,
  } = {},
) {
  const prepared = prepareSafeTargetPath(rawPath, { home });
  if (!prepared.ok) {
    return { status: "rejected", reason: prepared.reason, bytesRead: 0, data: null };
  }
  const { abs } = prepared;
  let fd;
  try {
    const flags =
      (io.constants?.O_RDONLY ?? 0) |
      (io.constants?.O_NOFOLLOW ?? 0) |
      (io.constants?.O_NONBLOCK ?? 0);
    fd = io.openSync(abs, flags);
    const before = io.fstatSync(fd);
    if (typeof before.isSymbolicLink === "function" && before.isSymbolicLink()) {
      return { status: "rejected", reason: "symlink-rejected", bytesRead: 0, data: null };
    }
    if (!before.isFile()) {
      return { status: "rejected", reason: "not-regular-file", bytesRead: 0, data: null };
    }

    let real;
    try {
      real = io.realpathSync(abs);
    } catch {
      return { status: "unavailable", reason: "realpath-unavailable", bytesRead: 0, data: null };
    }
    if (!sameNonSymlinkPath(abs, real, platform)) {
      return { status: "rejected", reason: "symlink-rejected", bytesRead: 0, data: null };
    }
    if (isProtected(real)) {
      return { status: "rejected", reason: "protected-path-rejected", bytesRead: 0, data: null };
    }
    if (platform === "linux") {
      try {
        const fdReal = io.realpathSync(`/proc/self/fd/${fd}`);
        if (fdReal !== real) {
          return { status: "rejected", reason: "symlink-rejected", bytesRead: 0, data: null };
        }
      } catch {
        if (io === fs) {
          return { status: "unavailable", reason: "descriptor-verification-failed", bytesRead: 0, data: null };
        }
      }
    }

    if (before.size > maxBytes) {
      return { status: "rejected", reason: "oversized", bytesRead: 0, data: null };
    }

    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const n = io.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!n) break;
      offset += n;
    }
    const after = io.fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      offset > maxBytes ||
      offset !== before.size
    ) {
      return { status: "unavailable", reason: "concurrent-modification", bytesRead: 0, data: null };
    }

    return {
      status: "ok",
      reason: null,
      bytesRead: offset,
      data: buffer.subarray(0, offset),
    };
  } catch (err) {
    if (err?.code === "ELOOP" || err?.code === "EMLINK") {
      return { status: "rejected", reason: "symlink-rejected", bytesRead: 0, data: null };
    }
    if (err?.code === "EISDIR") {
      return { status: "rejected", reason: "not-regular-file", bytesRead: 0, data: null };
    }
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return { status: "unavailable", reason: "not-found", bytesRead: 0, data: null };
    }
    return { status: "unavailable", reason: "read-failed", bytesRead: 0, data: null };
  } finally {
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {}
    }
  }
}

function inspectCustomManifestSource({
  rawPath,
  reservedNames,
  workspaceRoots,
  home,
  autoApprove,
  io,
  platform,
  maxBytes,
  sanitizeText,
}) {
  if (!rawPath || !String(rawPath).trim()) {
    return {
      configured: false,
      state: "disabled",
      reason: null,
      pathRedacted: false,
      trustModel: "declarative-argv-command",
      trustedOptOutSupported: false,
      inspected: false,
      executed: false,
      sandboxed: false,
      bytesRead: 0,
      declaredTools: 0,
      validTools: 0,
      skippedTools: 0,
      redactions: [],
      warnings: [],
      tools: [],
      skipped: [],
    };
  }

  const readRes = readBoundedManifestFile(rawPath, { io, home, platform, maxBytes });
  if (readRes.status !== "ok") {
    return {
      configured: true,
      state: readRes.status,
      reason: readRes.reason,
      pathRedacted: true,
      trustModel: "declarative-argv-command",
      trustedOptOutSupported: false,
      inspected: false,
      executed: false,
      sandboxed: false,
      bytesRead: 0,
      declaredTools: 0,
      validTools: 0,
      skippedTools: 0,
      redactions: ["personal-or-filesystem-path"],
      warnings: [],
      tools: [],
      skipped: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(readRes.data.toString("utf8"));
  } catch {
    return {
      configured: true,
      state: "rejected",
      reason: "invalid-json",
      pathRedacted: true,
      trustModel: "declarative-argv-command",
      trustedOptOutSupported: false,
      inspected: false,
      executed: false,
      sandboxed: false,
      bytesRead: readRes.bytesRead,
      declaredTools: 0,
      validTools: 0,
      skippedTools: 0,
      redactions: ["personal-or-filesystem-path"],
      warnings: [],
      tools: [],
      skipped: [],
    };
  }

  const inspected = inspectManifestData(parsed, {
    reservedNames,
    workspaceRoots,
    home,
    autoApprove,
    isProtectedPath: isProtected,
    sanitizeText,
    isCredentialKey,
  });

  const redactions = new Set(["personal-or-filesystem-path", ...inspected.redactions]);
  if (!inspected.ok) {
    return {
      configured: true,
      state: "rejected",
      reason: inspected.reason,
      pathRedacted: true,
      trustModel: "declarative-argv-command",
      trustedOptOutSupported: false,
      inspected: false,
      executed: false,
      sandboxed: false,
      bytesRead: readRes.bytesRead,
      declaredTools: inspected.declaredTools,
      validTools: 0,
      skippedTools: 0,
      redactions: [...redactions],
      warnings: inspected.warnings,
      tools: [],
      skipped: [],
    };
  }

  const state =
    inspected.tools.length === 0 && inspected.skipped.length > 0
      ? "rejected"
      : inspected.skipped.length > 0
        ? "partial"
        : "inspected";

  return {
    configured: true,
    state,
    reason: state === "rejected" ? "all-entries-rejected" : null,
    pathRedacted: true,
    trustModel: "declarative-argv-command",
    trustedOptOutSupported: false,
    inspected: true,
    executed: false,
    sandboxed: false,
    bytesRead: readRes.bytesRead,
    declaredTools: inspected.declaredTools,
    validTools: inspected.tools.length,
    skippedTools: inspected.skipped.length,
    redactions: [...redactions],
    warnings: inspected.warnings,
    tools: inspected.tools,
    skipped: inspected.skipped,
  };
}

function inspectLocalPluginsSource({
  rawDir,
  workspaceRoots,
  home,
  io,
  platform,
  maxEntries,
  sanitizeText,
}) {
  const base = {
    configured: Boolean(rawDir && String(rawDir).trim()),
    state: "disabled",
    reason: null,
    pathRedacted: Boolean(rawDir && String(rawDir).trim()),
    trustModel: "in-process-javascript-module",
    inspected: false,
    imported: false,
    executed: false,
    sandboxed: false,
    scannedEntries: 0,
    eligibleModules: 0,
    rejectedEntries: 0,
    ignoredEntries: 0,
    truncated: false,
    dynamicDetails: "unknown-without-import",
    redactions: rawDir && String(rawDir).trim() ? ["personal-or-filesystem-path"] : [],
    candidates: [],
  };

  if (!base.configured) return base;

  const prepared = prepareSafeTargetPath(rawDir, { home });
  if (!prepared.ok) {
    return { ...base, state: "rejected", reason: prepared.reason };
  }
  const { abs } = prepared;

  if (isInsideAnyWorkspace(abs, workspaceRoots, { io, home })) {
    return { ...base, state: "rejected", reason: "inside-workspace-rejected" };
  }

  const redactions = new Set(["personal-or-filesystem-path"]);
  let fd;
  let directory;
  try {
    let opendirTarget = abs;
    if (platform !== "win32") {
      const dirFlags =
        (io.constants?.O_RDONLY ?? 0) |
        (io.constants?.O_NOFOLLOW ?? 0) |
        (io.constants?.O_NONBLOCK ?? 0);
      fd = io.openSync(abs, dirFlags);
      const dirStat = io.fstatSync(fd);
      if (typeof dirStat.isSymbolicLink === "function" && dirStat.isSymbolicLink()) {
        return { ...base, state: "rejected", reason: "symlink-rejected" };
      }
      if (!dirStat.isDirectory()) {
        return { ...base, state: "rejected", reason: "not-directory" };
      }
    }

    let real;
    try {
      real = io.realpathSync(abs);
    } catch (err) {
      if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
        return { ...base, state: "unavailable", reason: "not-found" };
      }
      return { ...base, state: "unavailable", reason: "realpath-unavailable" };
    }

    if (!sameNonSymlinkPath(abs, real, platform)) {
      return { ...base, state: "rejected", reason: "symlink-rejected" };
    }
    if (isProtected(real)) {
      return { ...base, state: "rejected", reason: "protected-path-rejected" };
    }
    if (isInsideAnyWorkspace(real, workspaceRoots, { io, home })) {
      return { ...base, state: "rejected", reason: "inside-workspace-rejected" };
    }

    if (platform === "linux" && fd !== undefined) {
      try {
        const fdReal = io.realpathSync(`/proc/self/fd/${fd}`);
        if (fdReal !== real) {
          return { ...base, state: "rejected", reason: "symlink-rejected" };
        }
        opendirTarget = `/proc/self/fd/${fd}`;
      } catch {
        if (io === fs) {
          return { ...base, state: "unavailable", reason: "descriptor-verification-failed" };
        }
      }
    }

    directory = io.opendirSync(opendirTarget);

    let scannedEntries = 0;
    let eligibleModules = 0;
    let rejectedEntries = 0;
    let ignoredEntries = 0;
    let truncated = false;
    const candidates = [];

    while (true) {
      const entry = directory.readSync();
      if (!entry) break;
      if (scannedEntries >= maxEntries) {
        truncated = true;
        break;
      }
      scannedEntries += 1;

      if (!/\.(?:mjs|js)$/.test(entry.name)) {
        ignoredEntries += 1;
        continue;
      }

      const cleanModule = sanitizeText(entry.name, { maxLength: 80 });
      for (const kind of cleanModule.redactions) redactions.add(kind);

      let isSymlink = typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink();
      let isFile = typeof entry.isFile === "function" && entry.isFile();
      let isDir = typeof entry.isDirectory === "function" && entry.isDirectory();
      if (!isSymlink && !isFile && !isDir && typeof io.lstatSync === "function") {
        try {
          const entryStat = io.lstatSync(resolve(real, entry.name));
          isSymlink = entryStat.isSymbolicLink();
          isFile = entryStat.isFile();
        } catch {
          isSymlink = false;
          isFile = false;
        }
      }

      if (isSymlink) {
        rejectedEntries += 1;
        candidates.push(
          Object.freeze({
            module: cleanModule.text,
            state: "rejected-symlink",
            eligible: false,
            imported: false,
            executed: false,
            toolName: "unknown",
            parameters: "unknown",
            declaredTrust: "unknown",
            approvalPolicy: "rejected-not-loadable",
            unattendedPolicy: "rejected-not-loadable",
            startupSideEffects: "not-loaded-symlink-refused",
            sandboxed: false,
            redactions: Object.freeze(cleanModule.redactions),
          }),
        );
      } else if (!isFile) {
        rejectedEntries += 1;
        candidates.push(
          Object.freeze({
            module: cleanModule.text,
            state: "rejected-non-regular",
            eligible: false,
            imported: false,
            executed: false,
            toolName: "unknown",
            parameters: "unknown",
            declaredTrust: "unknown",
            approvalPolicy: "rejected-not-loadable",
            unattendedPolicy: "rejected-not-loadable",
            startupSideEffects: "not-loaded-non-regular-refused",
            sandboxed: false,
            redactions: Object.freeze(cleanModule.redactions),
          }),
        );
      } else {
        eligibleModules += 1;
        candidates.push(
          Object.freeze({
            module: cleanModule.text,
            state: "uninspected",
            eligible: true,
            imported: false,
            executed: false,
            toolName: "unknown",
            parameters: "unknown",
            declaredTrust: "unknown",
            approvalPolicy: "unknown-defaults-to-approval-required",
            unattendedPolicy: "unknown-defaults-to-refused",
            startupSideEffects: "unverified-executes-on-normal-boot-before-approval",
            sandboxed: false,
            redactions: Object.freeze(cleanModule.redactions),
          }),
        );
      }
    }

    candidates.sort((a, b) => a.module.localeCompare(b.module));

    return {
      configured: true,
      state: truncated ? "partial" : "uninspected",
      reason: truncated ? "entry-limit-reached" : null,
      pathRedacted: true,
      trustModel: "in-process-javascript-module",
      inspected: false,
      imported: false,
      executed: false,
      sandboxed: false,
      scannedEntries,
      eligibleModules,
      rejectedEntries,
      ignoredEntries,
      truncated,
      dynamicDetails: "unknown-without-import",
      redactions: [...redactions],
      candidates,
    };
  } catch (err) {
    if (err?.code === "ELOOP" || err?.code === "EMLINK") {
      return { ...base, state: "rejected", reason: "symlink-rejected" };
    }
    if (err?.code === "ENOTDIR") {
      return { ...base, state: "rejected", reason: "not-directory" };
    }
    if (err?.code === "ENOENT") {
      return { ...base, state: "unavailable", reason: "not-found" };
    }
    return { ...base, state: "unavailable", reason: "read-failed" };
  } finally {
    if (directory) {
      try {
        directory.closeSync();
      } catch {}
    }
    if (fd !== undefined) {
      try {
        io.closeSync(fd);
      } catch {}
    }
  }
}

function readBoolEnv(map, key, fallback) {
  const raw = map?.[key];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function resolveEffectiveSettings(options) {
  if (!options.env) {
    return {
      workspaceRoots: options.workspaceRoots ?? config.workspaceRoots,
      dataDir: options.dataDir ?? config.dataDir,
      customToolsPath: options.customToolsPath ?? config.customToolsPath,
      toolsDir: options.toolsDir ?? config.toolsDir,
      mcpSpec: options.mcpSpec ?? config.mcpSpec,
      mcpTrusted: options.mcpTrusted ?? config.mcpTrusted,
      mcpServers: options.mcpServers ?? config.mcpServers,
      desktopMode: options.desktopMode ?? Boolean(config.desktopRequested),
      autoApprove:
        options.autoApprove !== undefined
          ? Boolean(options.autoApprove) && !(options.desktopMode ?? Boolean(config.desktopRequested))
          : Boolean(config.autoApprove),
      riskTiers: options.riskTiers ?? Boolean(config.riskTiers),
      scheduledRuns: options.scheduledRuns ?? Boolean(config.scheduledRuns),
      envForSecrets: process.env,
    };
  }

  const normalized = normalizeBrandEnv({ ...options.env });
  const get = (key) => (typeof normalized[key] === "string" ? normalized[key].trim() : "");
  const desktopMode =
    options.desktopMode ?? readBoolEnv(normalized, "PINCH_DESKTOP", false);
  const rawAutoApprove =
    options.autoApprove ?? readBoolEnv(normalized, "PINCH_AUTO_APPROVE", false);
  const wsRaw = get("PINCH_WORKSPACE");
  const workspaceRoots =
    options.workspaceRoots ??
    (wsRaw
      ? wsRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : config.workspaceRoots);

  return {
    workspaceRoots,
    dataDir: options.dataDir ?? (get("PINCH_DATA") || config.dataDir),
    customToolsPath: options.customToolsPath ?? get("PINCH_TOOLS"),
    toolsDir: options.toolsDir ?? get("PINCH_TOOLS_DIR"),
    mcpSpec: options.mcpSpec ?? get("PINCH_MCP"),
    mcpTrusted: options.mcpTrusted ?? get("PINCH_MCP_TRUSTED"),
    mcpServers: options.mcpServers ?? [],
    desktopMode,
    autoApprove: desktopMode ? false : Boolean(rawAutoApprove),
    riskTiers: options.riskTiers ?? readBoolEnv(normalized, "PINCH_RISK_TIERS", true),
    scheduledRuns: options.scheduledRuns ?? readBoolEnv(normalized, "PINCH_SCHEDULED_RUNS", true),
    envForSecrets: normalized,
  };
}

/**
 * Build a read-only static capability and trust inventory report.
 */
export function buildToolInventory(options = {}) {
  const {
    io = fs,
    home = homedir(),
    platform = process.platform,
    limits = {},
    extraSecrets = [],
    extraPaths = [],
  } = options;

  const effectiveLimits = Object.freeze({
    manifestBytes: limits.manifestBytes ?? INVENTORY_LIMITS.manifestBytes,
    manifestTools: INVENTORY_LIMITS.manifestTools,
    pluginEntries: limits.pluginEntries ?? INVENTORY_LIMITS.pluginEntries,
    mcpServers: limits.mcpServers ?? INVENTORY_LIMITS.mcpServers,
    pathLength: INVENTORY_LIMITS.pathLength,
    textLength: limits.textLength ?? INVENTORY_LIMITS.textLength,
  });

  const settings = resolveEffectiveSettings(options);
  const secrets = collectInventorySecrets({ env: settings.envForSecrets, extraSecrets });
  const sensitivePaths = collectSensitivePaths({
    home,
    workspaceRoots: settings.workspaceRoots,
    dataDir: settings.dataDir,
    customToolsPath: settings.customToolsPath,
    toolsDir: settings.toolsDir,
    extraPaths,
  });

  const sanitizeText = (val, localOpts = {}) =>
    redactInventoryText(val, {
      secrets,
      sensitivePaths,
      maxLength: localOpts.maxLength ?? effectiveLimits.textLength,
    });

  const builtinTools = describeBuiltinTools({
    riskTiers: settings.riskTiers,
    autoApprove: settings.autoApprove,
  });
  const builtinDangerous = builtinTools.filter((t) => t.dangerous).length;
  const reservedNames = new Set(builtinTools.map((t) => t.name));

  const customManifest = inspectCustomManifestSource({
    rawPath: settings.customToolsPath,
    reservedNames,
    workspaceRoots: settings.workspaceRoots,
    home,
    autoApprove: settings.autoApprove,
    io,
    platform,
    maxBytes: effectiveLimits.manifestBytes,
    sanitizeText,
  });

  const localPlugins = inspectLocalPluginsSource({
    rawDir: settings.toolsDir,
    workspaceRoots: settings.workspaceRoots,
    home,
    io,
    platform,
    maxEntries: effectiveLimits.pluginEntries,
    sanitizeText,
  });

  const mcp = inspectMcpConfig({
    spec: settings.mcpSpec,
    trusted: settings.mcpTrusted,
    servers: settings.mcpServers,
    autoApprove: settings.autoApprove,
    maxServers: effectiveLimits.mcpServers,
    sanitizeText,
    isCredentialKey,
  });

  const hasDegradedSource = [customManifest.state, localPlugins.state, mcp.state].some((s) =>
    ["rejected", "unavailable", "partial"].includes(s),
  );

  const limitations = [
    "Configured, installed or listed entries are neither verified safe, trusted by default, nor OS/VM/container sandboxed.",
    "Built-in workspace path checks guard file tools only; shell, local plugins, custom manifests and MCP servers run with your OS user permissions once invoked.",
    "Local JS plugins (QUASNOOZE_TOOLS_DIR) are NOT imported by this inventory; on normal startup, module top-level code runs in-process before any tool approval prompt.",
    "Custom manifest tools (QUASNOOZE_TOOLS) are NOT executed and PATH binaries are not probed here; manifest tools always require approval and cannot declare trusted:true.",
    "MCP servers (QUASNOOZE_MCP) are NOT spawned or queried here; remote tool lists and schemas remain unknown until enabled through normal startup.",
  ];
  if (settings.autoApprove) {
    limitations.push(
      "QUASNOOZE_AUTO_APPROVE=true is active: interactive dangerous tool calls skip the human approval prompt (unattended scheduled runs still refuse dangerous tools).",
    );
  }

  return {
    schemaVersion: 1,
    kind: "quasnooze-tool-inventory",
    mode: "static-read-only",
    status: hasDegradedSource ? "partial" : "ok",
    executedAnyCode: false,
    spawnedAnyProcess: false,
    networkRequests: 0,
    osSandboxed: false,
    limits: effectiveLimits,
    policy: {
      autoApprove: settings.autoApprove,
      desktopMode: settings.desktopMode,
      riskTiers: settings.riskTiers,
      scheduledRuns: settings.scheduledRuns,
      workspaceRootCount: settings.workspaceRoots.length,
      interactiveGate: settings.autoApprove
        ? "bypassed-by-auto-approve-config"
        : "dangerous-tools-require-human-approval",
      shellRiskTierNote: settings.autoApprove
        ? "Auto-approve is enabled; interactive shell calls do not pause for approval."
        : settings.riskTiers
          ? "Allowlisted read-only workspace shell commands skip the prompt; other shell commands ask and screened catastrophes are blocked."
          : "Every interactive shell command requires explicit human approval.",
      unattendedGate:
        "Unattended scheduled runs refuse all dangerous tools (and cannot create schedules), even if QUASNOOZE_AUTO_APPROVE=true.",
    },
    sources: {
      builtin: {
        configured: true,
        state: "enabled",
        trustModel: "shipped-in-process-code",
        inspected: true,
        executed: false,
        sandboxed: false,
        total: builtinTools.length,
        dangerousCount: builtinDangerous,
        nonDangerousCount: builtinTools.length - builtinDangerous,
        tools: builtinTools,
      },
      customManifest,
      localPlugins,
      mcp,
    },
    limitations,
  };
}

/**
 * Format a `buildToolInventory()` report as concise plain text for terminal or
 * chat `/tools` inspection.
 */
export function renderToolInventory(report) {
  const { policy, sources } = report;
  const lines = [
    "Tool capability & trust inventory (read-only; no plugins imported, no commands or MCP servers run)",
    `Status: ${report.status} · OS sandbox: none`,
    `Policy: interactive=${policy.interactiveGate} · riskTiers=${policy.riskTiers ? "on" : "off"} · autoApprove=${policy.autoApprove ? "on" : "off"}${policy.desktopMode ? " (desktop-forced-off)" : ""} · scheduledRuns=${policy.scheduledRuns ? "on" : "off"}`,
    "",
  ];

  // 1. Built-in tools
  const builtin = sources.builtin;
  const gatedBuiltins = builtin.tools.filter((t) => t.dangerous);
  const openBuiltins = builtin.tools.filter((t) => !t.dangerous);
  lines.push(
    `1. Built-in tools (${builtin.state} · ${builtin.trustModel} · ${builtin.total} total, ${builtin.dangerousCount} dangerous · not sandboxed)`,
  );
  for (const tool of gatedBuiltins) {
    lines.push(
      `   - ${tool.name}: ${tool.effectiveInteractivePolicy} (declared=${tool.approvalPolicy}, unattended=${tool.unattendedPolicy}) — ${tool.boundary}`,
    );
  }
  lines.push(
    `   - ${openBuiltins.length} non-dangerous built-in tools (no-prompt, unattended=allowed): ${openBuiltins.map((t) => t.name).join(", ")}`,
  );
  lines.push("");

  // 2. Custom JSON manifest
  const manifest = sources.customManifest;
  lines.push(
    `2. Custom JSON command manifest [QUASNOOZE_TOOLS] (${manifest.state}${manifest.reason ? `: ${manifest.reason}` : ""} · ${manifest.trustModel})`,
  );
  if (!manifest.configured) {
    lines.push(
      "   - Not configured. Declarative argv commands always require approval (trusted opt-out unsupported).",
    );
  } else {
    lines.push(
      `   - Path: [REDACTED_PATH] · valid=${manifest.validTools} · skipped=${manifest.skippedTools} · executed=false · binaryVerified=false · not sandboxed`,
    );
    for (const tool of manifest.tools) {
      lines.push(
        `   - ${tool.name}: ${tool.effectiveInteractivePolicy} (unattended=${tool.unattendedPolicy}) · cmd=${tool.command} (${tool.argCount} arg(s) withheld, params=${tool.parameters.length}) — ${tool.description}`,
      );
    }
    for (const skip of manifest.skipped) {
      lines.push(`   - skipped ${skip.name}: ${skip.reason}`);
    }
    for (const warn of manifest.warnings) {
      lines.push(`   - warning: ${warn}`);
    }
  }
  lines.push("");

  // 3. Local JS plugins
  const plugins = sources.localPlugins;
  lines.push(
    `3. Local JS plugins [QUASNOOZE_TOOLS_DIR] (${plugins.state}${plugins.reason ? `: ${plugins.reason}` : ""} · ${plugins.trustModel})`,
  );
  if (!plugins.configured) {
    lines.push(
      "   - Not configured. Local JS modules run unsandboxed in-process when enabled.",
    );
  } else {
    lines.push(
      `   - Path: [REDACTED_PATH] · scanned=${plugins.scannedEntries} · eligible=${plugins.eligibleModules} · rejected=${plugins.rejectedEntries} · imported=false · not sandboxed`,
    );
    if (plugins.candidates.length === 0 && plugins.state === "uninspected") {
      lines.push("   - No .js/.mjs module files found in directory.");
    }
    for (const mod of plugins.candidates) {
      if (mod.eligible) {
        lines.push(
          `   - ${mod.module}: uninspected (toolName=unknown, declaredTrust=unknown, default=approval-required; top-level JS runs on normal boot before approval)`,
        );
      } else {
        lines.push(`   - ${mod.module}: ${mod.state} (not loadable)`);
      }
    }
  }
  lines.push("");

  // 4. MCP stdio servers
  const mcp = sources.mcp;
  lines.push(
    `4. MCP stdio servers [QUASNOOZE_MCP] (${mcp.state}${mcp.reason ? `: ${mcp.reason}` : ""} · ${mcp.trustModel})`,
  );
  if (!mcp.configured) {
    lines.push(
      `   - Not configured.${mcp.unusedTrustedNames > 0 ? ` (${mcp.unusedTrustedNames} unused QUASNOOZE_MCP_TRUSTED entry/entries set)` : ""}`,
    );
  } else {
    lines.push(
      `   - Configured servers=${mcp.configuredServers} · skippedSpecs=${mcp.skippedSpecs} · unusedTrusted=${mcp.unusedTrustedNames} · spawned=false · remoteTools=unknown · not sandboxed`,
    );
    for (const srv of mcp.servers) {
      lines.push(
        `   - ${srv.name} (${srv.namespacePrefix}*): ${srv.effectiveInteractivePolicy} (declared=${srv.approvalPolicy}, unattended=${srv.unattendedPolicy}) · cmd=${srv.command} (${srv.argCount} arg(s) withheld) · tools=unknown`,
      );
    }
  }
  lines.push("");

  lines.push("Limitations:");
  for (const item of report.limitations) {
    lines.push(`- ${item}`);
  }

  return lines.join("\n");
}
