import { createVisualizer, nativeSignal } from "/visualizer.js";
let motion;
function mount() {
  motion = createVisualizer(document.getElementById("voiceCanvas"));
  const presence = document.getElementById("presence");
  motion.setState(presence.dataset.phase);
}
function update(event) {
  motion?.setState(event.detail.phase);
  motion?.setSignal(nativeSignal(event.detail));
}
window.addEventListener("quasnooze:motion", update);
window.addEventListener("pagehide", event => {
  if (event.persisted) return;
  window.removeEventListener("quasnooze:motion", update);
  motion?.destroy(); motion = null;
});
mount();
