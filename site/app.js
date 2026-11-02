"use strict";
const $ = (id) => document.getElementById(id);
const states = {
  idle: [
    "Here, with you.",
    "A quiet presence. No microphone is active on this website.",
  ],
  thinking: [
    "Following the thread.",
    "Illustrated thinking state—not a model running in this website.",
  ],
  speaking: [
    "A thought, out loud.",
    "Silent animation preview. No audio or microphone is active.",
  ],
  approval: [
    "Your call. Always.",
    "Illustrated permission state. This website cannot approve or run actions.",
  ],
};
for (const button of document.querySelectorAll("[data-phase]")) {
  if (button.tagName !== "BUTTON") continue;
  button.onclick = () => {
    const phase = button.dataset.phase;
    $("companion").dataset.phase = phase;
    $("phaseTitle").textContent = states[phase][0];
    $("phaseCopy").textContent = states[phase][1];
    document
      .querySelectorAll("button[data-phase]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  };
}
const groups = {
  everyday: [
    [
      "01 / EVERYDAY",
      "A small question. A simpler next step.",
      "Ask questions, draft a message, make a plan or set a reminder. Local reasoning uses your configured model; sleeping/offline hosts have reminder limitations.",
    ],
    [
      "02 / RESIDENT WINDOWS",
      "Nearby. Not always listening.",
      "Native tray/widget, a talk hotkey and opt-in local voice. The microphone starts muted. Real hardware acceptance remains pending.",
    ],
    [
      "03 / SUPPORTED ACTIONS",
      "Less clicking. More clarity.",
      "Time, system status, bounded file lookup and allowlisted app launches. Supported simple resident actions can skip model inference.",
    ],
  ],
  knowledge: [
    [
      "01 / YOUR DOCUMENTS",
      "Find the thread in your files.",
      "Bounded local document retrieval and supported attachments. Source provenance is not proof that every answer is correct.",
    ],
    [
      "02 / YOUR STYLE",
      "An assistant that adapts.",
      "Saved personas and remembered facts help shape conversation. Style preferences never override safety rules or grant tool permissions.",
    ],
    [
      "03 / YOUR HISTORY",
      "Pick up where you left off.",
      "Local conversation history and versioned personal-data export already exist. Full validated restore is a separate gated roadmap task.",
    ],
  ],
  tools: [
    [
      "01 / VISIBLE PERMISSIONS",
      "Ask before the important part.",
      "Sensitive tools require explicit approval. Read-tier commands can run without asking only when the classifier permits; blocked commands remain blocked.",
    ],
    [
      "02 / EXPLICIT EXTENSIONS",
      "Power, with boundaries.",
      "Optional MCP, declarative custom tools and local plugins extend the assistant. JavaScript plugins are not OS-sandboxed; enable only code you trust.",
    ],
    [
      "03 / HONEST RESULTS",
      "A failure is still information.",
      "Tool results and uncertainty stay visible. Closing a page or stopping voice is not a guarantee that a running backend action stopped.",
    ],
  ],
};
for (const button of document.querySelectorAll("[data-category]"))
  button.onclick = () => {
    document
      .querySelectorAll("[data-category]")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
    const fragment = document.createDocumentFragment();
    for (const [tag, title, copy] of groups[button.dataset.category]) {
      const article = document.createElement("article");
      for (const [type, text] of [
        ["span", tag],
        ["h3", title],
        ["p", copy],
      ]) {
        const el = document.createElement(type);
        el.textContent = text;
        article.append(el);
      }
      fragment.append(article);
    }
    $("featureGrid").replaceChildren(fragment);
  };
$("copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("commands").textContent);
    $("copyStatus").textContent =
      "Commands copied. Review before running; nothing was installed.";
  } catch {
    $("copyStatus").textContent =
      "Clipboard is unavailable. Select and copy the commands above.";
  }
};
const motion = matchMedia("(prefers-reduced-motion: reduce)");
document.body.classList.toggle("reduced", motion.matches);
$("motion").setAttribute("aria-pressed", String(motion.matches));
$("motion").onclick = () => {
  const reduced = document.body.classList.toggle("reduced");
  $("motion").setAttribute("aria-pressed", String(reduced));
  $("motion").textContent = reduced ? "Motion reduced" : "Reduce motion";
};
