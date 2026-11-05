import test from "node:test";
import assert from "node:assert/strict";
import { PROVIDER_PRESETS, providerPreset, resolveProvider, providerCatalogue, renderProviderCatalogue } from "../src/providers.js";
import { matchFastIntent } from "../src/fast-path.js";

test("every preset resolves to a known transport with an endpoint", () => {
  for (const [id, preset] of Object.entries(PROVIDER_PRESETS)) {
    const resolved = resolveProvider(id, {});
    assert.equal(resolved.preset, id);
    assert.ok(["ollama", "openai", "mock"].includes(resolved.transport), id);
    if (preset.transport === "openai") assert.match(resolved.baseUrl, /^https?:\/\//, id);
  }
});

test("local presets need no key and never point at a cloud host", () => {
  for (const id of ["ollama", "lmstudio", "llamacpp", "vllm"]) {
    const resolved = resolveProvider(id, {});
    assert.equal(resolved.local, true, id);
    assert.match(resolved.baseUrl, /127\.0\.0\.1|localhost/, id);
    assert.ok(resolved.key !== undefined, id); // placeholder or empty, never a real secret
  }
});

test("cloud presets read their own key first, then the shared OpenAI key", () => {
  assert.equal(resolveProvider("groq", { GROQ_API_KEY: "gsk_own" }).key, "gsk_own");
  assert.equal(resolveProvider("groq", { OPENAI_API_KEY: "sk_shared" }).key, "sk_shared");
  assert.equal(resolveProvider("gemini", { GOOGLE_API_KEY: "goog" }).key, "goog");
  assert.equal(resolveProvider("anthropic", { ANTHROPIC_API_KEY: "sk-ant" }).baseUrl, "https://api.anthropic.com/v1");
});

test("explicit OpenAI-compatible overrides always win over preset defaults", () => {
  const resolved = resolveProvider("groq", { OPENAI_BASE_URL: "https://proxy.example/v1/", OPENAI_MODEL: "custom-1" });
  assert.equal(resolved.baseUrl, "https://proxy.example/v1");
  assert.equal(resolved.model, "custom-1");
  assert.equal(resolveProvider("openrouter", { OPENROUTER_MODEL: "x/y" }).model, "x/y");
});

test("an unknown provider name falls back to local Ollama, never to a cloud", () => {
  const resolved = resolveProvider("skynet-9000", {});
  assert.equal(resolved.preset, "ollama");
  assert.equal(resolved.local, true);
});

test("the catalogue marks configuration without ever printing a key", () => {
  const rows = providerCatalogue({ GROQ_API_KEY: "gsk_secret_value" }, "ollama");
  const groq = rows.find((r) => r.id === "groq");
  assert.equal(groq.configured, true);
  assert.equal(rows.find((r) => r.id === "openai").configured, false);
  assert.ok(!JSON.stringify(rows).includes("gsk_secret_value"));
  assert.ok(!renderProviderCatalogue(rows).includes("gsk_secret_value"));
});

test("spoken digit groups are joined before the fast path routes them", () => {
  // A recogniser that hears the PIN 8842 as "88 42" must not file a
  // different fact than the user said.
  const hit = matchFastIntent("remember that the wifi password is 88 42");
  assert.equal(hit.name, "remember");
  assert.equal(hit.args.fact, "the wifi password is 8842");
  // Ordinary numbers with units are untouched.
  const remind = matchFastIntent("remind me to stretch in 20 minutes");
  assert.equal(remind.name, "remind");
  assert.equal(remind.args.when, "in 20 minutes");
});
