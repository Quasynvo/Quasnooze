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
