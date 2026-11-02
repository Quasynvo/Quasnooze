/**
 * failure.js — what went wrong, as a closed set of codes.
 *
 * Every provider failure used to arrive as a bare `Error` whose only structure was the text
 * "HTTP 429: ..."; the agent then explained all of them with the same Ollama advice. A turn that
 * was rate-limited, a turn whose key was rejected and a turn cut off mid-stream looked identical
 * to the user and to the logs.
 *
 * The shape here is borrowed from agent-reach's result envelope (`agent_reach/runtime/result.py`),
 * which is the cleanest version of this idea in a project of that size: a stable code, a sentence,
 * and an actionable hint. The part most fallback code gets wrong is `FINAL_CODES` — *which*
 * failures another backend cannot possibly fix. Retrying those elsewhere sends the same broken
 * turn twice and, for a metered API, bills for it.
 */
import { config } from "./config.js";

export const CODES = Object.freeze({
  /** 429, or a body that says rate limit. Another provider may well be free to answer. */
  RATE_LIMITED: "RATE_LIMITED",
  /** 401/403, or no key configured at all. */
  NEED_AUTH: "NEED_AUTH",
  /** Nothing listening: connection refused, DNS failure, wrong host. */
  UNREACHABLE: "UNREACHABLE",
  /** Accepted, then went quiet past our deadline. */
  TIMEOUT: "TIMEOUT",
  /** 5xx, a body that is not JSON, or a reply that stopped mid-sentence. */
  UPSTREAM_BROKEN: "UPSTREAM_BROKEN",
  /** A body we could parse but whose shape this version does not know. */
  PAYLOAD_MISMATCH: "PAYLOAD_MISMATCH",
  /** We built an invalid request ourselves. */
  BAD_INPUT: "BAD_INPUT",
  /** The conversation no longer fits the window. */
  CONTEXT_LIMIT: "CONTEXT_LIMIT",
  /** The reply had already started on screen when the provider failed. */
  STREAM_CUT: "STREAM_CUT",
});

/**
 * Failures where trying another backend cannot help.
 *
 * A malformed request or an over-long conversation fails the same way everywhere; a reply that has
 * already been shown cannot be re-asked without printing it twice. Note what is *absent*:
 * RATE_LIMITED, UNREACHABLE, TIMEOUT, NEED_AUTH and UPSTREAM_BROKEN are all provider-specific, so
 * they are exactly the cases a fallback chain exists to survive.
 */
export const FINAL_CODES = Object.freeze(new Set([
  CODES.BAD_INPUT,
  CODES.PAYLOAD_MISMATCH,
  CODES.CONTEXT_LIMIT,
  CODES.STREAM_CUT,
]));

/** One actionable sentence per code. Written for a person reading a terminal at 2am. */
export const HINTS = Object.freeze({
  [CODES.RATE_LIMITED]: "The provider reported a rate limit. Wait for its retry window; a local model is not rate limited.",
  [CODES.NEED_AUTH]: "The provider rejected the credential. Check the key in .env (pinch setup). A local Ollama model needs no key.",
  [CODES.UNREACHABLE]: "Nothing answered at that address. For Ollama: ollama serve. For a cloud endpoint: check OPENAI_BASE_URL.",
  [CODES.TIMEOUT]: "The provider accepted the request and then went quiet. Try once more; if it repeats, switch model or provider.",
  [CODES.UPSTREAM_BROKEN]: "The provider failed on its side, or sent something unreadable. Another provider may answer right now.",
  [CODES.PAYLOAD_MISMATCH]: "The reply did not match the shape this version expects — usually a provider or model change, not a network fault. Do not retry in a loop; pinch doctor shows what the endpoint actually returns.",
  [CODES.BAD_INPUT]: "The request was rejected as invalid. Sending the same turn to another provider will not fix it.",
  [CODES.CONTEXT_LIMIT]: "The conversation is longer than the model's window. Start a new session, or attach less.",
  [CODES.STREAM_CUT]: "The reply had already started on screen, so it was not asked again elsewhere — that would print the beginning twice. Ask again for a whole answer.",
});

/**
 * A failure carrying a code, the provider it came from, and the trail of what was tried.
 * `instanceof Error` so existing catch sites and `assert.rejects` keep working.
 */
export class QuasError extends Error {
  constructor(code, message, { provider = null, status = 0, attempts = [], retryAfterSeconds = null, cause = null } = {}) {
    super(message);
    this.name = "QuasError";
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.attempts = attempts;
    this.retryAfterSeconds = retryAfterSeconds;
    if (cause) this.cause = cause;
  }

  /** Another backend cannot fix this one. */
  get final() {
    return FINAL_CODES.has(this.code);
  }

  get hint() {
    return HINTS[this.code] || HINTS[CODES.UPSTREAM_BROKEN];
  }

  /** The stable, machine-readable form — what an agent branches on, never the message. */
  toJSON() {
    return {
      ok: false,
      code: this.code,
      message: this.message,
      hint: this.hint,
      provider: this.provider,
      status: this.status || undefined,
      final: this.final,
      attempts: this.attempts,
    };
  }
}

/** An HTTP status, turned into the code that describes it. */
export function fromStatus(status, detail = "", { provider = null, retryAfterSeconds = null } = {}) {
  const message = `HTTP ${status}: ${detail || "no detail"}`;
  const code =
    status === 429 ? CODES.RATE_LIMITED
      : status === 401 || status === 403 ? CODES.NEED_AUTH
        : status === 400 || status === 422 ? CODES.BAD_INPUT
          : status === 408 || status === 504 ? CODES.TIMEOUT
            : CODES.UPSTREAM_BROKEN;
  return new QuasError(code, message, { provider, status, retryAfterSeconds });
}

/**
 * Classify anything that reached a catch site.
 *
 * Providers we control throw QuasError already; this is the net for what `fetch` itself throws —
 * a refused socket, a DNS miss, an abort — and for third-party code that still throws plain
 * Errors. Message matching is a last resort, and only for wording we do not own.
 */
export function classify(err, { provider = null } = {}) {
  if (err instanceof QuasError) return provider && !err.provider ? new QuasError(err.code, err.message, { provider, status: err.status, attempts: err.attempts }) : err;
  const message = String(err?.message || err || "unknown failure");
  if (err?.name === "AbortError") return new QuasError(CODES.TIMEOUT, message, { provider, cause: err });
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|socket hang up/i.test(message)) {
    return new QuasError(CODES.UNREACHABLE, message, { provider, cause: err });
  }
  if (/\b(429|rate.?limit)/i.test(message)) return new QuasError(CODES.RATE_LIMITED, message, { provider, cause: err });
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.?api.?key|no OPENAI_API_KEY|is not set/i.test(message)) {
    return new QuasError(CODES.NEED_AUTH, message, { provider, cause: err });
  }
  if (/non-json|unexpected token|payload|schema/i.test(message)) {
    return new QuasError(CODES.PAYLOAD_MISMATCH, message, { provider, cause: err });
  }
  if (/timed out|timeout/i.test(message)) return new QuasError(CODES.TIMEOUT, message, { provider, cause: err });
  return new QuasError(CODES.UPSTREAM_BROKEN, message, { provider, cause: err });
}

/**
 * The ordered providers a turn will use, primary first.
 *
 * Deliberately short by default. Quasnooze is local-first: silently failing over from a local
 * Ollama model to a cloud endpoint would hand the user's conversation to a third party to keep a
 * turn alive, which is not a trade this app should make on the user's behalf. A second provider
 * is used only when it has been asked for (`LLM_FALLBACK`), and a `mock` brain is never a fallback
 * at all — canned text presented as an answer would break the honesty rule the guard exists to
 * enforce.
 */
export function planFor(selection, cfg = config) {
  const primary = { provider: selection.provider, model: selection.model, role: "primary" };
  const wanted = String(cfg.llm.fallback || "").toLowerCase();
  const known = new Set(["ollama", "openai"]);
  const usable = (provider) =>
    provider !== selection.provider &&
    known.has(provider) &&
    (provider !== "openai" || Boolean(cfg.llm.openaiKey));

  if (!wanted || wanted === "off" || wanted === "none") return [primary];
  if (wanted === "ollama" || wanted === "openai") {
    if (!usable(wanted)) return [primary];
    const model = wanted === "ollama" ? cfg.llm.ollamaModel : cfg.llm.openaiModel;
    return [primary, { provider: wanted, model, role: "fallback" }];
  }
  return [primary];
}
