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
