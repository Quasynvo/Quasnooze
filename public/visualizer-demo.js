import { createVisualizer } from "./visualizer.js";
import { createDemoSignal } from "./demo-signal.js";
import { startAudioAnalysis } from "./audio-input.js";
const $ = id => document.getElementById(id);
const descriptions = {
  idle: ["Idle · a quiet presence", "A slow-breathing glass core and softly drifting interference ribbons."],
  listening: ["Listening · shaped by sound", "A fluid ring expands and ripples. With the mic on, its shape follows live frequency bands."],
  thinking: ["Processing · following the thread", "Accelerating orbital trails and phase-offset ribbons suggest activity—not measured progress."],
  speaking: ["Speaking · signal in motion", "A luminous radial spectrum. Output-reactive analysis requires a connected output analyser."],
  error: ["Interrupted · check the signal", "A brief, damped shake and a crimson/amber shift. Read the message; no action is implied."],
};
let state = "idle", demo = true, session = null, pending = false, generation = 0, captureAbort = null;
const demoSignal = createDemoSignal();
const motion = createVisualizer($("voiceCanvas"), {
  signalProvider: () => session?.active ? session.sample() : demo ? demoSignal(state) : null,
});
function render() {
  $("stage").dataset.state = state;
  motion.setState(state);
  document.querySelectorAll("button[data-state]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.state === state)));
  $("stateTitle").textContent = descriptions[state][0];
  $("stateDetail").textContent = descriptions[state][1] + (!session && demo && ["listening", "speaking"].includes(state) ? " Silent synthetic preview." : "");
  $("signalSource").textContent = session ? "LIVE MICROPHONE · LOCAL ANALYSIS ONLY" : demo && ["listening", "speaking"].includes(state) ? "SILENT SYNTHETIC DEMO · NO AUDIO SAMPLES" : "STATE-DRIVEN MOTION · NO AUDIO SAMPLES";
  $("inputLabel").textContent = session ? "INPUT / MICROPHONE" : "INPUT / OFF";
  $("demoButton").textContent = "Silent demo: " + (demo ? "on" : "off");
  $("demoButton").setAttribute("aria-pressed", String(demo));
}
function stopMic(message = "Microphone off. No audio is retained.") {
  generation++; pending = false;
  captureAbort?.abort(); captureAbort = null;
  session?.stop(); session = null;
  motion.setSignal({ source: "none", timestamp: performance.now() });
  $("micButton").textContent = "Enable microphone"; $("micButton").disabled = false;
  $("micNotice").textContent = message; $("micNotice").classList.remove("error");
  render();
}
for (const button of document.querySelectorAll("button[data-state]")) button.onclick = () => {
  // Microphone samples describe input, never TTS output or model computation.
  if ((session || pending) && button.dataset.state !== "listening") {
    stopMic("Microphone off. This state uses silent, synthetic preview motion.");
    demo = true;
  }
  state = button.dataset.state; render();
};
$("micButton").onclick = async () => {
  if (session || pending) { stopMic(); return; }
  const ticket = ++generation;
  captureAbort = new AbortController();
  pending = true; demo = false; state = "idle"; render();
  $("micButton").textContent = "Cancel microphone request";
  $("micNotice").textContent = "Waiting for microphone permission. You can cancel or continue with text.";
  try {
    const next = await startAudioAnalysis({ signal: captureAbort.signal, onEnded: () => {
      if (ticket !== generation) return;
      stopMic("Microphone disconnected or released by the OS. Reconnect it and try again.");
      state = "error"; render(); $("stateDetail").textContent = "Microphone input ended. No audio is retained.";
    } });
    if (ticket !== generation) { next.stop(); return; }
    session = next;
    state = "listening";
    render();
    $("micButton").textContent = "Turn microphone off";
    $("micNotice").textContent = "Microphone is on. Speak to shape the ring. This local analyser does not transcribe or upload audio.";
  } catch (error) {
    if (ticket !== generation) return;
    state = "error"; render();
    $("micNotice").textContent = error.message; $("micNotice").classList.add("error");
    $("stateDetail").textContent = error.message;
  } finally {
    if (ticket === generation) { pending = false; $("micButton").disabled = false; }
  }
};
$("demoButton").onclick = () => { if (session || pending) stopMic(); demo = !demo; render(); };
const media = matchMedia("(prefers-reduced-motion: reduce)");
function reflectMotion() { $("motionLabel").textContent = $("reduceMotion").checked ? "MOTION / REDUCED" : "MOTION / ACTIVE"; }
$("reduceMotion").checked = media.matches;
motion.setReducedMotion(media.matches); reflectMotion();
$("reduceMotion").onchange = () => { motion.setReducedMotion($("reduceMotion").checked); reflectMotion(); };
media.addEventListener("change", event => { $("reduceMotion").checked = event.matches; motion.setReducedMotion(event.matches); reflectMotion(); });
window.addEventListener("pagehide", event => { stopMic(); if (!event.persisted) motion.destroy(); });
document.addEventListener("visibilitychange", () => { if (document.hidden && (session || pending)) stopMic("Microphone released while this page was hidden. Enable it again when ready."); });
render();
