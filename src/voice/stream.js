/**
 * voice/stream.js — the optional local speech-to-text *stream*, and the origin
 * policy that decides what "local" is allowed to mean.
 *
 * The existing path (`/api/transcribe`) is request/response: the page uploads a
 * chunk, waits, gets text. That is fine for buffered dictation and it is what
 * ships today. This module adds the streaming contract the roadmap asks for —
 * ordered partials, a final result, bounded chunks, cancellation and backpressure
 * — plus the rules that make it honest about where the audio goes.
 *
 * Three invariants carry the whole design, and each is enforced here rather than
 * described in a doc:
 *
 *   1. **Nothing is sent until the owner configures a stream.** No stream URL
 *      means no partial adapter, and the caller falls back to the existing
 *      buffered path or to plain typing. It must never quietly reach for the
 *      browser's vendor recogniser or an OpenAI endpoint instead; `resolveStream`
 *      refuses at configuration time and `describeFallback` states what happens
 *      instead, so the UI can say it out loud.
 *   2. **Local-only means loopback-only.** A stream URL is a stream URL; it is
 *      not permission to reach a host. `assertLocalStreamUrl` accepts http on
 *      loopback hosts and nothing else in local-only mode, and the transport
 *      refuses redirects outright (a 302 is how a loopback endpoint becomes an
 *      arbitrary destination).
 *   3. **A partial is not a message.** Transcripts are ordered and typed
 *      (`partial` / `final`), a final is emitted exactly once, and nothing here
 *      appends to a conversation — that only happens in the caller's final
 *      handler, which is where the existing code already draws the line.
 *
 * No audio is retained: the caller hands over chunks, they are POSTed and
 * dropped. Nothing in this module writes to disk, and no transcript is put in
 * telemetry.
 */
import { isIP } from 'node:net';

/** Bounds. Every one of these is a refusal point, not a suggestion. */
export const STREAM_LIMITS = Object.freeze({
  chunkBytes: 64 * 1024,        // one upload; larger audio is split by the caller
  maxChunkBytes: 1_000_000,     // hard ceiling on a single frame payload
  timeoutMs: 5_000,             // per request, matching the buffered path
  maxTranscriptChars: 4_000,    // one partial/final text
  maxEvents: 2_000,             // events per stream before it is considered runaway
  maxQueue: 32,                 // backpressure: pending sends before we push back
  maxRedirects: 0,              // local-only: redirects are refused, never followed
});

/** Loopback hostnames, including the IPv6 literal forms a URL may carry. */
export const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Is this URL a loopback origin?
 *
 * Deliberately strict: a hostname that merely *looks* local (`127.0.0.1.nip.io`,
 * `localhost.evil.example`, `0.0.0.0`) is not loopback, and `0.0.0.0` in
 * particular is a bind address, not a destination. Credentials, fragments and
 * query strings are refused because a stream endpoint needs none of them and a
 * query string is a place to smuggle a token into a log.
 */
export function assertLocalStreamUrl(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new VoiceStreamError('STREAM_NOT_CONFIGURED', 'No local stream URL is configured.');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new VoiceStreamError('STREAM_INVALID_URL', 'The stream URL is not a valid absolute URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new VoiceStreamError('STREAM_REMOTE_ORIGIN', `The stream URL uses ${url.protocol}, which is not local HTTP.`);
  }
  if (url.username || url.password) {
    throw new VoiceStreamError('STREAM_INVALID_URL', 'The stream URL must not carry credentials.');
  }
  if (url.hash) {
    throw new VoiceStreamError('STREAM_INVALID_URL', 'The stream URL must not carry a fragment.');
  }
  const host = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host)) {
    throw new VoiceStreamError(
      'STREAM_REMOTE_ORIGIN',
      `${url.hostname} is not a loopback origin. In local-only mode the stream must be on this machine.`,
    );
  }
  // An IP literal that is not loopback, spelled in IPv6 brackets, still fails
  // the list above — but check explicitly so the message says why.
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare) && !['127.0.0.1', '::1'].includes(bare)) {
    throw new VoiceStreamError('STREAM_REMOTE_ORIGIN', `${url.hostname} is not a loopback address.`);
  }
  return url.href;
}

/** Errors carry a stable code so the API can answer with a typed reason. */
export class VoiceStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VoiceStreamError';
    this.code = code;
  }
}

export const VOICE_STREAM_CODES = Object.freeze({
  NOT_CONFIGURED: 'STREAM_NOT_CONFIGURED',
  INVALID_URL: 'STREAM_INVALID_URL',
  REMOTE_ORIGIN: 'STREAM_REMOTE_ORIGIN',
  REDIRECT_REFUSED: 'STREAM_REDIRECT_REFUSED',
  TIMEOUT: 'STREAM_TIMEOUT',
  CANCELLED: 'STREAM_CANCELLED',
  UPSTREAM: 'STREAM_UPSTREAM',
  BACKPRESSURE: 'STREAM_BACKPRESSURE',
  INVALID_FRAME: 'STREAM_INVALID_FRAME',
});

/**
 * Decide whether a stream is available, and say so honestly.
 *
 * `enabled` is the owner's switch (`QUASNOOZE_VOICE_STREAM`); a URL without the
 * switch is not enabled, and the switch without a URL has nothing to talk to.
 * Both cases return a reason rather than throwing, because "no stream" is a
 * normal configuration, not an error: the caller shows text-only dictation.
 */
export function resolveStream({ enabled = false, url = '' } = {}) {
  if (!enabled) {
    return Object.freeze({
      available: false,
      reason: 'disabled',
      detail: 'Local streaming speech is off. Dictation uses the buffered path when WHISPER_URL is set, and plain typing otherwise.',
    });
  }
  if (!url) {
    return Object.freeze({
      available: false,
      reason: 'unconfigured',
      detail: 'QUASNOOZE_VOICE_STREAM=on but no QUASNOOZE_VOICE_STREAM_URL. Nothing will be recorded or sent.',
    });
  }
  let href;
  try {
    href = assertLocalStreamUrl(url);
  } catch (error) {
    return Object.freeze({ available: false, reason: 'refused', detail: error.message, code: error.code });
  }
  return Object.freeze({ available: true, url: href, localOnly: true });
}

/**
 * What happens when there is no stream.
 *
 * The rule this exists to enforce: absence of a local adapter is never filled by
 * a remote one. The caller shows this text so the user knows the mic will use
 * the buffered path (or nothing), rather than discovering it from a network tab.
 */
export function describeFallback({ bufferedAvailable = false, browserRecognition = false } = {}) {
  if (bufferedAvailable) {
    return {
      path: 'buffered',
      detail: 'No local stream adapter; dictation records a clip and sends it to the transcription endpoint you configured.',
    };
  }
  if (browserRecognition) {
    return {
      path: 'none',
      detail: 'No local stream adapter and no transcription endpoint. The browser recogniser is separate and may send audio to its vendor; it is never started automatically.',
    };
  }
  return {
    path: 'none',
    detail: 'No local stream adapter is configured. Typing is available; nothing is recorded.',
  };
}

/* ─────────────────────────── frame validation ──────────────────────────── */

/**
 * Validate one inbound frame from the page.
 *
 * The page is not trusted: it is a client, and a client can send anything. A
 * frame is `{ seq, audio(base64), final }`; sequence numbers must be strictly
 * increasing so a reordered or replayed frame cannot produce out-of-order text,
 * and the payload is bounded before it is decoded.
 */
export function validateFrame(raw, { expectedSeq = 0 } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, 'A frame must be an object.');
  }
  const seq = raw.seq;
  if (!Number.isInteger(seq) || seq < 0) {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, 'frame.seq must be a non-negative integer.');
  }
  if (seq !== expectedSeq) {
    throw new VoiceStreamError(
      VOICE_STREAM_CODES.INVALID_FRAME,
      `Out-of-order frame: expected seq ${expectedSeq}, received ${seq}. Nothing was transcribed.`,
    );
  }
  if (typeof raw.audio !== 'string' || !raw.audio) {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, 'frame.audio must be base64 text.');
  }
  // base64 is ~4/3 of the byte length; bound the encoded form before decoding.
  if (raw.audio.length > Math.ceil(STREAM_LIMITS.maxChunkBytes * 4 / 3) + 4) {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, `frame.audio exceeds ${STREAM_LIMITS.maxChunkBytes} bytes.`);
  }
  let audio;
  try {
    audio = Buffer.from(raw.audio, 'base64');
  } catch {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, 'frame.audio is not valid base64.');
  }
  if (!audio.length) {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, 'frame.audio is empty.');
  }
  if (audio.length > STREAM_LIMITS.maxChunkBytes) {
    throw new VoiceStreamError(VOICE_STREAM_CODES.INVALID_FRAME, `frame.audio exceeds ${STREAM_LIMITS.maxChunkBytes} bytes.`);
  }
  const mime = typeof raw.mime === 'string' && /^audio\/[a-z0-9.+-]{1,40}$/i.test(raw.mime) ? raw.mime : 'audio/webm';
  const final = raw.final === true;
  const prompt = typeof raw.prompt === 'string'
    ? raw.prompt.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-400)
    : '';
  return Object.freeze({ seq, audio, mime, final, prompt });
}

/** Transcript text from an upstream payload — bounded, one line, never trusted as HTML. */
export function cleanTranscript(value) {
  if (typeof value !== 'string') return '';
  const text = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, STREAM_LIMITS.maxTranscriptChars);
}

/* ──────────────────────────── the transport ────────────────────────────── */

/**
 * POST one audio chunk to the configured loopback endpoint.
 *
 * `fetch` is injectable so tests never open a socket. Redirects are refused by
 * hand rather than via `redirect: 'manual'` alone: a manual redirect returns the
 * 3xx, and this throws on it, which is the difference between "we did not follow
 * it" and "we did not notice it".
 */
export async function sendChunk(url, frame, { fetch: fetchImpl = globalThis.fetch, timeoutMs = STREAM_LIMITS.timeoutMs, signal } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new VoiceStreamError(VOICE_STREAM_CODES.UPSTREAM, 'No fetch implementation is available.');
  }
  // Re-validated per request: a caller cannot pin a URL at startup and then hand
  // this function a different one later.
  const target = assertLocalStreamUrl(url);
  const controller = new AbortController();
  const timer = AbortSignal.timeout(timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  timer.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(target, {
      method: 'POST',
      // Never follow a redirect. `manual` rather than `error` on purpose:
      // `error` throws a bare "unexpected redirect" TypeError that would be
      // reported as "endpoint unreachable", which is a lie about what happened
      // and loses the status code. `manual` hands back the 3xx so the check
      // below can say exactly what was refused.
      redirect: 'manual',
      credentials: 'omit',
      headers: {
        'content-type': frame.mime,
        accept: 'application/json',
        ...(frame.prompt ? { 'x-quasnooze-prompt': frame.prompt } : {}),
        'x-quasnooze-frame': String(frame.seq),
        'x-quasnooze-final': frame.final ? '1' : '0',
      },
      body: frame.audio,
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel?.();
      throw new VoiceStreamError(VOICE_STREAM_CODES.REDIRECT_REFUSED, 'The stream endpoint redirected; redirects are refused in local-only mode.');
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      throw new VoiceStreamError(VOICE_STREAM_CODES.UPSTREAM, `The local stream endpoint returned HTTP ${response.status}.`);
    }
    // Bound the response body too: a misconfigured or malicious loopback service
    // can still return an unbounded stream of bytes.
    let text = '';
    let count = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body ?? []) {
      count += chunk.byteLength;
      if (count > 1_000_000) throw new VoiceStreamError(VOICE_STREAM_CODES.UPSTREAM, 'The stream response exceeded 1 MB.');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new VoiceStreamError(VOICE_STREAM_CODES.UPSTREAM, 'The stream endpoint returned invalid JSON.');
    }
    const transcript = cleanTranscript(typeof data?.text === 'string' ? data.text : '');
    if (!transcript) {
      throw new VoiceStreamError(VOICE_STREAM_CODES.UPSTREAM, 'The stream endpoint returned no transcript.');
    }
    return transcript;
  } catch (error) {
    if (error instanceof VoiceStreamError) throw error;
    if (signal?.aborted) throw new VoiceStreamError(VOICE_STREAM_CODES.CANCELLED, 'The stream was cancelled; the input was released.');
    if (/redirect/i.test(String(error?.message || error?.cause?.message || ''))) {
      throw new VoiceStreamError(VOICE_STREAM_CODES.REDIRECT_REFUSED, 'The stream endpoint redirected; redirects are refused in local-only mode.');
    }
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new VoiceStreamError(VOICE_STREAM_CODES.TIMEOUT, `The local stream endpoint did not answer within ${timeoutMs} ms.`);
    }
    throw new VoiceStreamError(VOICE_STREAM_CODES.UPSTREAM, 'The local stream endpoint could not be reached.');
  } finally {
    signal?.removeEventListener('abort', onAbort);
    timer.removeEventListener('abort', onAbort);
  }
}

/* ───────────────────────────── the stream ──────────────────────────────── */

/**
 * A bounded, ordered transcript stream.
 *
 * Usage: push frames as audio arrives, call `end()` when the caller stops
 * speaking, then consume `events`. Events are:
 *
 *   { type: 'partial', seq, text }   — provisional; replaced by the next one
 *   { type: 'final',   seq, text }   — emitted exactly once
 *   { type: 'failed',  code, message } — the stream is over; nothing else follows
 *   { type: 'cancelled', reason }    — the caller released the input
 *
 * Backpressure: at most `maxQueue` frames are in flight. Beyond that `push`
 * resolves `{ accepted: false, reason: 'backpressure' }` so the caller pauses
 * capture instead of this module buffering audio without bound.
 */
export function createTranscriptStream({
  url,
  send = sendChunk,
  limits = STREAM_LIMITS,
  signal,
  now = () => Date.now(),
  fetch: fetchImpl,
} = {}) {
  const target = assertLocalStreamUrl(url);
  const queue = [];
  const waiters = [];
  let pending = 0;
  let nextSeq = 0;
  let finished = false;
  let emittedFinal = false;
  let cancelled = false;
  let eventCount = 0;
  let lastText = '';

  function emit(event) {
    if (eventCount >= limits.maxEvents) return; // runaway protection
    eventCount += 1;
    queue.push(Object.freeze({ at: now(), ...event }));
    while (waiters.length) waiters.shift()();
  }

  function close(event) {
    if (finished) return;
    finished = true;
    if (event) emit(event);
    while (waiters.length) waiters.shift()();
  }

  /**
   * Emit results strictly in frame order.
   *
   * Requests finish out of order — chunk 2 answers before chunk 1 often enough
   * that publishing on completion would put the reader's words in the wrong
   * order, or worse, let a stale partial overwrite a newer one. Each finished
   * frame is parked in `settled` against its seq and drained from `emitSeq`
   * upward, so the event order is the audio order regardless of timing.
   */
  const settled = new Map();
  let emitSeq = 0;

  function drain() {
    while (settled.has(emitSeq)) {
      const outcome = settled.get(emitSeq);
      settled.delete(emitSeq);
      emitSeq += 1;
      if (cancelled || finished) continue;
      if (outcome.type === 'final') {
        if (emittedFinal) continue;
        emittedFinal = true;
        lastText = outcome.text;
        emit({ type: 'final', seq: outcome.seq, text: outcome.text });
        close();
        continue;
      }
      if (outcome.type === 'failed') {
        // A final that failed ends the stream; it is the only frame whose
        // failure means there is no transcript to wait for.
        close({ type: 'failed', code: outcome.code, message: outcome.message });
        continue;
      }
      if (outcome.type === 'partial-failed') {
        // A failed partial is a slow turn, not a lost turn: the final still runs.
        emit({ type: 'partial-failed', seq: outcome.seq, code: outcome.code, message: outcome.message });
        continue;
      }
      // A partial that repeats the previous text is not an update; skipping it
      // keeps the UI from flickering the same words at the reader.
      if (outcome.text === lastText) continue;
      lastText = outcome.text;
      emit({ type: 'partial', seq: outcome.seq, text: outcome.text });
    }
  }

  async function transcribe(frame) {
    pending += 1;
    try {
      const text = await send(target, frame, {
        timeoutMs: limits.timeoutMs,
        signal,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      if (cancelled || finished) return;
      settled.set(frame.seq, frame.final ? { type: 'final', seq: frame.seq, text } : { type: 'partial', seq: frame.seq, text });
    } catch (error) {
      if (cancelled) return;
      const code = error instanceof VoiceStreamError ? error.code : VOICE_STREAM_CODES.UPSTREAM;
      settled.set(frame.seq, frame.final
        ? { type: 'failed', seq: frame.seq, code, message: error?.message || String(error) }
        : { type: 'partial-failed', seq: frame.seq, code, message: error?.message || String(error) });
    } finally {
      pending -= 1;
      drain();
    }
  }

  return Object.freeze({
    url: target,

    /** How many frames are in flight; the page uses this to pace capture. */
    get pending() {
      return pending;
    },

    get finished() {
      return finished;
    },

    /**
     * Submit one audio chunk. Returns `{ accepted, seq }` or a typed refusal;
     * it never throws for a refusal, because a refused frame is normal flow.
     */
    async push(input) {
      if (finished) return { accepted: false, reason: 'finished' };
      if (cancelled) return { accepted: false, reason: 'cancelled' };
      if (pending >= limits.maxQueue) {
        return { accepted: false, reason: 'backpressure' };
      }
      let frame;
      try {
        frame = validateFrame({ ...input, seq: nextSeq }, { expectedSeq: nextSeq });
      } catch (error) {
        close({ type: 'failed', code: error.code || VOICE_STREAM_CODES.INVALID_FRAME, message: error.message });
        return { accepted: false, reason: 'invalid', message: error.message };
      }
      nextSeq += 1;
      // Not awaited: the caller paces on `pending`, and a final frame must be
      // queued behind its partials in order.
      void (async () => {
        if (frame.final) {
          // Wait for everything already sent, so the final cannot overtake a
          // partial and emit the transcript twice in the wrong order.
          while (pending > 0) await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await transcribe(frame);
      })();
      // No placeholder event here: the final's own event is the only ordering
      // marker, and it is emitted after every earlier partial has landed.
      return { accepted: true, seq: frame.seq };
    },

    /**
     * Close the stream because no more frames will arrive.
     *
     * Without this, a stream that was fed frames but never given a final (the
     * caller's frame source ended — a closed tab, a released button) leaves
     * `events()` waiting for an event that can never come. It does not emit a
     * final: "the utterance ended" and "we have a transcript" are different
     * facts, and conflating them is how a partial becomes a message.
     */
    finish() {
      if (finished) return;
      // Let anything already in flight land first, then close.
      const settle = async () => {
        while (pending > 0) await new Promise((resolve) => setTimeout(resolve, 5));
        close();
      };
      void settle();
    },

    /** Stop accepting frames and release the input. Never emits a final. */
    cancel(reason = 'cancelled') {
      if (finished) return;
      cancelled = true;
      close({ type: 'cancelled', reason });
    },

    /**
     * Resolve with the next event, or null once the stream is closed.
     *
     * Exported so a caller (and a test) can await progress without draining the
     * iterator: `pending` tells you how much is in flight, this tells you when
     * that changes.
     */
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (finished) return Promise.resolve(null);
      return new Promise((resolve) => { waiters.push(resolve); });
    },

    /** Iterate events until the stream is closed. */
    async *events() {
      while (true) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (finished) {
          // Deliver a cancelled stream's terminal event before ending.
          if (!queue.length) return;
        }
        await new Promise((resolve) => waiters.push(resolve));
      }
    },
  });
}

/**
 * Run one complete utterance: feed frames in, collect ordered events out.
 *
 * This is the whole-clip convenience wrapper the route uses, and the shape the
 * tests exercise. It returns `{ events, text, cancelled }` — `text` is null
 * unless a final was emitted, because a partial is a preview and treating one as
 * a result is the bug this contract exists to prevent.
 */
export async function transcribeStream({
  url,
  frames = [],
  finalAt = null,
  send = sendChunk,
  signal,
  limits = STREAM_LIMITS,
  fetch: fetchImpl,
} = {}) {
  const stream = createTranscriptStream({ url, send, limits, signal, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const collected = [];
  const consumer = (async () => {
    for await (const event of stream.events()) collected.push(event);
  })();

  const list = Array.isArray(frames) ? frames : [];
  const lastIndex = finalAt === null ? list.length - 1 : finalAt;
  for (let i = 0; i < list.length; i++) {
    if (signal?.aborted) { stream.cancel('aborted'); break; }
    const result = await stream.push({ ...list[i], final: i === lastIndex });
    if (!result.accepted && result.reason === 'cancelled') break;
    if (!result.accepted && result.reason === 'backpressure') {
      // Pace the caller: wait until the endpoint has caught up rather than
      // buffering audio without bound.
      while (stream.pending > 0) await new Promise((resolve) => setTimeout(resolve, 5));
      i -= 1;
      continue;
    }
    if (!result.accepted) break;
  }
  // If the frame source ended without a final, nothing more will ever come:
  // close the stream so the consumer finishes. `text` stays null.
  stream.finish();
  await consumer;
  const final = collected.find((event) => event.type === 'final');
  const cancelled = collected.some((event) => event.type === 'cancelled');
  // A terminal failure is reported, not swallowed into a 200: "the stream broke"
  // and "here is your transcript" are different answers, and a caller that only
  // checks the status must not read the second one.
  const failure = collected.find((event) => event.type === 'failed') || null;
  return Object.freeze({
    events: Object.freeze(collected),
    text: final ? final.text : null,
    cancelled,
    failure,
  });
}
