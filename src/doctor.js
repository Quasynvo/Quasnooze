/**
 * doctor.js — what this install can actually do right now.
 *
 * `pinch doctor` (scripts/setup.js --check) verifies an install in prose, for a person setting
 * Quasnooze up. This is the other half: the same questions asked so that a machine can read the
 * answers, plus the two things setup.js never looked at —
 *
 *   • a provider matrix built from real requests, with status codes and latencies. Note that
 *     `brain.probe()` cannot answer this: openai's probe only checks that a key is configured, so a
 *     dead cloud endpoint reads as healthy there. Here the endpoint is actually called.
 *   • whether this install would survive its provider failing. The plan a turn will use is printed,
 *     and a single-provider setup says so plainly instead of looking fine until the day it is not.
 *
 * The `regressed` flag is borrowed from agent-reach's doctor: the previous run is kept, so a check
 * that used to pass and now fails is called out as a regression rather than as a status quo.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { classify } from "./failure.js";

export const SCHEMA_VERSION = 1;

export const STATUS = Object.freeze({ OK: "ok", WARN: "warn", FAIL: "fail", SKIP: "skip" });

const TIMEOUT_MS = 2500;

/** Small fetch wrapper: never throws, always reports what happened and how long it took. */
async function probe(url, { headers = {}, timeout = TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method: "GET", redirect: "error", headers, signal: AbortSignal.timeout(timeout) });
    const ms = Date.now() - started;
    const text = res.ok ? await res.text().catch(() => "") : "";
    return { ok: res.ok, status: res.status, ms, body: text };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - started, error: classify(err), failure: String(err?.message || err) };
  }
}

/** The requests the doctor makes, isolated so tests can answer them without a network. */
export function defaultProbes() {
  return {
    async ollama(cfg) {
      const result = await probe(`${cfg.llm.ollamaUrl}/api/tags`);
      if (!result.ok) return result;
      let models = [];
      try {
        models = (JSON.parse(result.body).models || []).map((m) => m.name);
      } catch {
        return { ...result, ok: false, parseError: true };
      }
      return { ...result, models };
    },

    async openai(cfg) {
      if (!cfg.llm.openaiKey) return { ok: false, status: 0, configured: false };
      const result = await probe(`${cfg.llm.openaiBaseUrl}/models`, {
        headers: { authorization: `Bearer ${cfg.llm.openaiKey}` },
      });
      // An OpenAI-compatible server is not required to implement /models. A 404 there means
      // "reachable, but this endpoint does not answer that question" — not a broken endpoint.
      if (result.status === 404 || result.status === 405) {
        return { ...result, ok: true, modelsUnsupported: true };
      }
      if (!result.ok) return result;
      let models = [];
      try {
        models = (JSON.parse(result.body).data || []).map((m) => m.id);
      } catch {
        models = [];
      }
      return { ...result, models };
    },

    async voice(cfg) {
      if (!cfg.whisperUrl) return { configured: false };
      const result = await probe(`${cfg.whisperUrl}/`, { timeout: 1500 });
      return { configured: true, ...result };
    },
  };
}

function check(id, title, status, detail, hint = null, extra = {}) {
  return { id, title, status, detail, hint, ...extra };
}

/** Node major version this package supports, read from the engines field lazily. */
function nodeFloor(pkg) {
  const raw = pkg?.engines?.node || ">=22";
  const major = Number((/>=?\s*(\d+)/.exec(raw) || [])[1] || 22);
  return Number.isFinite(major) ? major : 22;
}

function readState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && parsed.checks ? parsed : { checks: {} };
  } catch {
    return { checks: {} };
  }
}

function writeState(path, report) {
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const checks = {};
    for (const row of report.checks) if (row.status !== STATUS.SKIP) checks[row.id] = { status: row.status, at: report.generated_at };
    writeFileSync(path, `${JSON.stringify({ schema_version: SCHEMA_VERSION, checks }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run every check.
 *
 * @param cfg      the frozen config object (injected in tests)
 * @param probes   the request layer (injected in tests)
 * @param network  false makes the provider checks SKIP, for an offline machine
 * @param statePath where the previous run is remembered; null disables regression tracking
 */
export async function runDoctor({
  cfg,
  pkg = null,
  probes = defaultProbes(),
  plan = null,
  network = true,
  statePath = cfg?.dataDir ? join(cfg.dataDir, "doctor-state.json") : null,
  now = Date.now(),
  nodeVersion = process.version,
} = {}) {
  if (!cfg) throw new Error("runDoctor needs a config object");
  const checks = [];
  const previous = statePath ? readState(statePath) : { checks: {} };

  /* ── runtime ─────────────────────────────────────────────────────────── */
  const nodeMajor = Number(String(nodeVersion).replace(/^v/, "").split(".")[0]);
  const floor = nodeFloor(pkg);
  checks.push(
    nodeMajor >= floor
      ? check("runtime", "Node runtime", STATUS.OK, `${nodeVersion} (needs >=${floor})`)
      : check("runtime", "Node runtime", STATUS.FAIL, `${nodeVersion} is older than the supported >=${floor}`, `Upgrade Node; Quasnooze uses APIs that do not exist in ${nodeVersion}.`),
  );

  /* ── security posture: the two settings that bite ────────────────────── */
  const keySet = Boolean(cfg.authKey);
  const autoApprove = Boolean(cfg.autoApprove);
  const accessProblems = [
    keySet ? null : "PINCH_KEY is empty, so anything that can reach the port can use the assistant. Set one in .env.",
    autoApprove ? "PINCH_AUTO_APPROVE=true lets the assistant act without asking. Turn it off unless you are watching." : null,
  ].filter(Boolean);
  checks.push(
    accessProblems.length
      ? check(
          "security",
          "Access control",
          STATUS.WARN,
          [keySet ? "access key set" : "no access key", autoApprove ? "actions auto-approved" : "actions ask first"].join(" · "),
          accessProblems.join(" "),
        )
      : check("security", "Access control", STATUS.OK, "access key required, actions ask first"),
  );

  /* ── data directory: writable, and not world-readable ────────────────── */
  try {
    mkdirSync(cfg.dataDir, { recursive: true });
    accessSync(cfg.dataDir, constants.W_OK);
    const mode = statSync(cfg.dataDir).mode & 0o777;
    const open = (mode & 0o077) !== 0;
    checks.push(
      open
        ? check("data", "Data directory", STATUS.WARN, `${cfg.dataDir} is mode ${mode.toString(8)}`, `Sessions and memory are readable by other users on this machine. chmod 700 ${cfg.dataDir}`)
        : check("data", "Data directory", STATUS.OK, `${cfg.dataDir} writable, mode ${mode.toString(8)}`),
    );
  } catch (err) {
    checks.push(check("data", "Data directory", STATUS.FAIL, `${cfg.dataDir} is not writable: ${err.message}`, "Fix the path or its permissions in .env (PINCH_DATA); nothing can be saved until this works."));
  }

  /* ── the brain: configured, then actually reachable ──────────────────── */
  const provider = cfg.llm.provider;
  const model = provider === "openai" ? cfg.llm.openaiModel : provider === "mock" ? "mock" : cfg.llm.ollamaModel;
  checks.push(check("brain", "Selected brain", STATUS.OK, `${provider} / ${model}`));

  if (!network) {
    checks.push(check("provider.ollama", "Ollama endpoint", STATUS.SKIP, "network checks disabled (--no-network)"));
    checks.push(check("provider.openai", "Cloud endpoint", STATUS.SKIP, "network checks disabled (--no-network)"));
  } else {
    const local = await probes.ollama(cfg);
    if (local.ok) {
      const has = (local.models || []).includes(cfg.llm.ollamaModel) || (local.models || []).includes(`${cfg.llm.ollamaModel}:latest`);
      checks.push(
        has
          ? check("provider.ollama", "Ollama endpoint", STATUS.OK, `HTTP ${local.status} in ${local.ms}ms · ${local.models.length} model(s) · ${cfg.llm.ollamaModel} present`)
          : check("provider.ollama", "Ollama endpoint", STATUS.WARN, `HTTP ${local.status} in ${local.ms}ms · ${local.models.length} model(s), but ${cfg.llm.ollamaModel} is not one of them`, `ollama pull ${cfg.llm.ollamaModel}`, { code: "MODEL_MISSING" }),
      );
    } else {
      const why = local.parseError ? `HTTP ${local.status} but the body was not JSON` : `no answer from ${cfg.llm.ollamaUrl} (${local.error?.code || local.failure || `HTTP ${local.status}`})`;
      checks.push(check("provider.ollama", "Ollama endpoint", STATUS.FAIL, why, "Start it with `ollama serve`, or point OLLAMA_URL somewhere that is running."));
    }

    const cloud = await probes.openai(cfg);
    if (!cloud.configured) {
      checks.push(check("provider.openai", "Cloud endpoint", STATUS.SKIP, "no OPENAI_API_KEY configured"));
    } else if (cloud.ok) {
      const detail = cloud.modelsUnsupported
        ? `HTTP ${cloud.status} in ${cloud.ms}ms · reachable (this endpoint has no /models list)`
        : `HTTP ${cloud.status} in ${cloud.ms}ms · ${cloud.models.length} model(s)`;
      checks.push(check("provider.openai", "Cloud endpoint", STATUS.OK, detail));
    } else {
      const failure = cloud.error || classify(new Error(cloud.failure || "unknown"));
      checks.push(check("provider.openai", "Cloud endpoint", STATUS.FAIL, `HTTP ${cloud.status || "—"} in ${cloud.ms}ms → ${failure.code}`, failure.hint, { code: failure.code }));
    }
  }

  /* ── routing: would a turn survive losing its provider? ───────────────── */
  const hops = plan || [{ provider, model, role: "primary" }];
  const second = hops.find((hop) => hop.role !== "primary");
  checks.push(
    second
      ? check("routing", "Turn resilience", STATUS.OK, `${hops.map((h) => h.provider).join(" → ")} (fallback: ${second.provider})`)
      : check(
          "routing",
          "Turn resilience",
          STATUS.WARN,
          `single provider (${provider}) — a 429, 5xx or refused connection has nowhere to go`,
          provider === "ollama"
            ? "Set LLM_FALLBACK=openai to survive an Ollama outage. That sends the turn's history to the cloud endpoint, so it stays off by default."
            : "Set LLM_FALLBACK=ollama to fall back to a local model when the cloud fails.",
          { code: "SINGLE_PROVIDER" },
        ),
  );

  /* ── voice, if it is configured at all ───────────────────────────────── */
  if (!network) {
    checks.push(check("voice", "Voice transcription", STATUS.SKIP, "network checks disabled (--no-network)"));
  } else if (!cfg.whisperUrl) {
    checks.push(check("voice", "Voice transcription", STATUS.SKIP, "no WHISPER_URL configured (optional)"));
  } else {
    const voice = await probes.voice(cfg);
    checks.push(
      voice.ok
        ? check("voice", "Voice transcription", STATUS.OK, `${cfg.whisperUrl} answered in ${voice.ms}ms`)
        : check("voice", "Voice transcription", STATUS.WARN, `${cfg.whisperUrl} did not answer (${voice.failure || `HTTP ${voice.status}`})`, "Voice notes fall back to text until this service is up."),
    );
  }

  /* ── channel configuration, presence only ────────────────────────────── */
  const channels = [
    ["telegram", Boolean(cfg.telegram?.token)],
    ["discord", Boolean(cfg.discord?.token)],
    ["slack", Boolean(cfg.slack?.token)],
    ["whatsapp", Boolean(cfg.whatsapp?.enabled)],
  ].filter(([, on]) => on).map(([name]) => name);
  checks.push(
    channels.length
      ? check("channels", "Messaging channels", STATUS.OK, `${channels.length} configured: ${channels.join(", ")}`)
      : check("channels", "Messaging channels", STATUS.SKIP, "none configured — the web panel still works"),
  );

  /* ── regression: a check that used to pass and now does not ───────────── */
  for (const row of checks) {
    const before = previous.checks[row.id];
    row.regressed = Boolean(before && before.status !== STATUS.FAIL && row.status === STATUS.FAIL);
  }
  const regressed = checks.filter((row) => row.regressed).map((row) => row.id);
  if (regressed.length) {
    const first = checks.find((row) => row.regressed);
    checks.push(check("regressions", "Since the last run", STATUS.WARN, `now failing: ${regressed.join(", ")}`, first.hint || "This passed on the previous run; something changed since then.", { code: "REGRESSED" }));
  }

  const summary = {
    [STATUS.OK]: checks.filter((r) => r.status === STATUS.OK).length,
    [STATUS.WARN]: checks.filter((r) => r.status === STATUS.WARN).length,
    [STATUS.FAIL]: checks.filter((r) => r.status === STATUS.FAIL).length,
    [STATUS.SKIP]: checks.filter((r) => r.status === STATUS.SKIP).length,
  };

  const report = {
    schema_version: SCHEMA_VERSION,
    ok: summary[STATUS.FAIL] === 0,
    generated_at: now,
    version: pkg?.version || null,
    node: nodeVersion,
    routing: { plan: hops, resilient: Boolean(second), provider },
    summary,
    checks,
  };

  if (statePath) report.state_written = writeState(statePath, report);
  return report;
}

/* ─────────────────────────────── rendering ─────────────────────────────── */

const PAINT = {
  [STATUS.OK]: (s) => `\x1b[32m${s}\x1b[0m`,
  [STATUS.WARN]: (s) => `\x1b[38;5;214m${s}\x1b[0m`,
  [STATUS.FAIL]: (s) => `\x1b[31m${s}\x1b[0m`,
  [STATUS.SKIP]: (s) => `\x1b[2m${s}\x1b[0m`,
};
const MARK = { ok: "✔", warn: "▲", fail: "✖", skip: "·" };

/** Human output: one line per check, status first, hint underneath. */
export function renderDoctor(report) {
  const lines = [];
  lines.push(`\x1b[38;5;209m🦞 Quasnooze Doctor\x1b[0m  ${report.version ? `v${report.version} · ` : ""}${report.node}`);
  lines.push(`   ${report.routing.plan.map((hop) => `${hop.provider}/${hop.model}`).join(" → ")}${report.routing.resilient ? "" : "  (single provider)"}`);
  lines.push("");
  for (const row of report.checks) {
    const mark = PAINT[row.status](MARK[row.status]);
    lines.push(`  ${mark} ${row.id.padEnd(17)} ${row.detail}${row.regressed ? "  ← regressed" : ""}`);
    if (row.hint && row.status !== STATUS.OK) lines.push(`      ${"\x1b[2m"}${row.hint}\x1b[0m`);
  }
  const s = report.summary;
  lines.push("");
  lines.push(
    `  ${PAINT[STATUS.OK](MARK.ok)} ${s.ok} ok · ${PAINT[STATUS.WARN](MARK.warn)} ${s.warn} warn · ` +
      `${PAINT[STATUS.FAIL](MARK.fail)} ${s.fail} fail · ${s.skip} skipped`,
  );
  lines.push(`  verdict: ${report.ok ? PAINT[STATUS.OK]("healthy") : PAINT[STATUS.FAIL]("needs attention")}${report.ok && s.warn ? PAINT[STATUS.WARN](" (with warnings)") : ""}`);
  return lines.join("\n");
}

/** Machine output: the same report, stable keys, meant to be branched on rather than read. */
export function renderJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
