/**
 * router.js — try backends in order, stop at the first that answers.
 *
 * One pass, no retries, no loops: the ordered list is the whole policy, and every attempt is
 * recorded so a caller can say not just "it failed" but "the local model was rate limited, the
 * cloud key was rejected, and here is what each one said".
 *
 * Two rules matter more than the loop itself.
 *
 * 1. A final failure stops the chain. A malformed request or an over-long conversation fails
 *    identically everywhere, so trying it again elsewhere only doubles the latency (and, on a
 *    metered API, the bill). `FINAL_CODES` in failure.js is that list.
 *
 * 2. Streaming pins the chain to one backend. If text has already been handed to a caller, a
 *    second attempt would print the answer's beginning twice, so a failure after that point is
 *    reported as STREAM_CUT rather than retried.
 */
import { CODES, QuasError, classify } from "./failure.js";

export class ResilientRouter {
  /**
   * @param backends ordered candidates `{ name, provider?, chat(messages, options) }`
   * @param options.now injectable clock, so tests can assert timings without sleeping
   * @param options.onAttempt called after each attempt with its record (telemetry hook)
   */
  constructor(backends, { now = () => Date.now(), onAttempt = null } = {}) {
    if (!Array.isArray(backends) || backends.length === 0) {
      throw new Error("ResilientRouter needs at least one backend");
    }
    this.backends = backends;
    this.now = now;
    this.onAttempt = onAttempt;
  }

  /** The candidate names, in order — what `pinch doctor` shows as the turn's plan. */
  get plan() {
    return this.backends.map((backend) => backend.provider || backend.name);
  }

  async run(messages, options = {}) {
    const attempts = [];
    let primaryFailure = null;

    for (const backend of this.backends) {
      const label = backend.provider || backend.name;
      const started = this.now();
      let emitted = false;
      const forwarded =
        typeof options.onDelta === "function"
          ? (piece) => {
              emitted = true;
              options.onDelta(piece);
            }
          : undefined;

      try {
        const result = await backend.chat(messages, { ...options, onDelta: forwarded });
        const record = { backend: label, ok: true, ms: this.now() - started, streamed: emitted };
        attempts.push(record);
        this.onAttempt?.(record);
        return {
          result,
          attempts,
          provider: result?.provider || label,
          /** Answered, but not by the primary: the numbers are real, something upstream was not. */
          degraded: attempts.length > 1,
        };
      } catch (err) {
        const failure = classify(err, { provider: label });
        const record = {
          backend: label,
          ok: false,
          code: failure.code,
          status: failure.status || undefined,
          message: failure.message,
          ms: this.now() - started,
          streamed: emitted,
        };
        attempts.push(record);
        this.onAttempt?.(record);
        if (!primaryFailure) primaryFailure = failure;

        if (emitted) {
          throw new QuasError(CODES.STREAM_CUT, failure.message, {
            provider: label,
            status: failure.status,
            attempts,
            cause: err,
          });
        }
        if (failure.final) {
          throw new QuasError(failure.code, failure.message, {
            provider: label,
            status: failure.status,
            attempts,
            retryAfterSeconds: failure.retryAfterSeconds,
            cause: err,
          });
        }
        // Otherwise: on to the next candidate.
      }
    }

    // Nothing answered. Report the *primary's* reason — it is the one that explains the turn —
    // with the whole trail attached so a caller can show what else was tried.
    const failure = primaryFailure || new QuasError(CODES.UNREACHABLE, "no backend answered", {});
    throw new QuasError(failure.code, failure.message, {
      provider: failure.provider || attempts[0]?.backend || null,
      status: failure.status,
      attempts,
      retryAfterSeconds: failure.retryAfterSeconds,
      cause: failure.cause || null,
    });
  }
}
