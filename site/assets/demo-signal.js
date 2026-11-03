/** Explicit, silent synthetic data for design previews. Never label this as microphone input. */
export function createDemoSignal() {
  const bands = new Float32Array(48);
  return (state, now = performance.now()) => {
    if (state !== "listening" && state !== "speaking") return { source: "none", timestamp: now };
    const t = now / 1000;
    const envelope = 0.2 + 0.3 * (Math.sin(t * 2.1) + 1) / 2;
    for (let i = 0; i < bands.length; i++) bands[i] = Math.max(0, Math.min(1, envelope * (0.4 + 0.6 * Math.sin(i * 0.24 + t * 3) ** 2)));
    return { source: "demo", level: envelope, bands, timestamp: now };
  };
}
