# Brain providers — local first, any cloud by key

Quasnooze speaks to models through two transports: Ollama's native API
(local) and the OpenAI-compatible chat-completions API. A **preset** names
an endpoint, the environment variable that holds its key, and a starter
model, so switching brains is one line — never code.

```bash
quasnooze providers          # what exists, what each needs, what is configured (never prints a key)
quasnooze providers --json
```

## Local — no key, no account, nothing leaves the machine

| `LLM_PROVIDER` | Endpoint (default) | Notes |
|---|---|---|
| `ollama` *(default)* | `http://127.0.0.1:11434` | Native Ollama provider. `OLLAMA_MODEL` picks the model. |
| `lmstudio` | `http://127.0.0.1:1234/v1` | LM Studio local server; key placeholder built in. |
| `llamacpp` | `http://127.0.0.1:8080/v1` | `llama-server`; key placeholder built in. |
| `vllm` | `http://127.0.0.1:8000/v1` | Self-hosted serving; override with `OPENAI_BASE_URL`. |
| `mock` | — | Canned brain for demos/tests. No model at all. |

## Cloud — bring your own key, history leaves the machine

| `LLM_PROVIDER` | Key variable | Starter model |
|---|---|---|
| `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` (via Anthropic's OpenAI-compatible endpoint) |
| `gemini` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | `gemini-2.5-flash` (via Google's OpenAI-compatible endpoint) |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `openrouter` | `OPENROUTER_API_KEY` | `openai/gpt-4o-mini` |
| `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `together` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| `xai` | `XAI_API_KEY` | `grok-4-fast` |

```env
# .env — one preset, its key, done
LLM_PROVIDER=groq
GROQ_API_KEY=gsk_…
```

## Rules that do not bend

- **Overrides win.** `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`
  (and `<PRESET>_MODEL`, e.g. `GROQ_MODEL`) always beat preset defaults.
- **Unknown names fall back to local Ollama** — a typo can never silently
  route your history to a cloud.
- **Cloud is opt-in per preset.** Selecting a cloud preset is the explicit
  decision to send conversation history to that provider, under its terms.
- **Runtime switching stays safe:** `/model openai/<name>` uses whichever
  compatible endpoint is configured; it cannot invent a new destination.
- Anthropic/Gemini native-only features (extended thinking, prompt
  caching) are not exposed by the compatible transport. Tool calling is.
