/**
 * Explicitly opt-in microphone analysis. No recording, upload, playback or recognition.
 * Call startAudioAnalysis() directly from a user gesture on HTTPS or loopback HTTP.
 * The caller owns the returned session and MUST call stop() on mute/unmount.
 */
export async function startAudioAnalysis({ fftSize = 1024, deviceId, signal, onEnded } = {}) {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone analysis needs HTTPS or a trustworthy loopback origin and a browser with Web Audio support.");
  }
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AudioContextClass) throw new Error("This browser does not support Web Audio analysis.");
  if (![512, 1024, 2048, 4096].includes(fftSize)) throw new RangeError("fftSize must be 512, 1024, 2048 or 4096.");
  let stream, context, source, analyser, stopped = false;
  const bands = new Float32Array(48);
  const abort = () => cleanup();
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", abort);
    stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    source?.disconnect(); analyser?.disconnect();
    if (context && context.state !== "closed") context.close().catch(() => {});
  };
  try {
    if (signal?.aborted) throw new DOMException("Capture cancelled.", "AbortError");
    signal?.addEventListener("abort", abort, { once: true });
    // Preserve user activation: do not await a network request before resume/getUserMedia.
    context = new AudioContextClass();
    let resumeFailure;
    const resumed = context.resume().catch(error => { resumeFailure = error; });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false,
    });
    await resumed;
    if (stopped) { stream.getTracks().forEach(track => { track.onended = null; track.stop(); }); throw new DOMException("Capture cancelled.", "AbortError"); }
    if (resumeFailure) throw resumeFailure;
    analyser = context.createAnalyser();
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -20;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser); // Deliberately NOT connected to destination: no mic monitoring/feedback.
    const bytes = new Uint8Array(analyser.frequencyBinCount);
    const samples = new Float32Array(analyser.fftSize);
    const hzPerBin = context.sampleRate / fftSize;
    const edges = Array.from({ length: 49 }, (_, i) => 60 * Math.pow(8000 / 60, i / 48));
    const track = stream.getAudioTracks()[0];
    const session = {
      sample() {
        if (stopped || track?.readyState !== "live" || context.state !== "running") return null;
        analyser.getByteFrequencyData(bytes);
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += value * value;
        const rms = Math.sqrt(sum / samples.length);
        for (let band = 0; band < 48; band++) {
          const low = Math.max(1, Math.floor(edges[band] / hzPerBin));
          const high = Math.min(bytes.length - 1, Math.max(low, Math.ceil(edges[band + 1] / hzPerBin)));
          let energy = 0;
          for (let bin = low; bin <= high; bin++) energy += (bytes[bin] / 255) ** 2;
          bands[band] = Math.sqrt(energy / (high - low + 1));
        }
        return { source: "spectrum", level: Math.min(1, rms * 5), bands, timestamp: performance.now() };
      },
      stop: cleanup,
      get active() { return !stopped && track?.readyState === "live"; },
      // The same stream this session analyses. A caller that also records (for
      // local dictation) must not open a second microphone: on some platforms
      // the second getUserMedia fails, and on the others the user sees two
      // permission prompts for one button.
      get stream() { return stream; },
    };
    if (track) track.onended = () => { cleanup(); onEnded?.(); };
    return session;
  } catch (error) {
    cleanup();
    if (error.name === "NotAllowedError" || error.name === "SecurityError") throw new Error("Microphone permission was denied. Enable it in your browser’s site settings, then try again.");
    if (error.name === "NotFoundError") throw new Error("No microphone was found. Connect one or continue with text.");
    if (error.name === "NotReadableError") throw new Error("The microphone is busy or unavailable. Check the OS input device and other apps.");
    if (error.name === "OverconstrainedError") throw new Error("That microphone is unavailable. Choose the default input device.");
    throw error;
  }
}

/* ─────────────────────────── endpointing (VAD) ───────────────────────────
   Deciding that someone finished speaking, without a model and without a
   dependency. A browser `SpeechRecognition` does this for you and may send the
   audio to its vendor; a local path has to do it here, from the same analyser
   frames the visualiser already draws.

   It is a fixed-threshold detector with hysteresis, not a speech classifier:
   a noisy room raises the floor, and the honest response is to say so rather
   than to claim the segments are correct. See docs/VOICE.md.                */

export const ENDPOINTER_DEFAULTS = Object.freeze({
  // `sample().level` is an RMS scaled into 0..1, so these are fractions of full scale.
  speechThreshold: 0.06,
  // Below this a frame counts as silence. The gap between the two thresholds is
  // the hysteresis that stops a quiet consonant from ending the sentence.
  silenceThreshold: 0.03,
  onsetFrames: 2,
  // Trailing silence that ends the utterance. 300 ms is the published endpoint
  // budget, so the default holds the budget instead of describing it.
  silenceMs: 300,
  // A cough is not a question. Anything shorter is endpointed and discarded.
  minSpeechMs: 250,
  // A cap, so a stuck microphone cannot upload a lecture.
  maxUtteranceMs: 15_000,
});

/**
 * Feed it frames, get events. Pure: same frames, same events, no clock of its own.
 * @param {{speechThreshold?: number, silenceThreshold?: number, onsetFrames?: number,
 *          silenceMs?: number, minSpeechMs?: number, maxUtteranceMs?: number}} [options]
 */
export function createEndpointer(options = {}) {
  const cfg = { ...ENDPOINTER_DEFAULTS, ...options };
  let speaking = false, loud = 0, speechStart = 0, lastVoiceAt = 0, silenceSince = 0, now = 0;

  const reset = () => { speaking = false; loud = 0; speechStart = 0; lastVoiceAt = 0; silenceSince = 0; };
  const end = (reason, at) => {
    const speechMs = Math.max(0, lastVoiceAt - speechStart);
    const event = {
      type: "endpoint", reason, at, speechMs,
      // How long after the last voiced frame the decision came: the number the
      // voice budget calls `endpointMs`.
      endpointMs: Math.max(0, at - lastVoiceAt),
      discarded: speechMs < cfg.minSpeechMs,
    };
    reset();
    return event;
  };

  return {
    /**
     * @param {number} level 0..1 from `sample().level`
     * @param {number} at milliseconds on the caller's clock
     * @returns {null | {type: "speech-start", at: number} | {type: "endpoint", reason: string, at: number, speechMs: number, endpointMs: number, discarded: boolean}}
     */
    push(level, at) {
      now = Number.isFinite(at) ? at : now;
      const value = Number.isFinite(level) ? Math.max(0, level) : 0;
      if (!speaking) {
        if (value < cfg.speechThreshold) { loud = 0; return null; }
        if (loud === 0) speechStart = now;
        loud += 1;
        if (loud < cfg.onsetFrames) return null;
        speaking = true;
        lastVoiceAt = now;
        silenceSince = 0;
        return { type: "speech-start", at: now };
      }
      if (value >= cfg.silenceThreshold) { lastVoiceAt = now; silenceSince = 0; }
      else if (silenceSince === 0) silenceSince = now;
      if (lastVoiceAt - speechStart >= cfg.maxUtteranceMs) return end("max-length", now);
      if (silenceSince !== 0 && now - lastVoiceAt >= cfg.silenceMs) return end("silence", now);
      return null;
    },
    get speaking() { return speaking; },
    get speechMs() { return speaking ? Math.max(0, lastVoiceAt - speechStart) : 0; },
    reset,
  };
}

/**
 * A provisional transcript that cannot become a message by accident.
 *
 * Partials replace each other in place — they are something to *show*. Only
 * `commit()` yields text a caller is allowed to store, and it happens once.
 */
export function createProvisionalTranscript({ limit = 4000 } = {}) {
  let live = "", committed = null;
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(-limit);
  return {
    get text() { return live; },
    get committed() { return committed; },
    update(chunk) { live = clean(chunk); return { text: live, provisional: true }; },
    commit(finalText = live) {
      const text = clean(finalText);
      live = "";
      committed = text || null;
      return committed ? { text: committed, provisional: false } : null;
    },
    discard() { live = ""; committed = null; },
  };
}

/**
 * The local dictation pipeline: analyser frames in, one final transcript out.
 *
 * Everything mutable is injected — frames, audio chunks and the transcription
 * call — so the whole thing runs in a test with synthetic silence and no
 * microphone, which is also how the endpoint window is proven.
 *
 * `streaming: false` is the whole-clip path: the same events, the same final
 * callback, one request at the end. That is what "no behavioural difference"
 * means here, and a test asserts the two modes emit the same status sequence.
 *
 * @param {{frames: AsyncIterable<{level: number, at: number}>,
 *          takeAudio: () => Blob, post: (audio: Blob, options: {prompt: string|null, final: boolean}) => Promise<{text: string}>,
 *          streaming?: boolean, chunkMs?: number, signal?: AbortSignal,
 *          onPartial?: (partial: {text: string, provisional: true}) => void,
 *          onFinal?: (final: {text: string, provisional: false}) => void,
 *          onStatus?: (status: object) => void}} options
 */
export async function startLocalDictation({
  frames, takeAudio, post,
  streaming = true,
  chunkMs = 1200,
  signal,
  onPartial = () => {},
  onFinal = () => {},
  onStatus = () => {},
} = {}) {
  if (typeof takeAudio !== "function" || typeof post !== "function" || !frames) {
    throw new TypeError("Local dictation needs frames, takeAudio and post.");
  }
  const endpointer = createEndpointer();
  const buffer = createProvisionalTranscript();
  let prompt = null, sinceUpload = 0, previousAt = null;
  onStatus({ state: "listening", streaming: Boolean(streaming), chunkMs });

  for await (const frame of frames) {
    if (signal?.aborted) {
      endpointer.reset();
      buffer.discard();
      onStatus({ state: "cancelled" });
      throw new DOMException("Dictation cancelled.", "AbortError");
    }
    const at = Number(frame?.at);
    if (!Number.isFinite(at)) continue;
    const delta = previousAt === null ? 0 : Math.max(0, at - previousAt);
    previousAt = at;

    const event = endpointer.push(frame?.level, at);
    if (event?.type === "speech-start") onStatus({ state: "speech" });
    sinceUpload = endpointer.speaking ? sinceUpload + delta : 0;

    if (event?.type === "endpoint") {
      onStatus({ state: "endpoint", reason: event.reason, endpointMs: event.endpointMs, speechMs: event.speechMs });
      if (event.discarded) {
        buffer.discard();
        onStatus({ state: "discarded", reason: "too-short" });
        return { text: null, endpoint: event };
      }
      let text;
      try {
        text = (await post(takeAudio(), { prompt, final: true }))?.text;
      } catch (error) {
        buffer.discard();
        onStatus({ state: "failed", message: String(error?.message || error) });
        return { text: null, endpoint: event, error };
      }
      const committed = buffer.commit(text);
      if (!committed) {
        onStatus({ state: "empty" });
        return { text: null, endpoint: event };
      }
      onFinal(committed);
      onStatus({ state: "final" });
      return { text: committed.text, endpoint: event };
    }

    // Partial uploads only while there is real speech to transcribe: a 100 ms
    // blip must not become a request, and neither must the silence that follows
    // it. Anything captured after the last voiced frame rides on the final POST,
    // which is why stopping here loses no audio — it just stops paying for
    // requests that transcribe nothing but a room.
    const voiced = (Number.isFinite(frame?.level) ? frame.level : 0) >= ENDPOINTER_DEFAULTS.silenceThreshold;
    if (streaming && voiced && endpointer.speaking && endpointer.speechMs >= ENDPOINTER_DEFAULTS.minSpeechMs && sinceUpload >= chunkMs) {
      sinceUpload = 0;
      try {
        const text = (await post(takeAudio(), { prompt, final: false }))?.text;
        if (text) {
          prompt = text;
          onPartial(buffer.update(text));
        }
      } catch (error) {
        // A failed partial is a slow turn, not a lost turn: the final POST still runs.
        onStatus({ state: "partial-failed", message: String(error?.message || error) });
      }
    }
  }

  // The frame stream ended without an endpoint (a stop button, a closed tab).
  buffer.discard();
  onStatus({ state: "cancelled", reason: "stream-ended" });
  return { text: null, endpoint: null };
}

/* ── local streaming speech (issue #134) ─────────────────────────────────────
   The optional stream path: bounded chunks go to this machine's configured
   loopback endpoint as you speak, partials replace each other in place, and only
   the final transcript is returned as text a caller may send.

   Three things this module refuses to do, each of which the tests pin:

   1. Start capture on load. `microphoneState` begins `muted`; nothing touches
      getUserMedia until `start()` is called from a user gesture.
   2. Fall back to a remote recogniser. If `/api/voice/stream` reports no
      adapter, this rejects with the server's own reason — it never reaches for
      the browser vendor's recogniser or an OpenAI endpoint.
   3. Turn a partial into a result. `result.text` is null unless a final event
      arrived, so a caller that forgets to check `final` gets nothing to send.  */

export const MIC_STATES = Object.freeze({
  MUTED: 'muted',
  REQUESTING: 'requesting',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  ERROR: 'error',
});

export const STREAM_CLIENT_LIMITS = Object.freeze({
  chunkMs: 1_200,
  maxChunkBytes: 64 * 1024,
  maxQueue: 8,
  maxFrames: 64,
});

/** Recording state that starts muted and never advances on its own. */
export function createMicrophoneState({ onChange = () => {} } = {}) {
  let state = MIC_STATES.MUTED;
  let reason = null;
  const set = (next, why = null) => {
    if (state === next && reason === why) return state;
    state = next;
    reason = why;
    onChange({ state, reason, recording: state === MIC_STATES.RECORDING });
    return state;
  };
  return Object.freeze({
    get state() { return state; },
    get reason() { return reason; },
    /** True only while audio is actually being captured. */
    get recording() { return state === MIC_STATES.RECORDING; },
    begin() { if (state !== MIC_STATES.MUTED && state !== MIC_STATES.ERROR) return state; return set(MIC_STATES.REQUESTING); },
    started() { return set(MIC_STATES.RECORDING); },
    /** `why` is shown to the user; it is never a vendor fallback. */
    fail(why) { return set(MIC_STATES.ERROR, String(why ?? 'microphone unavailable')); },
    stop() { if (state === MIC_STATES.MUTED) return state; return set(MIC_STATES.STOPPING); },
    muted() { return set(MIC_STATES.MUTED); },
  });
}

/** Ask the server what it will allow. Never throws: a refusal is an answer. */
export async function fetchStreamCapability({ fetch: fetchImpl = globalThis.fetch, key = '' } = {}) {
  const response = await fetchImpl('/api/voice/stream', {
    headers: key ? { 'x-quasnooze-key': key } : {},
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { available: false, reason: 'unreachable', detail: data.error || `HTTP ${response.status}`, fallback: { path: 'none', detail: 'No local stream adapter is reachable.' } };
  }
  return {
    available: data.available === true,
    reason: data.reason || (data.available === true ? null : 'disabled'),
    detail: data.detail || '',
    code: data.code || null,
    fallback: data.fallback || { path: 'none', detail: 'No local stream adapter is configured.' },
    maxChunkBytes: Number(data.maxChunkBytes) || STREAM_CLIENT_LIMITS.maxChunkBytes,
  };
}

/**
 * Stream one utterance to the local endpoint.
 *
 * `frames` yields `{ level, at }` like the buffered path; `takeAudio()` returns
 * the audio captured since the last call as a Blob/Uint8Array. Chunks are sent
 * only while there is real speech, so silence never costs a request.
 *
 * Resolves `{ text, events, cancelled }`, where `text` is null unless a final
 * transcript arrived — a partial is a preview, never a message.
 */
export async function startLocalSpeechStream({
  frames, takeAudio, capability,
  chunkMs = STREAM_CLIENT_LIMITS.chunkMs,
  maxChunkBytes = STREAM_CLIENT_LIMITS.maxChunkBytes,
  signal,
  post = null,
  fetch: fetchImpl = globalThis.fetch,
  key = '',
  onPartial = () => {},
  onFinal = () => {},
  onStatus = () => {},
  onRecording = () => {},
} = {}) {
  if (!frames || typeof takeAudio !== 'function') {
    throw new TypeError('Local speech streaming needs frames and takeAudio.');
  }
  // The capability is required: without it there is no evidence a local adapter
  // exists, and guessing is how a silent remote fallback gets in.
  const cap = capability || await fetchStreamCapability({ fetch: fetchImpl, key });
  if (!cap.available) {
    const error = new Error(cap.detail || 'No local streaming adapter is configured.');
    error.code = cap.code || `STREAM_${String(cap.reason || 'not_available').toUpperCase()}`;
    error.fallback = cap.fallback;
    onStatus({ state: 'unavailable', reason: cap.reason, detail: error.message, fallback: cap.fallback });
    onRecording({ state: MIC_STATES.MUTED, recording: false });
    throw error;
  }

  const endpointer = createEndpointer();
  const buffer = createProvisionalTranscript();
  const send = post || (async (blob, { prompt, final, seq, mime }) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength > maxChunkBytes) {
      throw Object.assign(new Error(`chunk exceeds ${maxChunkBytes} bytes`), { code: 'STREAM_CHUNK_TOO_LARGE' });
    }
    // base64 in bounded slices so a large chunk cannot blow the argument limit.
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const response = await fetchImpl('/api/voice/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-quasnooze-key': key } : {}) },
      body: JSON.stringify({ frames: [{ seq, audio: btoa(binary), mime, final, prompt }] }),
      signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `stream failed (HTTP ${response.status})`), { code: data.code });
    return { text: data.text ?? null, events: data.events || [] };
  });

  const events = [];
  let seq = 0, sinceUpload = 0, previousAt = null, prompt = '';
  onRecording({ state: MIC_STATES.RECORDING, recording: true });
  onStatus({ state: 'listening', chunkMs });

  const submit = async (final) => {
    const current = seq++;
    const blob = takeAudio();
    const type = (blob && blob.type) || 'audio/webm';
    try {
      const result = await send(blob, { prompt, final, seq: current, mime: type });
      for (const event of result.events || []) events.push(event);
      if (final) {
        const committed = buffer.commit(result.text);
        if (!committed) { onStatus({ state: 'empty' }); return { text: null }; }
        onFinal(committed);
        onStatus({ state: 'final' });
        return { text: committed.text };
      }
      if (result.text) { prompt = result.text; onPartial(buffer.update(result.text)); }
      return { text: null };
    } catch (error) {
      if (final) {
        buffer.discard();
        onStatus({ state: 'failed', message: String(error?.message || error), code: error?.code });
        return { text: null, error };
      }
      // A failed partial is a slow turn, not a lost turn.
      onStatus({ state: 'partial-failed', message: String(error?.message || error) });
      return { text: null };
    }
  };

  for await (const frame of frames) {
    if (signal?.aborted) {
      endpointer.reset(); buffer.discard();
      onStatus({ state: 'cancelled' });
      onRecording({ state: MIC_STATES.MUTED, recording: false });
      throw Object.assign(new DOMException('Speech stream cancelled.', 'AbortError'), { code: 'STREAM_CANCELLED' });
    }
    const at = Number(frame?.at);
    if (!Number.isFinite(at)) continue;
    const delta = previousAt === null ? 0 : Math.max(0, at - previousAt);
    previousAt = at;
    const event = endpointer.push(frame?.level, at);
    if (event?.type === 'speech-start') onStatus({ state: 'speech' });
    sinceUpload = endpointer.speaking ? sinceUpload + delta : 0;

    if (event?.type === 'endpoint') {
      onStatus({ state: 'endpoint', reason: event.reason, endpointMs: event.endpointMs, speechMs: event.speechMs });
      if (event.discarded) {
        buffer.discard();
        onStatus({ state: 'discarded', reason: 'too-short' });
        onRecording({ state: MIC_STATES.MUTED, recording: false });
        return { text: null, events, endpoint: event };
      }
      onRecording({ state: MIC_STATES.STOPPING, recording: false });
      const result = await submit(true);
      onRecording({ state: MIC_STATES.MUTED, recording: false });
      return { text: result.text, events, endpoint: event, error: result.error };
    }

    const voiced = (Number.isFinite(frame?.level) ? frame.level : 0) >= ENDPOINTER_DEFAULTS.silenceThreshold;
    if (voiced && endpointer.speaking && endpointer.speechMs >= ENDPOINTER_DEFAULTS.minSpeechMs && sinceUpload >= chunkMs) {
      sinceUpload = 0;
      await submit(false);
    }
  }

  endpointer.reset();
  buffer.discard();
  onStatus({ state: 'cancelled', reason: 'stream-ended' });
  onRecording({ state: MIC_STATES.MUTED, recording: false });
  return { text: null, events, endpoint: null };
}

/* ─────────────────────── local wake gating (voice-04) ───────────────────────
   An on-device gate that decides *when to listen*, and is explicit that it
   decides nothing else.

   The phrase is a convenience trigger. It is not authentication: recorded audio
   replays it, a nearby speaker triggers it, and nothing here identifies a voice.
   No approval, permission or capability decision may be keyed to this signal —
   that is the whole safety property of the feature, and it is why the gate is a
   separate object from the capture path rather than a flag inside it.

   Two layers:

   1. `createWakeGate` — the state machine. Pure, no audio, no globals. States
      move idle → heard → listening → sending → idle, and an unexpected
      transition is a bug the caller sees, not something quietly tolerated.
   2. `startWakeListening` — the loop that makes "not yet awake" a real guarantee.
      Before the gate fires it *discards* audio instead of holding it: no blob is
      built, no chunk is posted, and `takeAudio` is not called. After it fires,
      the same capture answers one utterance and then goes back to idle.

   The matching is deliberately local: a transcript string, matched against a
   phrase, with no network call and no model. Whether a recogniser put that string
   there is the caller's business, and the caller is responsible for telling the
   user where audio went (see docs/VOICE.md).                                   */

/** The four states the issue names, plus `off` for "armed nowhere". */
export const WAKE_STATES = Object.freeze({
  OFF: 'off',
  IDLE: 'gate-idle',
  HEARD: 'gate-heard',
  LISTENING: 'listening',
  SENDING: 'sending',
});

/** Guards against a caller that keeps the gate open forever. */
export const WAKE_DEFAULTS = Object.freeze({
  // How long to wait for speech to start after the phrase. A phrase matched from
  // a stray word, a cough or a replayed clip must not hold the microphone open
  // waiting for an utterance that never comes.
  onsetTimeoutMs: 3_000,
  // How long one command may run before the gate closes itself again.
  maxUtteranceMs: 15_000,
  // After a command is sent, ignore the phrase briefly: a recogniser that repeats
  // its final result must not launch the same command twice.
  cooldownMs: 1_200,
});

const WAKE_WORD = 'quasnooze';

/**
 * Normalise a transcript for phrase matching.
 *
 * Only the words matter, so punctuation, case, extra whitespace, and the
 * pauses a recogniser renders as commas are all flattened. Kept ASCII so a
 * locale-specific "quasï¿½" style artefact in a transcript cannot smuggle a
 * different word past the match.
 */
export function normalizeWakeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The phrase, parsed once per gate.
 *
 * `match()` returns `{ heard, command }`. The command is the tail after the
 * phrase ("hey quasnooze, set a timer" → "set a timer"), which is how the
 * existing browser path already behaves: saying the phrase *and* the request in
 * one breath should work rather than needing two.
 */
export function parseWakePhrase(phrase = 'hey quasnooze') {
  const normalized = normalizeWakeText(phrase);
  const tokens = normalized.split(' ').filter(Boolean);
  if (!tokens.length) throw new TypeError('A wake phrase needs at least one word.');
  return Object.freeze({
    phrase: normalized,
    tokens: Object.freeze(tokens),
    /** True when the text contains the phrase as whole words, in order. */
    match(text) {
      const normalizedText = normalizeWakeText(text);
      if (!normalizedText) return { heard: false, command: '' };
      const words = normalizedText.split(' ');
      for (let start = 0; start + tokens.length <= words.length; start++) {
        if (tokens.every((token, offset) => words[start + offset] === token)) {
          return { heard: true, command: words.slice(start + tokens.length).join(' ').trim() };
        }
      }
      return { heard: false, command: '' };
    },
  });
}

/**
 * The gate state machine.
 *
 * Off by default — `createWakeGate()` with no arguments is `off`, and it takes an
 * explicit `arm()` to leave that state. Every transition notifies, so the UI can
 * always answer "is it armed?" without polling a private flag.
 */
export function createWakeGate({ phrase = 'hey quasnooze', armed = false, onChange = () => {}, now = () => Date.now() } = {}) {
  const matcher = parseWakePhrase(phrase);
  let state = armed ? WAKE_STATES.IDLE : WAKE_STATES.OFF;
  let lastAt = null;
  let lastCommand = '';

  const emit = (detail = {}) => {
    onChange({ state, armed: state !== WAKE_STATES.OFF, phrase: matcher.phrase, ...detail });
    return state;
  };

  /** Refuse to move between states the diagram does not allow. */
  const allowed = {
    [WAKE_STATES.OFF]: [WAKE_STATES.IDLE],
    [WAKE_STATES.IDLE]: [WAKE_STATES.HEARD, WAKE_STATES.OFF],
    [WAKE_STATES.HEARD]: [WAKE_STATES.LISTENING, WAKE_STATES.IDLE, WAKE_STATES.OFF],
    [WAKE_STATES.LISTENING]: [WAKE_STATES.SENDING, WAKE_STATES.IDLE, WAKE_STATES.OFF],
    [WAKE_STATES.SENDING]: [WAKE_STATES.IDLE, WAKE_STATES.OFF],
  };

  const move = (next, detail) => {
    if (next === state) return state;
    if (!allowed[state].includes(next)) {
      throw new Error(`Wake gate cannot go from ${state} to ${next}.`);
    }
    state = next;
    emit(detail);
    return state;
  };

  return Object.freeze({
    get state() { return state; },
    get armed() { return state !== WAKE_STATES.OFF; },
    get phrase() { return matcher.phrase; },
    get lastCommand() { return lastCommand; },

    /** Arm the gate. Explicit, per surface, and never implied by construction. */
    arm() {
      // Deliberately does not touch `lastAt`: the cooldown belongs to a phrase
      // that was heard, not to the moment the gate was armed. Seeding it here
      // made the first real phrase after arming look like a repeat.
      if (state === WAKE_STATES.OFF) move(WAKE_STATES.IDLE, { reason: 'armed' });
      return state;
    },

    /** Disarm and return to `off`. Safe to call from a page-hide handler. */
    disarm(reason = 'disarmed') {
      if (state !== WAKE_STATES.OFF) {
        state = WAKE_STATES.OFF;
        emit({ reason });
      }
      return state;
    },

    /**
     * Feed one transcript. Returns what happened, and never starts a command on
     * its own: `heard` only moves the gate to `gate-heard`, and the caller decides
     * whether to proceed. That separation is what stops a stray match from
     * sending audio automatically.
     */
    hear(transcript, at = now()) {
      if (state !== WAKE_STATES.IDLE) {
        return { heard: false, state, reason: state === WAKE_STATES.OFF ? 'disarmed' : 'not-idle' };
      }
      // Cooldown: a recogniser that repeats its final result must not re-fire.
      // Only forward time counts — a caller on a different clock (or a test with
      // synthetic timestamps) must not be mistaken for a repeat.
      const since = lastAt === null ? Infinity : at - lastAt;
      if (since >= 0 && since < WAKE_DEFAULTS.cooldownMs) {
        return { heard: false, state, reason: 'cooldown' };
      }
      const match = matcher.match(transcript);
      if (!match.heard) return { heard: false, state, reason: 'no-phrase' };
      lastAt = at;
      lastCommand = match.command;
      move(WAKE_STATES.HEARD, { command: match.command });
      return { heard: true, state, command: match.command };
    },

    /** The phrase fired and capture may begin. */
    listen() { return move(WAKE_STATES.LISTENING, { reason: 'capturing' }); },

    /**
     * A command is on its way out; audio for this turn is over.
     *
     * Named `dispatch`, not `send`: this is a state transition, not a network
     * call, and the panel already has a `send()` that posts to the model. Two
     * different `send`s in one file is how a reader concludes the gate is doing
     * something it is not.
     */
    dispatch() { return move(WAKE_STATES.SENDING, { reason: 'sending' }); },

    /** Back to watching for the phrase, or off entirely if it was disarmed. */
    reset(reason = 'done') {
      if (state === WAKE_STATES.OFF) return state;
      state = WAKE_STATES.IDLE;
      emit({ reason });
      return state;
    },
  });
}

/**
 * Run the gate in front of a capture loop.
 *
 * The guarantee this function exists to make true: **before the gate fires, no
 * audio leaves this function.** Not "no audio is sent to a model" — no audio is
 * even assembled, because `takeAudio` is not called and nothing is posted. A
 * recording is discarded on read, not stored and then dropped.
 *
 * `frames` yields `{ level, at }`; `transcribe` is called only while awake, once
 * per utterance. On page hide the caller disarms, which stops the loop and
 * releases the input.
 */
export async function startWakeListening({
  frames,
  gate,
  capture,
  transcribe,
  signal,
  maxUtteranceMs = WAKE_DEFAULTS.maxUtteranceMs,
  onsetTimeoutMs = WAKE_DEFAULTS.onsetTimeoutMs,
  onStatus = () => {},
} = {}) {
  if (!frames || !gate) throw new TypeError('Wake listening needs frames and a gate.');
  if (typeof capture !== 'function' || typeof transcribe !== 'function') {
    throw new TypeError('Wake listening needs capture() and transcribe().');
  }
  if (!gate.armed) {
    // Disarmed is not an error, but it is also not listening: say so plainly
    // rather than spinning on frames that will never be used.
    onStatus({ state: WAKE_STATES.OFF, reason: 'disarmed', sent: false });
    return { text: null, sent: false, reason: 'disarmed' };
  }

  const endpointer = createEndpointer();
  let awakeAt = null;
  let previousAt = null;
  let spoke = false;

  onStatus({ state: WAKE_STATES.IDLE, armed: true, phrase: gate.phrase, sent: false });

  for await (const frame of frames) {
    if (signal?.aborted) {
      gate.disarm('aborted');
      onStatus({ state: WAKE_STATES.OFF, reason: 'aborted', sent: false });
      throw new DOMException('Wake listening cancelled.', 'AbortError');
    }

    const at = Number(frame?.at);
    if (!Number.isFinite(at)) continue;

    // Awake phase: exactly one utterance, then back to watching.
    if (awakeAt !== null) {
      const delta = previousAt === null ? 0 : Math.max(0, at - previousAt);
      previousAt = at;
      const event = endpointer.push(frame?.level, at);
      if (event?.type === 'speech-start') spoke = true;
      const elapsed = at - awakeAt;

      // The phrase fired but nobody spoke: close the gate rather than hold the
      // microphone open for `maxUtteranceMs`. This is the difference between
      // "listening" and "waiting for something that is not coming".
      if (!spoke && elapsed >= onsetTimeoutMs) {
        endpointer.reset();
        gate.reset('no-speech');
        awakeAt = null;
        onStatus({ state: gate.state, reason: 'no-speech', sent: false });
        continue;
      }

      if (event?.type === 'endpoint' || elapsed >= maxUtteranceMs) {
        if (event?.discarded || elapsed >= maxUtteranceMs) {
          // Too short, or too long: either way there is nothing to send, and the
          // gate closes again rather than guessing at a command.
          gate.reset(event?.discarded ? 'too-short' : 'max-length');
          awakeAt = null;
          spoke = false;
          onStatus({ state: gate.state, reason: event?.discarded ? 'too-short' : 'max-length', sent: false });
          continue;
        }
        gate.dispatch();
        onStatus({ state: WAKE_STATES.SENDING, sent: true });
        try {
          const result = await transcribe(capture({ elapsedMs: elapsed, deltaMs: delta }));
          gate.reset('sent');
          awakeAt = null;
          spoke = false;
          onStatus({ state: gate.state, sent: true, text: result?.text ?? null });
          return { text: result?.text ?? null, sent: true };
        } catch (error) {
          gate.reset('failed');
          awakeAt = null;
          spoke = false;
          onStatus({ state: gate.state, reason: 'failed', message: String(error?.message || error), sent: true });
          return { text: null, sent: false, error };
        }
      }
      continue;
    }

    // Asleep phase. Audio is discarded, not accumulated: the frame's level is
    // used to decide nothing at all, because the phrase decides when to listen.
    const heard = frame?.transcript ? gate.hear(frame.transcript, at) : null;
    if (heard?.heard) {
      gate.listen();
      awakeAt = at;
      previousAt = null;
      spoke = false;
      endpointer.reset();
      onStatus({ state: WAKE_STATES.LISTENING, command: heard.command, sent: false });
    }
  }

  // The frame source ended — a closed tab, a mute, a released device.
  gate.disarm('stream-ended');
  onStatus({ state: WAKE_STATES.OFF, reason: 'stream-ended', sent: false });
  return { text: null, sent: false, reason: 'stream-ended' };
}

/**
 * Whether the gate may be used to authorise anything.
 *
 * It is a named function returning a constant `false` because the temptation is
 * real: a state machine that knows a phrase was said looks like it knows who said
 * it. It does not, and callers get an answer instead of a code comment.
 */
export function wakePhraseAuthenticates() {
  return false;
}
