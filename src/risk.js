/**
 * risk.js — which shell commands may run without asking.
 *
 * The problem this solves is named in docs/AUDIT.md: approval fatigue. When
 * `ls` costs the same attention as `rm -rf`, a person answers both on reflex,
 * and the gate stops being a gate. Measured across 14 comparable assistants,
 * the ones that solved it did it with tiers (zeroclaw: medium-risk asks, high-risk
 * is blocked). This is that idea, implemented the opposite way round from a
 * denylist.
 *
 * THE ONLY SAFE DEFAULT IS A LIST OF THINGS, NOT A LIST OF EXCEPTIONS:
 *
 *   read     positively proven read-only, inside the workspace -> runs, no prompt
 *   act      anything else, including anything unrecognised       -> asks
 *   blocked  the existing catastrophic-command screen             -> refused outright
 *
 * Every rule here fails closed. A command with a pipe, a redirect, a `;`, a
 * `$(`, a backtick or an unknown flag is `act` — because reading the first word
 * and hoping is exactly how `ls; rm -rf ~` gets waved through.
 *
 * The argument that makes auto-allowing `read` acceptable at all: these
 * commands are *already* possible without a prompt through read_file, list_dir
 * and grep. This does not add a capability; it stops charging a human's
 * attention for one they already have. And the moment a path leaves the
 * workspace, the tier drops back to `act` — because `cat /etc/passwd` through
 * the shell is a capability those tools do NOT have.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";

export const READ = "read";
export const ACT = "act";
export const BLOCKED = "blocked";

/**
 * Characters that can start a second command, expand into one, or redirect
 * output. If any appears, this is not a read.
 *
 * `*` and `?` are deliberately allowed: glob expansion of filenames cannot
 * execute anything, and rejecting them would reject `ls *.js` for no gain.
 */
const SHELL_METACHAR = /[;&|<>`$(){}\n\r\\!]/;

/**
 * The allowlist. A command is readable only if its first word is a key here,
 * and every flag it carries is in that key's list.
 *
 * `git` is by subcommand and each subcommand's flags are curated. `git diff`,
 * `git show` and `git log -p/--stat` are NOT in it: they run textconv and
 * external diff drivers declared in `.gitattributes`, which execute code from
 * inside the repository being inspected. A read-only list that includes a
 * command able to run a repo's own code is not read-only.
 */
const SAFE = new Map([
  ["ls", { flags: ["-l", "-a", "-la", "-al", "-lh", "-lah", "-1", "-h", "-t", "-r", "-S", "-R", "-A"] }],
  ["pwd", { flags: [] }],
  ["cat", { flags: ["-n", "-A", "-b", "-s"] }],
  ["head", { flags: ["-n", "-c"] }],
  ["tail", { flags: ["-n", "-c"] }],
  ["wc", { flags: ["-l", "-w", "-c"] }],
  ["stat", { flags: [] }],
  ["file", { flags: ["-b", "-i"] }],
  ["du", { flags: ["-s", "-h", "-sh", "-a"] }],
  ["grep", { flags: ["-n", "-i", "-r", "-R", "-l", "-c", "-v", "-E", "-F", "-w", "-rn", "-ri", "-in", "-rni"] }],
  ["which", { flags: [] }],
  ["node", { subcommands: ["--version", "-v"] }],
  ["npm", { subcommands: ["--version", "-v"] }],
  ["python3", { subcommands: ["--version", "-V"] }],
  ["git", {
    subcommands: ["status", "log", "branch", "remote"],
    // Per subcommand. Anything diff-shaped is absent on purpose: see above.
    flags: {
      status: ["--short", "-s", "--porcelain", "--branch", "-b"],
      log: ["--oneline", "-n", "--max-count", "--decorate", "--graph", "--all", "--no-color", "--author", "--grep", "--since", "--until", "-5", "-10", "-20", "-1"],
      branch: ["-a", "-r", "-v", "--all", "--remotes", "--list"],
      remote: ["-v"],
    },
  }],
]);

/** The catastrophic screen from tools.js, applied before anything else. */
function screen(command) {
  const flat = String(command).replace(/\s+/g, " ").trim();
  const DENY = [
    /\brm\s+(-[a-zA-Z]*\s+)*\/\s*$/,
    /\brm\s+-[a-eg-qs-zA-EG-QS-Z]*[rf][a-zA-Z]*\s+(\/|~|\$HOME|\$\{HOME\})(?:\s*\/)?(?:\s*(\*))?\s*$/,
    /\b(mkfs|fdisk|parted)\b/,
    /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|disk|hd)/,
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    /\b(shutdown|reboot|halt|poweroff)\b/,
    /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python|node|perl)\b/,
  ];
  return DENY.some((re) => re.test(flat));
}

function insideWorkspace(path, roots) {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // It may not exist yet; fall back to the literal path for the prefix test.
  }
  return roots.some((root) => path === root || path.startsWith(root + "/") || real === root || real.startsWith(root + "/"));
}

/**
 * @param {string} command
 * @param {object} [opts]
 * @param {string[]} [opts.workspaceRoots] absolutes this turn may read
 * @param {string} [opts.cwd] where the command will actually run. The shell tool
 *   accepts an arbitrary cwd, so `cat x` is only inside the workspace if the cwd
 *   is. Ignoring this would let `{command:"cat id_rsa", cwd:"/home/me/.ssh"}`
 *   classify as read-only.
 * @returns {{tier: "read"|"act"|"blocked", why: string}}
 */
export function classifyCommand(command, { workspaceRoots = [], cwd } = {}) {
  const raw = String(command || "").trim();
  if (!raw) return { tier: ACT, why: "empty command" };

  if (screen(raw)) return { tier: BLOCKED, why: "refused by the catastrophic-command screen" };
  const actResult = (why) => {
    const commit = detectShellCommitProposal(raw);
    return commit ? { tier: ACT, why, commit: true } : { tier: ACT, why };
  };
  if (SHELL_METACHAR.test(raw)) {
    return actResult("contains a shell metacharacter (pipe, redirect, chain, or substitution)");
  }

  const words = raw.split(/\s+/);
  const name = words[0];
  const spec = SAFE.get(name);
  // Where relative paths will land. An absolute cwd outside the workspace makes
  // every relative argument an escape, so it fails closed here rather than per path.
  const base = cwd
    ? (isAbsolute(cwd) ? cwd : resolvePath(workspaceRoots[0] || process.cwd(), cwd))
    : workspaceRoots[0] || process.cwd();
  if (spec && workspaceRoots.length && !insideWorkspace(base, workspaceRoots)) {
    return actResult(`the working directory "${base}" is outside the workspace`);
  }
  if (!spec) return actResult(`"${name}" is not on the read-only list`);

  // Version probes: exactly one argument, and it must be the version flag.
  if (spec.subcommands && name !== "git") {
    if (words.length === 2 && spec.subcommands.includes(words[1])) {
      return { tier: READ, why: `${name} ${words[1]} prints a version` };
    }
    return actResult(`${name} with anything but a version flag`);
  }

  let rest = words.slice(1);
  let flagsAllowed = spec.flags || [];

  if (name === "git") {
    const sub = rest[0];
    if (!sub || !spec.subcommands.includes(sub)) {
      return actResult(sub ? `git ${sub} is not on the read-only list` : "git with no subcommand");
    }
    flagsAllowed = spec.flags[sub] || [];
    rest = rest.slice(1);
  }

  for (let i = 0; i < rest.length; i++) {
    const w = rest[i];
    if (w.startsWith("-")) {
      // `-n 20` and `--max-count 20` are allowed: the flag is listed, the value
      // is the next word and carries no flags of its own.
      if (flagsAllowed.includes(w)) continue;
      if (flagsAllowed.includes(w.split("=")[0])) continue;
      return actResult(`flag "${w}" is not on ${name}'s read-only list`);
    }
    // A path-shaped argument must stay inside the workspace, exactly like
    // read_file. Everything else is a plain word (a grep pattern, a branch name).
    // Any word that could name a file is resolved the way the shell would:
    // against the cwd. `../etc/x`, `/etc/passwd` and `sub/dir` are all paths;
    // a bare word is a grep pattern or a branch name and names no file.
    const looksLikePath = w.startsWith("/") || w.startsWith("~") || w.includes("/") || /\.[a-z0-9]{1,8}$/i.test(w);
    if (!looksLikePath) continue;
    const path = resolvePath(base, w.replace(/^~(?=$|\/)/, homedir()));
    if (workspaceRoots.length && !insideWorkspace(path, workspaceRoots)) {
      return actResult(`"${w}" resolves outside the workspace (${path})`);
    }
  }

  return { tier: READ, why: `${name} is read-only here` };
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const GIT_GLOBAL_ARG_FLAGS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);
const GIT_COMMIT_VALUE_FLAGS = new Set([
  "-m",
  "--message",
  "-F",
  "--file",
  "-C",
  "--reuse-message",
  "-c",
  "--reedit-message",
  "--author",
  "--date",
  "--cleanup",
  "--fixup",
  "--squash",
]);
const READONLY_COMMIT_VERBS = new Set([
  "get",
  "list",
  "read",
  "show",
  "search",
  "find",
  "view",
  "log",
  "diff",
  "status",
  "inspect",
  "check",
  "fetch",
]);

const NO_COMMIT = Object.freeze({
  isCommit: false,
  kind: null,
  vcs: null,
  subcommand: null,
  flags: Object.freeze([]),
  bypassesHooks: false,
  amendsHistory: false,
  why: null,
});

function normalizeBinName(raw) {
  const token = String(raw || "").trim();
  if (!token) return "";
  const slash = Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\"));
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/i, "");
}

function tokenizeShellSegments(command, depth = 0) {
  const src = String(command || "").slice(0, 8192);
  if (!src.trim() || depth > 3) return [];

  const segments = [];
  const substitutions = [];
  let tokens = [];
  let cur = "";
  let hasChars = false;
  let inSingle = false;
  let inDouble = false;

  const flushToken = () => {
    if (hasChars) {
      tokens.push(cur);
      cur = "";
      hasChars = false;
    }
  };
  const flushSegment = () => {
    flushToken();
    if (tokens.length > 0) {
      segments.push(tokens);
      tokens = [];
    }
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 < src.length) {
        cur += src[i + 1];
        hasChars = true;
        i += 1;
      }
      continue;
    }

    if (ch === "$" && src[i + 1] === "(") {
      let parenDepth = 1;
      let j = i + 2;
      let subSingle = false;
      let subDouble = false;
      while (j < src.length && parenDepth > 0) {
        const c = src[j];
        if (subSingle) {
          if (c === "'") subSingle = false;
        } else if (c === "\\") {
          j += 1;
        } else if (c === "'" && !subDouble) {
          subSingle = true;
        } else if (c === '"') {
          subDouble = !subDouble;
        } else if (!subDouble && c === "(") {
          parenDepth += 1;
        } else if (!subDouble && c === ")") {
          parenDepth -= 1;
          if (parenDepth === 0) break;
        }
        j += 1;
      }
      substitutions.push(src.slice(i + 2, j));
      cur += "$()";
      hasChars = true;
      i = j;
      continue;
    }

    if (ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== "`") {
        if (src[j] === "\\") j += 1;
        j += 1;
      }
      substitutions.push(src.slice(i + 1, j));
      cur += "``";
      hasChars = true;
      i = j;
      continue;
    }

    if (ch === '"') {
      inDouble = !inDouble;
      hasChars = true;
      continue;
    }

    if (!inDouble) {
      if (ch === "'") {
        inSingle = true;
        hasChars = true;
        continue;
      }
      if (ch === " " || ch === "\t") {
        flushToken();
        continue;
      }
      if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
        flushSegment();
        continue;
      }
      if (ch === ">" || ch === "<") {
        flushToken();
        continue;
      }
    }

    cur += ch;
    hasChars = true;
  }

  flushSegment();
  for (const sub of substitutions) {
    for (const seg of tokenizeShellSegments(sub, depth + 1)) {
      segments.push(seg);
    }
  }
  return segments;
}

function collectGitCommitFlags(tokens) {
  const flags = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "--") break;
    if (!tok.startsWith("-") || tok === "-") continue;
    if (tok.startsWith("--")) {
      const flagName = tok.split("=")[0];
      if (
        [
          "--amend",
          "--no-verify",
          "--all",
          "--signoff",
          "--allow-empty",
          "--gpg-sign",
          "--no-gpg-sign",
        ].includes(flagName)
      ) {
        flags.add(flagName);
      }
      if (!tok.includes("=") && GIT_COMMIT_VALUE_FLAGS.has(flagName)) {
        i += 1;
      }
      continue;
    }

    // Short option cluster like `-am`, `-an`, `-n`, `-S`
    const cluster = tok.slice(1);
    let consumesNext = false;
    for (let k = 0; k < cluster.length; k += 1) {
      const ch = cluster[k];
      if (ch === "a") flags.add("-a");
      else if (ch === "n") flags.add("-n");
      else if (ch === "s") flags.add("-s");
      else if (ch === "m" || ch === "F" || ch === "C" || ch === "c") {
        // Value is either the rest of this cluster (`-mfix`) or the next token (`-m "fix"`).
        if (k === cluster.length - 1) consumesNext = true;
        break;
      }
    }
    if (consumesNext) i += 1;
  }
  return [...flags].slice(0, 16);
}

function inspectTokensForCommit(tokens, depth = 0) {
  if (!Array.isArray(tokens) || tokens.length === 0 || depth > 3) return null;

  let i = 0;
  while (i < tokens.length) {
    const cur = tokens[i];
    if (ENV_ASSIGN_RE.test(cur)) {
      i += 1;
      continue;
    }
    const head = normalizeBinName(cur);
    if (head === "env") {
      i += 1;
      while (i < tokens.length) {
        const t = tokens[i];
        if (ENV_ASSIGN_RE.test(t)) {
          i += 1;
          continue;
        }
        if (t === "-u" || t === "-C" || t === "-S") {
          i += 2;
          continue;
        }
        if (t === "--") {
          i += 1;
          break;
        }
        if (t.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (head === "command" || head === "builtin") {
      i += 1;
      if (tokens[i] === "-v" || tokens[i] === "-V") return null;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const stop = tokens[i] === "--";
        i += 1;
        if (stop) break;
      }
      continue;
    }
    if (head === "nohup" || head === "time") {
      i += 1;
      if (tokens[i] === "-p") i += 1;
      continue;
    }
    if (head === "nice") {
      i += 1;
      if (tokens[i] === "-n") i += 2;
      else if (tokens[i]?.startsWith("-")) i += 1;
      continue;
    }
    if (head === "sudo") {
      i += 1;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const t = tokens[i];
        if (["-u", "-g", "-C", "-D", "-R", "-T", "-h", "-p", "-r", "-t"].includes(t)) {
          i += 2;
        } else {
          i += 1;
          if (t === "--") break;
        }
      }
      continue;
    }
    break;
  }

  if (i >= tokens.length) return null;
  const bin = normalizeBinName(tokens[i]);

  if (SHELL_WRAPPERS.has(bin)) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      const tok = tokens[j];
      if (tok === "--command" || /^-[a-bd-zA-Z]*c[a-zA-Z]*$/.test(tok)) {
        if (j + 1 < tokens.length) {
          return detectShellCommitProposal(tokens[j + 1], depth + 1);
        }
        return null;
      }
      if (!tok.startsWith("-")) break;
    }
    return null;
  }

  if (bin === "cmd") {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (/^\/[cCkK]$/.test(tokens[j]) && j + 1 < tokens.length) {
        return detectShellCommitProposal(tokens.slice(j + 1).join(" "), depth + 1);
      }
    }
    return null;
  }

  if (bin === "powershell" || bin === "pwsh") {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (/^-(?:c|command)$/i.test(tokens[j]) && j + 1 < tokens.length) {
        return detectShellCommitProposal(tokens[j + 1], depth + 1);
      }
    }
    return null;
  }

  if (bin === "git") {
    let j = i + 1;
    while (j < tokens.length) {
      const tok = tokens[j];
      if (tok === "--version" || tok === "-v" || tok === "--help" || tok === "-h") return null;
      if (GIT_GLOBAL_ARG_FLAGS.has(tok)) {
        j += 2;
        continue;
      }
      if (tok === "--") {
        j += 1;
        break;
      }
      if (tok.startsWith("-")) {
        j += 1;
        continue;
      }
      break;
    }
    const sub = tokens[j];
    if (sub === "commit" || sub === "commit-tree") {
      const flags = collectGitCommitFlags(tokens.slice(j + 1));
      const bypassesHooks = flags.includes("--no-verify") || flags.includes("-n");
      const amendsHistory = flags.includes("--amend");
      return Object.freeze({
        isCommit: true,
        kind: "shell-vcs-commit",
        vcs: "git",
        subcommand: sub,
        flags: Object.freeze(flags),
        bypassesHooks,
        amendsHistory,
        why: `git ${sub} creates a repository commit and always requires approval`,
      });
    }
    return null;
  }

  if (bin === "hg" || bin === "svn" || bin === "jj") {
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith("-")) {
      const tok = tokens[j];
      if (
        ["-R", "--repository", "--cwd", "--config", "--username", "--password", "--config-dir", "--at-op"].includes(tok)
      ) {
        j += 2;
      } else {
        j += 1;
      }
    }
    const sub = tokens[j];
    if (sub === "commit" || (bin !== "jj" && sub === "ci")) {
      const rest = tokens.slice(j + 1);
      const flags = rest.filter((t) => t === "--amend" || t === "--no-verify").slice(0, 16);
      return Object.freeze({
        isCommit: true,
        kind: "shell-vcs-commit",
        vcs: bin,
        subcommand: sub,
        flags: Object.freeze(flags),
        bypassesHooks: flags.includes("--no-verify"),
        amendsHistory: flags.includes("--amend"),
        why: `${bin} ${sub} creates a repository commit and always requires approval`,
      });
    }
  }

  return null;
}

function detectShellCommitProposal(command, depth = 0) {
  const segments = tokenizeShellSegments(command, depth);
  for (const seg of segments) {
    const hit = inspectTokensForCommit(seg, depth);
    if (hit) return hit;
  }
  return null;
}

/**
 * Structurally detect whether a tool call (or raw shell command) proposes a
 * repository commit. Recognizes chained/wrapped VCS shell commands (`git`,
 * `hg`, `svn`, `jj`) and structured commit tool contracts without matching
 * ordinary text mentions like `grep commit README.md` or read-only commit
 * queries like `list_commits`.
 */
export function detectCommitProposal(toolOrCommand, args = {}, { tool = null } = {}) {
  // Single-argument command shorthand: detectCommitProposal("git commit -m x")
  if (
    typeof toolOrCommand === "string" &&
    args &&
    typeof args === "object" &&
    Object.keys(args).length === 0 &&
    !tool &&
    /\s/.test(toolOrCommand)
  ) {
    return detectShellCommitProposal(toolOrCommand) || NO_COMMIT;
  }

  const toolName = String(toolOrCommand || "").trim();
  if (!toolName) return NO_COMMIT;

  if (toolName === "shell") {
    return detectShellCommitProposal(args?.command) || NO_COMMIT;
  }

  if (tool?.commit === true || tool?.category === "commit") {
    const flags = [];
    if (args?.amend === true) flags.push("--amend");
    if (args?.noVerify === true || args?.no_verify === true) flags.push("--no-verify");
    return Object.freeze({
      isCommit: true,
      kind: "tool-commit",
      vcs: typeof tool?.vcs === "string" ? tool.vcs : "vcs",
      subcommand: "commit",
      flags: Object.freeze(flags),
      bypassesHooks: flags.includes("--no-verify"),
      amendsHistory: flags.includes("--amend"),
      why: `tool "${toolName}" proposes a commit and always requires approval`,
    });
  }

  const nameTokens = toolName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const localTokens = nameTokens[0] === "mcp" && nameTokens.length >= 3 ? nameTokens.slice(2) : nameTokens;

  const hasCommitNoun = localTokens.includes("commit") || localTokens.includes("commits");
  const isReadOnlyCommitQuery =
    hasCommitNoun && localTokens.some((tok) => READONLY_COMMIT_VERBS.has(tok));

  if (hasCommitNoun && !isReadOnlyCommitQuery) {
    const flags = [];
    if (args?.amend === true) flags.push("--amend");
    if (args?.noVerify === true || args?.no_verify === true) flags.push("--no-verify");
    const vcs = ["git", "hg", "svn", "jj"].find((v) => nameTokens.includes(v)) || "git";
    return Object.freeze({
      isCommit: true,
      kind: "tool-commit",
      vcs,
      subcommand: "commit",
      flags: Object.freeze(flags),
      bypassesHooks: flags.includes("--no-verify"),
      amendsHistory: flags.includes("--amend"),
      why: `tool "${toolName}" proposes a commit and always requires approval`,
    });
  }

  const actionField = String(args?.action ?? args?.subcommand ?? args?.operation ?? "")
    .trim()
    .toLowerCase();
  if (
    (actionField === "commit" || actionField === "commit-tree") &&
    nameTokens.some((t) => ["git", "vcs", "repo", "repository", "hg", "svn", "jj"].includes(t))
  ) {
    const flags = [];
    if (args?.amend === true) flags.push("--amend");
    if (args?.noVerify === true || args?.no_verify === true) flags.push("--no-verify");
    return Object.freeze({
      isCommit: true,
      kind: "tool-commit",
      vcs: ["git", "hg", "svn", "jj"].find((v) => nameTokens.includes(v)) || "vcs",
      subcommand: actionField,
      flags: Object.freeze(flags),
      bypassesHooks: flags.includes("--no-verify"),
      amendsHistory: flags.includes("--amend"),
      why: `tool "${toolName}" (${actionField}) proposes a commit and always requires approval`,
    });
  }

  return NO_COMMIT;
}

/** One line for a human, or for the transcript. */
export function describeTier(result) {
  if (result.tier === BLOCKED) return `blocked — ${result.why}`;
  if (result.tier === READ) return `read-only, no prompt`;
  return `needs approval — ${result.why}`;
}

/* ─────────────────────── system_control classification ────────────────────
 *
 * Volume and media-transport actions are the one place where "ask every
 * single time" recreates the exact approval fatigue this file exists to
 * prevent: "volume up" pressed five times is five identical prompts for an
 * action that is bounded, idempotent and reversible from the keyboard.
 *
 * So these actions stay `act` — they never run without a human having said
 * yes — but the yes may be remembered for the rest of the session. Lock and
 * sleep are NOT in this list on purpose: they interrupt the whole machine,
 * so they keep costing one prompt per press.
 */
export const SESSION_GRANTABLE_SYSTEM_CONTROL = Object.freeze([
  "volume_up",
  "volume_down",
  "set_volume",
  "mute",
  "unmute",
  "media_play_pause",
  "media_next",
  "media_previous",
]);

/** The single grant key: one approval covers volume + media for a session. */
export const SYSTEM_CONTROL_GRANT = "system_control:volume-media";

/**
 * Classify a system_control action. Everything is `act` (a human approves);
 * `sessionGrantable` marks the reversible, non-destructive audio/media subset
 * whose approval may be remembered for the rest of the session.
 *
 * @param {string} action
 * @returns {{tier: "act", why: string, sessionGrantable: boolean, grantKey: string|null}}
 */
export function classifySystemControl(action) {
  const name = String(action || "");
  if (SESSION_GRANTABLE_SYSTEM_CONTROL.includes(name)) {
    return {
      tier: ACT,
      why: `${name} is reversible volume/media control — approval can be remembered for this session`,
      sessionGrantable: true,
      grantKey: SYSTEM_CONTROL_GRANT,
    };
  }
  return {
    tier: ACT,
    why: `${name || "an unknown system action"} interrupts the whole machine, so every press asks`,
    sessionGrantable: false,
    grantKey: null,
  };
}
