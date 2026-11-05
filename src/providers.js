/**
 * providers.js — every brain Quasnooze can talk to, by name.
 *
 * Two transports cover the field today: Ollama's native API for local
 * models, and the OpenAI-compatible chat-completions API that OpenAI,
 * Anthropic, Google, Groq, OpenRouter, Mistral, DeepSeek, Together, xAI —
 * and local servers like LM Studio, llama.cpp and vLLM — all speak.
 *
 * A preset names the transport, the default endpoint, the environment
 * variable that holds the key, and a starter model. Selecting a cloud
 * preset is the explicit opt-in that sends conversation history off the
 * machine; nothing here is contacted until a turn actually runs, and the
 * local presets never need a key or an account.
 *
 * Honesty notes, kept next to the data they describe:
 * - Anthropic and Gemini are reached through their documented
 *   OpenAI-compatible endpoints, not their native APIs. Tool calling works
 *   there, but exotic native features (extended thinking, cached prompts)
 *   are not exposed by this transport.
 * - Default model names are starting points, not recommendations; override
 *   with `<PRESET>_MODEL` or `OPENAI_MODEL`, or switch at runtime with
 *   `/model openai/<name>` once the endpoint is configured.
 */

export const PROVIDER_PRESETS = Object.freeze({
  // ── local first: no key, no account, nothing leaves the machine ──────
  ollama: Object.freeze({
    label: "Ollama (local)", transport: "ollama", local: true,
    baseUrl: "http://127.0.0.1:11434", keyEnv: null, defaultModel: "qwen2.5-coder:7b",
    note: "Default. Runs models on your machine; the native Ollama provider, not the compatible transport.",
  }),
  lmstudio: Object.freeze({
    label: "LM Studio (local)", transport: "openai", local: true,
    baseUrl: "http://127.0.0.1:1234/v1", keyEnv: "LMSTUDIO_API_KEY", defaultKey: "lm-studio", defaultModel: "local-model",
    note: "LM Studio's local server ignores the key; the placeholder satisfies the transport.",
  }),
  llamacpp: Object.freeze({
    label: "llama.cpp server (local)", transport: "openai", local: true,
    baseUrl: "http://127.0.0.1:8080/v1", keyEnv: "LLAMACPP_API_KEY", defaultKey: "llama-cpp", defaultModel: "local-model",
    note: "llama-server --host 127.0.0.1. Key placeholder satisfies the transport.",
  }),
  vllm: Object.freeze({
    label: "vLLM (local/self-hosted)", transport: "openai", local: true,
    baseUrl: "http://127.0.0.1:8000/v1", keyEnv: "VLLM_API_KEY", defaultKey: "vllm", defaultModel: "local-model",
    note: "Self-hosted GPU serving. Point OPENAI_BASE_URL at your deployment if it is not local.",
  }),
  // ── cloud, bring your own key ─────────────────────────────────────────
  openai: Object.freeze({
    label: "OpenAI", transport: "openai", local: false,
    baseUrl: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", defaultModel: "gpt-4o-mini",
    note: "The original OpenAI-compatible endpoint.",
  }),
  anthropic: Object.freeze({
    label: "Anthropic (Claude)", transport: "openai", local: false,
    baseUrl: "https://api.anthropic.com/v1", keyEnv: "ANTHROPIC_API_KEY", defaultModel: "claude-sonnet-4-5",
    note: "Via Anthropic's OpenAI-compatible endpoint; native-only features are not exposed.",
  }),
  gemini: Object.freeze({
    label: "Google Gemini", transport: "openai", local: false,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", keyEnv: "GEMINI_API_KEY", keyEnvFallback: "GOOGLE_API_KEY", defaultModel: "gemini-2.5-flash",
    note: "Via Google's OpenAI-compatible endpoint.",
  }),
  groq: Object.freeze({
    label: "Groq", transport: "openai", local: false,
    baseUrl: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", defaultModel: "llama-3.3-70b-versatile",
    note: "Hosted open models on Groq LPUs.",
  }),
  openrouter: Object.freeze({
    label: "OpenRouter", transport: "openai", local: false,
    baseUrl: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", defaultModel: "openai/gpt-4o-mini",
    note: "One key, many providers; model names are provider-prefixed.",
  }),
  mistral: Object.freeze({
    label: "Mistral AI", transport: "openai", local: false,
    baseUrl: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", defaultModel: "mistral-small-latest",
    note: "",
  }),
  deepseek: Object.freeze({
    label: "DeepSeek", transport: "openai", local: false,
    baseUrl: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", defaultModel: "deepseek-chat",
    note: "",
  }),
  together: Object.freeze({
    label: "Together AI", transport: "openai", local: false,
    baseUrl: "https://api.together.xyz/v1", keyEnv: "TOGETHER_API_KEY", defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    note: "",
  }),
  xai: Object.freeze({
    label: "xAI (Grok)", transport: "openai", local: false,
    baseUrl: "https://api.x.ai/v1", keyEnv: "XAI_API_KEY", defaultModel: "grok-4-fast",
    note: "",
  }),
  mock: Object.freeze({
    label: "Mock (offline demo/tests)", transport: "mock", local: true,
    baseUrl: "", keyEnv: null, defaultModel: "mock",
    note: "Canned brain. No model, no network — for demos and tests.",
  }),
});

/** The preset id for a requested name, or null when the name is unknown. */
export function providerPreset(name) {
  const id = String(name || "").toLowerCase().trim();
  return Object.hasOwn(PROVIDER_PRESETS, id) ? { id, ...PROVIDER_PRESETS[id] } : null;
}

/**
 * Resolve a requested provider name against an environment into the shape
 * the rest of the app already speaks: a `transport` (the brain provider
 * implementation), an endpoint, and a key. Unknown names resolve to the
 * safe local default rather than throwing at config load — the doctor and
 * the panel surface the configured name, and a typo must never make the
 * assistant unreachable.
 *
 * Explicit `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` always win
 * over preset defaults for the compatible transport: a preset is a
 * starting point, never a lock-in.
 */
export function resolveProvider(requested, env = {}) {
  const preset = providerPreset(requested) || providerPreset("ollama");
  if (preset.transport === "ollama") {
    return Object.freeze({
      preset: preset.id, label: preset.label, transport: "ollama", local: true,
      baseUrl: (env.OLLAMA_URL || preset.baseUrl).replace(/\/$/, ""),
      key: "", keyEnv: null,
      model: env.OLLAMA_MODEL || preset.defaultModel,
    });
  }
  if (preset.transport === "mock") {
    return Object.freeze({
      preset: preset.id, label: preset.label, transport: "mock", local: true,
      baseUrl: "", key: "", keyEnv: null, model: "mock",
    });
  }
  const key = (preset.keyEnv && env[preset.keyEnv])
    || (preset.keyEnvFallback && env[preset.keyEnvFallback])
    || env.OPENAI_API_KEY
    || preset.defaultKey
    || "";
  const specificModel = preset.keyEnv
    ? env[`${preset.id.toUpperCase()}_MODEL`]
    : "";
  return Object.freeze({
    preset: preset.id, label: preset.label, transport: "openai", local: Boolean(preset.local),
    baseUrl: (env.OPENAI_BASE_URL || preset.baseUrl).replace(/\/$/, ""),
    key, keyEnv: preset.keyEnv,
    model: specificModel || env.OPENAI_MODEL || preset.defaultModel,
  });
}

/** One row per preset for `quasnooze providers`. `configured` never prints a key. */
export function providerCatalogue(env = {}, activePreset = "") {
  return Object.entries(PROVIDER_PRESETS).map(([id, preset]) => {
    const resolved = resolveProvider(id, env);
    return {
      id,
      label: preset.label,
      transport: preset.transport,
      kind: id === "mock" ? "demo" : preset.local ? "local" : "cloud",
      baseUrl: resolved.baseUrl,
      keyEnv: preset.keyEnv || null,
      configured: preset.transport === "mock" ? true : preset.transport === "ollama" ? true : Boolean(resolved.key),
      defaultModel: resolved.model,
      active: id === activePreset,
      note: preset.note,
    };
  });
}

export function renderProviderCatalogue(rows) {
  const lines = ["Brain providers — select with LLM_PROVIDER=<id>. Cloud presets send history to that provider; local ones do not.", ""];
  for (const row of rows) {
    const mark = row.active ? "●" : "○";
    const key = row.kind === "cloud" ? (row.configured ? `${row.keyEnv} set` : `${row.keyEnv} missing`) : row.kind === "local" ? "no key needed" : "canned";
    lines.push(`${mark} ${row.id.padEnd(11)} ${row.label} — ${row.kind} · ${key} · default ${row.defaultModel}`);
  }
  return lines.join("\n");
}
