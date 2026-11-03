/**
 * Quasnooze Fluid Motion — a dependency-free, audio-independent Canvas 2D engine.
 * Rendering never opens a microphone, starts speech or changes application state.
 * Signal sources: none (decorative), native (scalar), spectrum (FFT), demo (synthetic).
 */
export const MOTION_STATES = Object.freeze(["idle", "listening", "thinking", "speaking", "error"]);
const ALIASES = { working: "thinking", processing: "thinking", attention: "error", interrupted: "error", output: "speaking", ready: "idle", muted: "idle", "not-running": "idle", armed: "idle", approval: "idle" };
export function normalizeState(value) {
  const state = Object.hasOwn(ALIASES, value) ? ALIASES[value] : value;
  return MOTION_STATES.includes(state) ? state : "idle";
}
export const PALETTES = Object.freeze({
  idle: [[110, 231, 249], [167, 139, 250]],
  listening: [[110, 231, 249], [240, 171, 252]],
  thinking: [[167, 139, 250], [255, 191, 105]],
  speaking: [[157, 248, 255], [240, 171, 252]],
  error: [[251, 113, 133], [255, 191, 105]],
  approval: [[255, 191, 105], [167, 139, 250]],
});
const clamp = (n, low = 0, high = 1) => Math.min(high, Math.max(low, Number.isFinite(n) ? n : low));
const mix = (a, b, t) => a + (b - a) * t;
const TAU = Math.PI * 2;
const BAND_COUNT = 48;

/** Copy and validate a signal. Missing/stale audio is never replaced with fake FFT data. */
export function normalizeSignal(input = {}, now = performance.now()) {
  const source = ["native", "spectrum", "demo"].includes(input.source) ? input.source : "none";
  const ttl = source === "native" ? 2600 : 450;
  const fresh = source !== "none" && Number.isFinite(input.timestamp) && now - input.timestamp >= 0 && now - input.timestamp < ttl;
  const bands = new Float32Array(BAND_COUNT);
  if (fresh && input.bands?.length) {
    for (let i = 0; i < BAND_COUNT; i++) bands[i] = clamp(input.bands[Math.floor(i * input.bands.length / BAND_COUNT)]);
  }
  return { source: fresh ? source : "none", level: fresh ? clamp(input.level) : 0, bands, timestamp: input.timestamp ?? now };
}

/** Map the existing desktop API honestly: one amplitude sample, not a frequency spectrum. */
export function nativeSignal(state, now = performance.now()) {
  const live = state?.mic === true && Number.isFinite(state.audioLevel) && Number.isFinite(state.audioAgeMs) && state.audioAgeMs >= 0 && state.audioAgeMs < 2000;
  return normalizeSignal({ source: "native", level: live ? state.audioLevel / 100 : 0, timestamp: now - (live ? state.audioAgeMs : 3000) }, now);
}

export function createVisualizer(canvas, options = {}) {
  if (!canvas?.getContext) throw new TypeError("A canvas element is required.");
  const ctx = canvas.getContext("2d", { alpha: true });
  const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let reduced = options.reducedMotion ?? media?.matches ?? false;
  let reducedOverride = options.reducedMotion !== undefined;
  let state = "idle", rawState = "idle", stateSince = 0, clock = 0, last = 0, raf = 0;
  let width = 0, height = 0, visible = true, disposed = false, contextLost = false;
  let signal = normalizeSignal({}, 0);
  const signalProvider = options.signalProvider;
  let level = 0, velocity = 0, spin = 0, spinSpeed = 0.12;
  const smoothedBands = new Float32Array(BAND_COUNT);
  let palette = PALETTES.idle.map(c => [...c]);
  const particles = Array.from({ length: 28 }, (_, i) => ({ angle: i * 2.399963, orbit: 1.12 + (i % 5) * 0.07, size: 0.65 + (i % 3) * 0.35 }));
  const maxDpr = options.maxDpr ?? 2;
  const interval = 1000 / (options.maxFps ?? 60);

  function fallback() {
    canvas.parentElement?.classList.add("is-static");
  }
  if (!ctx) fallback();
  function resize() {
    if (disposed || !ctx) return;
    const box = canvas.getBoundingClientRect();
    width = Math.max(1, box.width || options.width || 480);
    height = Math.max(1, box.height || options.height || 480);
    const dpr = Math.min(maxDpr, globalThis.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!contextLost) canvas.parentElement?.classList.remove("is-static");
    draw(0);
  }
  const rgba = (c, alpha) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${clamp(alpha)})`;
  function point(angle, radius, ribbon, t, r) {
    const energy = state === "listening" ? level * 0.12 : state === "speaking" ? level * 0.065 : 0;
    const harmonic = Math.sin(angle * 3 + t * 0.7 + ribbon * 1.8) * 0.035 + Math.cos(angle * 5 - t * 0.45 + ribbon) * 0.017;
    const band = signal.bands[Math.floor(((angle % TAU) / TAU) * BAND_COUNT)] || 0;
    const wave = state === "listening" ? band * 0.075 : 0;
    const rr = r * (radius + harmonic + energy * Math.sin(angle * 2 + t) + wave);
    return [Math.cos(angle) * rr, Math.sin(angle) * rr * (0.88 + ribbon * 0.035)];
  }
  function draw(dt) {
    if (!ctx || disposed || contextLost || !width) return;
    const t = reduced ? 2.4 : clock / 1000;
    const still = reduced;
    const target = still ? 0 : signal.level;
    if (still) { level = 0; velocity = 0; }
    else {
      // Fixed-size substeps keep the spring stable after a delayed frame.
      let remaining = Math.min(dt, 0.06);
      while (remaining > 0) {
        const step = Math.min(remaining, 1 / 120);
        velocity += ((target - level) * 150 - velocity * 23) * step;
        level = clamp(level + velocity * step);
        remaining -= step;
      }
    }
    const targetPalette = Object.hasOwn(PALETTES, rawState) ? PALETTES[rawState] : PALETTES[state];
    const colorEase = still ? 1 : 1 - Math.exp(-dt * 10);
    for (let c = 0; c < 2; c++) for (let k = 0; k < 3; k++) palette[c][k] = mix(palette[c][k], targetPalette[c][k], colorEase);
    const desiredSpeed = state === "thinking" ? 1.65 : state === "speaking" ? 0.48 : state === "listening" ? 0.3 : 0.12;
    spinSpeed = still ? 0 : mix(spinSpeed, desiredSpeed, 1 - Math.exp(-Math.max(dt, 1 / 60) * 2.5));
    spin += spinSpeed * Math.min(dt, 0.06);
    for (let i = 0; i < BAND_COUNT; i++) smoothedBands[i] = still ? 0 : mix(smoothedBands[i], signal.bands[i], 1 - Math.exp(-Math.max(dt, 1 / 60) * 16));

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    const errorAge = (clock - stateSince) / 1000;
    const shake = !still && state === "error" && errorAge < 0.42 ? Math.sin(errorAge * 55) * Math.exp(-errorAge * 11) * Math.min(width * 0.012, 5) : 0;
    ctx.translate(width / 2 + shake, height / 2);
    const breath = still ? 1 : 1 + Math.sin(t * 1.15) * (state === "idle" ? 0.022 : 0.009);
    const r = Math.min(width, height) * 0.285 * breath * (1 + level * 0.08);
    const glow = ctx.createRadialGradient(0, 0, r * 0.25, 0, 0, r * 1.8);
    glow.addColorStop(0, rgba(palette[0], 0.055));
    glow.addColorStop(0.55, rgba(palette[1], 0.08 + level * 0.035));
    glow.addColorStop(1, rgba(palette[0], 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-r * 1.8, -r * 1.8, r * 3.6, r * 3.6);

    // The dark glass core gives the ribbons a stable center instead of a full-screen flash.
    const core = ctx.createRadialGradient(-r * 0.3, -r * 0.4, 0, 0, 0, r * 0.86);
    core.addColorStop(0, "rgba(43,62,88,.48)");
    core.addColorStop(0.65, "rgba(12,21,37,.72)");
    core.addColorStop(1, "rgba(7,12,24,.12)");
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, TAU); ctx.fill();

    // Signature: three phase-offset interference ribbons, not a stock equalizer.
    const ribbons = state === "thinking" ? 4 : 3;
    for (let ribbon = ribbons - 1; ribbon >= 0; ribbon--) {
      ctx.save();
      ctx.rotate(spin * (ribbon % 2 ? -0.55 : 0.4) + ribbon * 0.75);
      const gradient = ctx.createLinearGradient(-r, -r, r, r);
      gradient.addColorStop(0, rgba(palette[0], 0.9));
      gradient.addColorStop(0.5, rgba(palette[1], 0.65));
      gradient.addColorStop(1, rgba(palette[0], 0.95));
      ctx.strokeStyle = gradient;
      ctx.lineJoin = "round";
      for (let layer = 0; layer < 3; layer++) {
        ctx.beginPath();
        const radius = 0.89 + ribbon * 0.072 + layer * 0.012;
        for (let i = 0; i <= 144; i++) {
          const angle = i / 144 * TAU;
          const [x, y] = point(angle, radius, ribbon, t, r);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.globalAlpha = layer === 1 ? 0.82 : 0.16;
        ctx.lineWidth = layer === 1 ? (state === "speaking" ? 1.9 : 1.35) : 4.5;
        ctx.shadowColor = rgba(palette[ribbon % 2], 0.6);
        ctx.shadowBlur = layer === 1 ? 9 : 0;
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    if (state === "thinking") {
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i], a = p.angle + spin * (0.7 + i % 3 * 0.2);
        const x = Math.cos(a) * r * p.orbit, y = Math.sin(a) * r * p.orbit * 0.78;
        ctx.fillStyle = rgba(palette[i % 2], 0.25 + (i % 4) * 0.15);
        ctx.beginPath(); ctx.arc(x, y, p.size, 0, TAU); ctx.fill();
      }
    }
    if (state === "speaking") {
      // With no output analyser this is explicitly a decorative pulse, not measured TTS audio.
      const measured = signal.source === "spectrum" || signal.source === "demo";
      for (let i = 0; i < BAND_COUNT; i++) {
        const a = i / BAND_COUNT * TAU - Math.PI / 2;
        const synthetic = (Math.sin(i * 0.63 + t * 6) * Math.sin(i * 0.19 - t * 3) + 1) * 0.5;
        const energy = measured ? (signal.source === "demo" ? synthetic * 0.65 + smoothedBands[i] * 0.35 : smoothedBands[i]) : synthetic * 0.3;
        const length = r * (0.025 + (still ? 0.035 : energy * 0.2));
        ctx.strokeStyle = rgba(palette[i % 2], 0.5 + energy * 0.45);
        ctx.lineWidth = Math.max(1.5, r * 0.013); ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.61, Math.sin(a) * r * 0.61);
        ctx.lineTo(Math.cos(a) * (r * 0.61 + length), Math.sin(a) * (r * 0.61 + length)); ctx.stroke();
      }
    }
    // Two small core wave lines are the compact, recognisable Quasnooze signature.
    for (let line = 0; line < 2; line++) {
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const x = (i / 40 - 0.5) * r * 0.62;
        const y = Math.sin(i / 40 * TAU + t * (still ? 0 : 1.3) + line * Math.PI) * r * 0.065 + (line - 0.5) * r * 0.09;
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(palette[line], 0.7); ctx.lineWidth = 1.4; ctx.stroke();
    }
    ctx.restore();
  }
  function tick(now) {
    raf = 0;
    if (disposed || reduced || !visible || document.hidden) return;
    const elapsed = now - last;
    if (elapsed >= interval - 0.5) {
      const dt = Math.min(elapsed / 1000, 0.06);
      clock += dt * 1000;
      if (signalProvider) {
        try { signal = normalizeSignal(signalProvider() || {}, now); }
        catch { signal = normalizeSignal({}, now); }
      }
      if (now - signal.timestamp > (signal.source === "native" ? 2600 : 450)) signal = normalizeSignal({}, now);
      draw(dt); last = now;
    }
    raf = requestAnimationFrame(tick);
  }
  function sync() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (!disposed && visible && !document.hidden && !reduced && ctx && !contextLost) {
      last = performance.now(); raf = requestAnimationFrame(tick);
    } else draw(0);
    canvas.dataset.running = String(Boolean(raf));
    canvas.dataset.reducedMotion = String(reduced);
  }
  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  const intersection = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }) : null;
  const visibility = () => sync();
  const preference = e => { if (!reducedOverride) { reduced = e.matches; sync(); } };
  const lost = e => { e.preventDefault(); contextLost = true; fallback(); sync(); };
  const restored = () => { contextLost = false; canvas.parentElement?.classList.remove("is-static"); resize(); sync(); };
  observer?.observe(canvas); intersection?.observe(canvas);
  document.addEventListener("visibilitychange", visibility);
  media?.addEventListener("change", preference);
  canvas.addEventListener("contextlost", lost);
  canvas.addEventListener("contextrestored", restored);
  globalThis.addEventListener?.("resize", resize);
  resize(); sync();
  return {
    setState(value) {
      if (disposed) return;
      const next = normalizeState(value), raw = Object.hasOwn(PALETTES, value) ? value : next;
      if (next !== state || raw !== rawState) stateSince = clock;
      state = next; rawState = raw;
      canvas.dataset.motionState = next;
      if (reduced) draw(0);
    },
    setSignal(value) { if (!disposed) signal = normalizeSignal(value); },
    setReducedMotion(value) { if (!disposed) { reducedOverride = true; reduced = Boolean(value); sync(); } },
    /** Deterministic rendering for documentation captures; not used by the live UI. */
    renderAt(milliseconds) { if (!disposed) { clock = milliseconds; draw(1 / 60); } },
    getDiagnostics() { return { state, source: signal.source, reducedMotion: reduced, running: Boolean(raf), disposed }; },
    destroy() {
      disposed = true; cancelAnimationFrame(raf); raf = 0;
      canvas.dataset.running = "false";
      observer?.disconnect(); intersection?.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      media?.removeEventListener("change", preference);
      canvas.removeEventListener("contextlost", lost); canvas.removeEventListener("contextrestored", restored);
      globalThis.removeEventListener?.("resize", resize);
    },
  };
}
