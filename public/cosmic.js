/** Quasnooze conversation UI: no browser speech/recording, third-party scripts or auto approvals. */
import { createVisualizer, nativeSignal } from "./visualizer.js";
import { createDemoSignal } from "./demo-signal.js";
export function consumeFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n"),
    rest = parts.pop();
  const events = [];
  for (const frame of parts) {
    let event = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length) {
      try {
        events.push({ event, data: JSON.parse(data.join("\n")) });
      } catch {
        throw Error("The service sent an invalid response.");
      }
    }
  }
  return { events, rest };
}
export function phaseFor(event) {
  if (event === "approval") return "approval";
  if (event === "listening") return "listening";
  if (event === "armed") return "idle";
  if (event === "speaking") return "speaking";
  if (["status", "tool", "tool_done", "delta", "working"].includes(event))
    return "thinking";
  if (["error", "attention"].includes(event)) return "attention";
  return "idle";
}
if (typeof document !== "undefined") init();
function init() {
  const byId = (id) => document.getElementById(id),
    params = new URLSearchParams(location.search);
  let key = params.get("key") || "";
  if (key) {
    params.delete("key");
    history.replaceState(
      null,
      "",
      location.pathname + (params.size ? "?" + params : ""),
    );
  }
  let demo =
    params.has("demo") || document.documentElement.dataset.preview === "true";
  let connected = false,
    busy = false,
    nativeBusy = false,
    previewing = false,
    native = null,
    pending = null,
    session = newSession(),
    nativeText = "",
    polling = false;
  const demoSignal = createDemoSignal();
  const motion = createVisualizer(document.getElementById("voiceCanvas"), {
    signalProvider: () => (demo || previewing) ? demoSignal(document.body.dataset.state) : document.body.dataset.state === "listening" ? nativeSignal(native) : null,
  });
  const timers = new Set();
  const details = {
    idle: [
      "Here, with you.",
      "Calm is a personality. Not an artificial delay.",
    ],
    thinking: [
      "Following the thread.",
      "Receiving text or working—not speaking audio.",
    ],
    listening: [
      "Listening, locally.",
      "Reported by the native Windows voice host.",
    ],
    speaking: [
      "A thought, out loud.",
      "Native speech state; decorative spectrum, not output-frequency analysis.",
    ],
    approval: [
      "Your call. Always.",
      "Nothing is approved by an animation or a spoken “yes”.",
    ],
    attention: [
      "Let’s check that.",
      "See the conversation for the actual connection or request status.",
    ],
  };
  function newSession() {
    return "cosmic-" + crypto.randomUUID();
  }
  function state(phase, detail) {
    document.body.dataset.state = phase;
    motion.setState(phase);
    const liveInput = !demo && !previewing && phase === "listening" && native?.mic && Number.isFinite(native.audioLevel) && Number.isFinite(native.audioAgeMs) && native.audioAgeMs >= 0 && native.audioAgeMs < 2000;
    byId("signalSource").textContent = (demo || previewing) ? "SILENT SYNTHETIC PREVIEW · NO AUDIO SAMPLES" : liveInput ? "NATIVE INPUT LEVEL · SCALAR, NOT FFT" : phase === "speaking" ? "NATIVE SPEECH STATE · DECORATIVE SPECTRUM" : "STATE-DRIVEN MOTION · NO AUDIO SAMPLES";
    byId("stateTitle").textContent = details[phase]?.[0] || details.idle[0];
    byId("stateDetail").textContent =
      detail || details[phase]?.[1] || details.idle[1];
  }
  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }
  function controls() {
    byId("send").disabled =
      busy || nativeBusy || previewing || (!demo && !connected);
    byId("newChat").disabled = busy || nativeBusy || previewing;
    byId("talk").disabled =
      busy ||
      nativeBusy ||
      previewing ||
      (!demo && (!connected || !native?.available));
    byId("stopVoice").disabled = demo || !connected || !native?.available;
    byId("demoToggle").disabled = busy || nativeBusy || previewing;
    byId("animate").disabled =
      busy || nativeBusy || previewing || Boolean(pending);
  }
  function message(who, text = "") {
    document.querySelector(".welcome")?.remove();
    const article = document.createElement("article");
    article.className = "message " + who;
    const label = document.createElement("div");
    label.className = "speaker";
    label.textContent =
      who === "user"
        ? "YOU"
        : demo
          ? "QUASNOOZE · SCRIPTED PREVIEW"
          : "QUASNOOZE · LOCAL ASSISTANT";
    const body = document.createElement("div");
    body.textContent = text;
    article.append(label, body);
    byId("messages").append(article);
    while (byId("messages").children.length > 30)
      byId("messages").firstElementChild.remove();
    body.scrollIntoView({ block: "nearest" });
    return body;
  }
  async function api(path, data) {
    const response = await fetch(path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-quasnooze-key": key } : {}),
      },
      signal: AbortSignal.timeout(7000),
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "Instance key required. Open settings."
          : `Quasnooze request failed (HTTP ${response.status}).`,
      );
    return response.json();
  }
  function mode() {
    byId("connection").textContent = demo
      ? "SCRIPTED DESIGN PREVIEW"
      : connected
        ? "QUASNOOZE SERVICE CONNECTED"
        : "SERVICE NOT CONNECTED";
    byId("modeNotice").textContent = demo
      ? "SCRIPTED PREVIEW · Not an AI response. No tools or audio capture. Previewing does not mute a separately running native voice host."
      : connected
        ? "REAL BACKEND · Existing Quasnooze permissions apply. Conversations may be stored by Quasnooze."
        : "Not connected. Connect to Quasnooze in settings, or explicitly try the scripted preview.";
    byId("demoToggle").textContent = demo
      ? "Connect real Quasnooze instead"
      : "Try scripted preview";
    if (demo) {
      byId("backendLabel").textContent =
        "Scripted interaction · no model or tools called.";
      byId("micLabel").textContent = "PREVIEW · MIC NOT VERIFIED";
    }
    controls();
  }
  async function refresh() {
    if (demo || polling || document.hidden) return;
    polling = true;
    try {
      const health = await api("/api/health");
      connected = true;
      byId("backendLabel").textContent =
        `Configured backend: ${health.provider || "unknown"} · ${health.model || "model unknown"}`;
      native = await api("/api/desktop");
      nativeBusy =
        Boolean(native.busy) ||
        ["listening", "working", "speaking", "approval"].includes(native.phase);
      byId("micLabel").textContent =
        native.available && typeof native.mic === "boolean"
          ? native.mic
            ? "MIC: ON · WINDOWS"
            : "MIC: OFF · WINDOWS"
          : "NATIVE MIC: UNAVAILABLE";
      if (!busy && !previewing) {
        state(phaseFor(native.phase));
        if (native.approval)
          approval(native.approval.id, native.approval.description, "native", native.approval.preview);
        else if (pending?.kind === "native") {
          pending = null;
          byId("approval").hidden = true;
        }
        if (
          native.text &&
          native.text !== nativeText &&
          native.recent?.length
        ) {
          nativeText = native.text;
          message("assistant", native.text);
        }
      }
    } catch (err) {
      connected = false;
      native = null;
      nativeBusy = false;
      byId("micLabel").textContent = "MIC: UNKNOWN · CHECK NATIVE TRAY";
      if (!busy && !previewing)
        state(
          "attention",
          "Connection unavailable. This page cannot verify or mute a native microphone.",
        );
    } finally {
      polling = false;
      mode();
    }
  }
  function approval(id, description, kind = "web", preview) {
    pending = { id, kind };
    byId("approvalText").textContent = String(
      description || "Review this action in the native Windows host.",
    );
    if (preview) byId("approvalText").textContent += "\n" + globalThis.approvalPreviewText(preview);
    byId("approval").hidden = false;
    state("approval");
  }
  async function decide(allowed) {
    if (!pending) return;
    const target = pending;
    pending = null;
    byId("allow").disabled = byId("deny").disabled = true;
    try {
      if (demo) throw Error("Preview animations cannot approve real actions.");
      await api(
        target.kind === "native" ? "/api/desktop" : "/api/approve",
        target.kind === "native"
          ? { approval: { id: target.id, allowed } }
          : { id: target.id, allowed },
      );
      if (!pending || pending === target) {
        pending = null;
        byId("approval").hidden = true;
        state(busy ? "thinking" : "idle");
      }
    } catch (err) {
      if (busy && !pending) pending = target;
      else byId("approval").hidden = true;
      message(
        "assistant",
        err.message +
          " Permission reply could not be confirmed; check Quasnooze before retrying.",
      );
      state("attention");
    } finally {
      byId("allow").disabled = byId("deny").disabled = false;
    }
  }
  byId("allow").onclick = () => decide(true);
  byId("deny").onclick = () => decide(false);
  async function send(text) {
    if (
      !text.trim() ||
      busy ||
      nativeBusy ||
      previewing ||
      (!demo && !connected)
    )
      return;
    busy = true;
    controls();
    message("user", text);
    const answer = message("assistant");
    state("thinking");
    if (demo) {
      answer.textContent =
        "Scripted preview: this is how a reply will appear. A real model is not connected in this mode. Connect your Quasnooze instance to have this conversation for real.";
      state("thinking", "Scripted state preview—not model inference.");
      later(() => {
        state(
          "speaking",
          "Simulated speaking animation · no audio is playing.",
        );
        later(() => {
          state("idle", "Scripted preview complete. No microphone was used.");
          busy = false;
          controls();
        }, 2400);
      }, 900);
      return;
    }
    let complete = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(key ? { "x-quasnooze-key": key } : {}),
        },
        body: JSON.stringify({ sessionId: session, text }),
      });
      if (!response.ok || !response.body)
        throw Error(`Chat unavailable (HTTP ${response.status}).`);
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), {
            stream: !done,
          });
          if (done && buffer.trim()) buffer += "\n\n";
          const parsed = consumeFrames(buffer);
          buffer = parsed.rest;
          if (buffer.length > 262144)
            throw Error("Service response exceeded the frame limit.");
          for (const { event, data } of parsed.events) {
            if (event === "step" && data.type === "approval")
              approval(data.id, data.description, "web", data.preview);
            else if (event === "step" && data.type === "delta") {
              answer.textContent = (
                answer.textContent + String(data.text || "")
              ).slice(0, 80000);
              if (!pending) state("thinking");
            } else if (event === "step" && ["tool", "auto"].includes(data.type))
              state(
                "thinking",
                `${data.type === "auto" ? "Reported automatic action" : "Tool"}: ${String(data.name || "unknown")}`,
              );
            else if (event === "final") {
              answer.textContent = String(data.text || "No response text.");
              complete = true;
              state(data.error ? "attention" : "idle");
            } else if (event === "error")
              throw Error(
                String(data.message || "The backend reported an error."),
              );
          }
          if (done) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (!complete)
        throw Error(
          "Connection ended before completion. The backend task may still be running; check the current Quasnooze deck.",
        );
    } catch (err) {
      answer.textContent += "\n" + err.message;
      state("attention");
    } finally {
      if (pending?.kind === "web") {
        const target = pending;
        pending = null;
        byId("approval").hidden = true;
        try {
          await api("/api/approve", { id: target.id, allowed: false });
        } catch {
          message(
            "assistant",
            "Could not confirm denial of the pending action. Check Quasnooze before continuing.",
          );
        }
      }
      busy = false;
      controls();
    }
  }
  byId("composer").onsubmit = (e) => {
    e.preventDefault();
    const text = byId("prompt").value;
    if (!text.trim() || byId("send").disabled) return;
    byId("prompt").value = "";
    send(text);
  };
  byId("prompt").onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      byId("composer").requestSubmit();
    }
  };
  document.querySelectorAll("[data-prompt]").forEach(
    (button) =>
      (button.onclick = () => {
        byId("prompt").value = button.dataset.prompt;
        byId("prompt").focus();
      }),
  );
  byId("newChat").onclick = () => {
    if (busy || nativeBusy || previewing) return;
    session = newSession();
    byId("messages").replaceChildren();
    message(
      "assistant",
      "A fresh conversation. This resets this view, not your stored Quasnooze history.",
    );
  };
  byId("demoToggle").onclick = () => {
    if (busy || nativeBusy || previewing) return;
    demo = !demo;
    native = null;
    pending = null;
    byId("approval").hidden = true;
    session = newSession();
    byId("messages").replaceChildren();
    state("idle");
    mode();
    if (!demo) refresh();
  };
  function preview(listening = false) {
    if (busy || nativeBusy || previewing || pending) return;
    previewing = true;
    controls();
    state(
      listening ? "listening" : "thinking",
      "SIMULATED STATE · no microphone, inference or audio playback.",
    );
    later(() => {
      state(
        "speaking",
        "SIMULATED SPEAKING · illustrative animation, no audio playback.",
      );
      later(() => {
        state("idle", "Animation preview complete. No action was performed.");
        previewing = false;
        controls();
      }, 2600);
    }, 1200);
  }
  byId("animate").onclick = () => preview();
  byId("talk").onclick = async () => {
    if (demo) {
      preview(true);
      return;
    }
    try {
      await api("/api/desktop", { control: "listen" });
      await refresh();
    } catch (err) {
      message("assistant", err.message);
      state("attention");
    }
  };
  byId("stopVoice").onclick = async () => {
    try {
      await api("/api/desktop", { control: "stop-voice" });
      await refresh();
    } catch (err) {
      message("assistant", err.message);
      state(
        "attention",
        "Could not verify stop. Use the native tray to mute or quit.",
      );
    }
  };
  byId("settings").onclick = () => byId("settingsDialog").showModal();
  byId("connect").onclick = () => {
    if (busy || previewing || nativeBusy) return;
    key = byId("accessKey").value;
    byId("accessKey").value = "";
    demo = false;
    byId("settingsDialog").close();
    refresh();
  };
  byId("reduceMotion").onchange = () =>
    document.body.classList.toggle("reduced", byId("reduceMotion").checked);
  byId("reduceMotion").checked = matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  document.body.classList.toggle("reduced", byId("reduceMotion").checked);
  byId("reduceMotion").addEventListener("change", () => motion.setReducedMotion(byId("reduceMotion").checked));
  motion.setReducedMotion(byId("reduceMotion").checked);
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("paused", document.hidden);
    if (!document.hidden) refresh();
  });
  window.addEventListener("pagehide", event => {
    for (const timer of timers) clearTimeout(timer);
    if (!event.persisted) motion.destroy();
  });
  mode();
  if (!demo) refresh();
  setInterval(refresh, 2200);
}
