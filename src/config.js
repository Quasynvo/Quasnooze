/**
 * config.js — reads .env once, exposes a frozen config object.
 *
 * Deliberately dependency-free: a 40-line parser instead of dotenv, so
 * `git clone && node src/index.js` works with no install step.
 */
import { resolveStatePaths, assertNoLegacyState } from "./state-paths.js";
import { normalizeBrandEnv } from "./brand-config.js";
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parse KEY=VALUE lines; never overrides a real environment variable. */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnv(root = ROOT) {
  const paths = resolveStatePaths({ root });
  assertNoLegacyState(root, paths);
  const file = paths.envPath;
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return { ...normalizeBrandEnv(fromFile), ...normalizeBrandEnv(process.env), __loadedFromFile: fromFile };
}

const env = loadEnv();
const statePaths = resolveStatePaths({ root: ROOT });
const dataDir = env.PINCH_DATA || statePaths.dataDir;
// Only the explicit Windows launcher enables the resident companion.
const desktopRequested = process.platform === "win32" && (process.env.QUASNOOZE_DESKTOP ?? process.env.PINCH_DESKTOP) === "1";

const list = (value) =>
  (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const bool = (value, fallback = false) => {
  if (value === undefined || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
};

const workspaceRoots = list(env.PINCH_WORKSPACE).map((p) =>
  resolve(p.replace(/^~(?=$|\/)/, homedir()))
);

export const config = Object.freeze({
  root: ROOT,
  // PINCH_DATA exists so tests (and power users with a NAS) can move memory.
  dataDir,
  publicDir: join(ROOT, "public"),

  ownerName: env.OWNER_NAME || "friend",
  timezone: env.OWNER_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,

  desktopRequested,
  host: desktopRequested ? "127.0.0.1" : env.PINCH_HOST || "0.0.0.0",
  // Was PINCH_HOST actually set? An empty key plus the *default* wildcard bind
  // is an accident; an explicit 0.0.0.0 is a decision, and the two deserve
  // different treatment at boot.
  hostExplicit: Boolean(env.PINCH_HOST),
  port: Number(env.PINCH_PORT || 7777),
  authKey: env.PINCH_KEY || (desktopRequested ? randomBytes(32).toString("hex") : ""),

  llm: Object.freeze({
    provider: (env.LLM_PROVIDER || "ollama").toLowerCase(),
    ollamaUrl: (env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
    ollamaModel: env.OLLAMA_MODEL || "qwen2.5-coder:7b",
    ollamaThink: bool(env.OLLAMA_THINK, false),
    openaiBaseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
    openaiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "gpt-4o-mini",
    // Which provider a turn may fall back to when the selected one fails. Empty by default:
    // failing over from a local model to a cloud endpoint would send the conversation off the
    // machine to keep a turn alive, and that is the user's decision, not a default. Set it to
    // ollama or openai to opt in; "mock" is never accepted as a fallback.
    fallback: (env.LLM_FALLBACK || "").toLowerCase(),
  }),

  workspaceRoots: workspaceRoots.length ? workspaceRoots : [homedir()],
  // Optional user profile, like an about_me file: injected into the prompt.
  profilePath: env.PINCH_PROFILE || join(dataDir, "profile.md"),
  // Set PINCH_GUARD=off to silence the post-reply honesty check (not advised).
  disableGuard: /^(0|false|off|no)$/i.test(env.PINCH_GUARD || ""),
  // Set PINCH_FAST_PATH=off to send deterministic turns through the model again.
  fastPath: !/^(0|false|off|no)$/i.test(env.PINCH_FAST_PATH || ""),
  // Opt-in (issue #108): the design-then-approve workflow. Off by default, so
  // `/plan …` is ordinary text on a machine where the owner never asked for it.
  workflow: bool(env.PINCH_WORKFLOW, false),
  autoApprove: desktopRequested ? false : bool(env.PINCH_AUTO_APPROVE, false),
  // Read-only shell commands run without a prompt; everything else still asks.
  // Off restores "ask for every shell command", which is the old behaviour.
  riskTiers: !["0", "false", "off", "no"].includes(String(env.PINCH_RISK_TIERS || "").toLowerCase()),
  // Extra hostnames the panel may be reached on (reverse proxy, tailnet).
  allowedHosts: list(env.PINCH_ALLOWED_HOSTS),
  // Credential-looking env vars a build may legitimately need.
  envPassthrough: list(env.PINCH_ENV_PASSTHROUGH),
  shellTimeoutMs: Number(env.PINCH_SHELL_TIMEOUT || 120) * 1000,
  // Context window, and how much of it to keep free for the reply. A 7B qwen
  // on a laptop handles 32k; the old hard-coded 8192 could not hold the system
  // prompt, the tool schemas and one attachment at the same time.
  // MCP servers: "name=command args;name2=command args". Trusted servers skip
  // the per-call approval prompt; everything else asks, every time.
  // Scheduled agent runs. Off means the scheduler still delivers reminders; it
  // simply refuses to start an agent turn with nobody watching.
  scheduledRuns: !/^(0|false|off|no)$/i.test(env.PINCH_SCHEDULED_RUNS || ""),
  mcpSpec: env.PINCH_MCP || "",
  // Path to a JSON manifest of your own tools. Empty means none: nothing is
  // discovered implicitly, because a file the user did not point at is a file the
  // user did not review.
  customToolsPath: env.PINCH_TOOLS || "",
  toolsDir: env.PINCH_TOOLS_DIR || "",
  mcpTrusted: env.PINCH_MCP_TRUSTED || "",
  numCtx: Number(env.PINCH_NUM_CTX || 8192),
  numPredict: Number(env.PINCH_NUM_PREDICT || 2048),

  telegram: Object.freeze({
    token: env.TELEGRAM_TOKEN || "",
    allowedIds: list(env.TELEGRAM_ALLOWED_IDS),
  }),
  discord: Object.freeze({
    token: env.DISCORD_BOT_TOKEN || "",
    channelIds: list(env.DISCORD_CHANNEL_IDS),
  }),
  slack: Object.freeze({
    token: env.SLACK_BOT_TOKEN || "",
    channelIds: list(env.SLACK_CHANNEL_IDS),
  }),
  whatsapp: Object.freeze({
    enabled: bool(env.WHATSAPP_ENABLED, false),
    allowedNumbers: list(env.WHATSAPP_ALLOWED_NUMBERS),
  }),

  whisperUrl: (env.WHISPER_URL || "").replace(/\/$/, ""),
});

/** True when at least one real model is reachable by configuration. */
export function hasRealBrain() {
  if (config.llm.provider === "mock") return false;
  if (config.llm.provider === "openai") return Boolean(config.llm.openaiKey);
  return true; // ollama is assumed reachable; server probes it at boot
}
