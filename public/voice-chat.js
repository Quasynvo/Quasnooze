/** Voice-first client for the local Quasnooze chat API. */
export async function* readSse(response) {
  if (!response?.ok) throw new Error(`Assistant request failed (HTTP ${response?.status || "unknown"}).`);
  if (!response.body?.getReader) throw new Error("This browser cannot read the assistant response stream. Try the full chat panel.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", eventName = "message", data = [];
  const dispatch = () => {
    if (!data.length) { eventName = "message"; return null; }
    const item = { event: eventName, data: data.join("\n") };
    eventName = "message"; data = [];
    try { item.data = JSON.parse(item.data); } catch { /* retain plain SSE data for a useful error */ }
    return item;
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/g, "\n");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line) { const item = dispatch(); if (item) yield item; continue; }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const valueText = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") eventName = valueText;
        else if (field === "data") data.push(valueText);
      }
      if (done) break;
    }
    if (buffer) {
      if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
      else if (buffer.startsWith("event:")) eventName = buffer.slice(6).replace(/^ /, "");
    }
    const item = dispatch();
    if (item) yield item;
  } finally {
    reader.releaseLock?.();
  }
}

// Imported by `node --test`, which exercises readSse in a bare V8 context with
// no DOM. Reading browser globals at module scope made the whole file fail to
// load under Node — `sessionStorage is not defined` — so the parser above is
// pure and the wiring below only runs where a document exists.
const hasDom = typeof document !== "undefined";
const $ = (id) => document.getElementById(id);
const storage = typeof sessionStorage === "undefined" ? null : sessionStorage;
const sessionId = storage?.getItem("quasnooze.voice.session") || `voice-${globalThis.crypto.randomUUID()}`;
storage?.setItem("quasnooze.voice.session", sessionId);
let activeRequest = null;
let recognition = null;
let recognitionConsented = storage?.getItem("quasnooze.voice.speech-consent") === "yes";
let listening = false;
let sentThisUtterance = false;
let lastAssistantText = "";

function apiHeaders(json = false) {
  const key = new URLSearchParams(location.search).get("key") || localStorage.getItem("pinch.key") || "";
  return { ...(json ? { "content-type": "application/json" } : {}), ...(key ? { "x-quasnooze-key": key } : {}) };
}
function addMessage(role, text, extra = "") {
  const node = document.createElement("div");
  node.className = `message ${role}${extra ? ` ${extra}` : ""}`;
  node.textContent = text;
  $("thread").append(node);
  $("thread").scrollTop = $("thread").scrollHeight;
  return node;
}
function setStatus(text, state = "ready") {
  const status = $("status"); status.textContent = text; status.dataset.state = state;
}
function setListening(value) {
  listening = value;
  $("mic").setAttribute("aria-pressed", String(value));
  $("mic").textContent = value ? "⏹️" : "🎙️";
  $("mic").title = value ? "Stop listening" : "Start voice input";
  if (value) setStatus("Listening · speak now", "ready");
}
function localVoice() {
  if (!("speechSynthesis" in window) || !window.SpeechSynthesisUtterance) return null;
  const voices = window.speechSynthesis.getVoices();
  return voices.find((voice) => voice.localService === true && voice.lang?.toLowerCase().startsWith($("message").lang || navigator.language || "en"))
    || voices.find((voice) => voice.localService === true) || null;
}
function speak(text) {
  if (!$("speak").checked || !text || !window.speechSynthesis) return;
  const voice = localVoice();
  if (!voice) { setStatus("No installed local speech voice; reply remains on screen", "error"); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text.slice(0, 2000));
  utterance.voice = voice;
  utterance.onstart = () => setStatus("Speaking · local device voice", "ready");
  utterance.onerror = () => setStatus("Speech playback failed; the reply is still on screen", "error");
  utterance.onend = () => { if ($("continue").checked) startListening(); else setStatus("Ready · connected to local assistant", "ready"); };
  window.speechSynthesis.speak(utterance);
}
function recognitionConstructor() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }
function startListening() {
  const Recognition = recognitionConstructor();
  if (!Recognition) {
    setStatus("Speech recognition is unavailable in this browser. Type a message or use the Windows voice host.", "error");
    return;
  }
  if (!recognitionConsented) {
    const accepted = window.confirm("Browser speech recognition may send microphone audio to the browser’s speech provider. Continue? For on-device recognition, use the Windows voice host or a configured local transcription engine.");
    if (!accepted) return;
    recognitionConsented = true;
    sessionStorage.setItem("quasnooze.voice.speech-consent", "yes");
  }
  if (!recognition) {
    recognition = new Recognition();
    recognition.lang = localStorage.getItem("pinch.miclang") || navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      let interim = "", finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      if (interim) { $("message").value = interim; setStatus("Listening · recognizing speech…", "ready"); }
      if (finalText.trim() && !sentThisUtterance) {
        sentThisUtterance = true;
        $("message").value = finalText.trim();
        $("composer").requestSubmit();
      }
    };
    recognition.onerror = (event) => {
      setListening(false);
      const explanations = {
        "not-allowed": "Microphone permission denied. Allow microphone access for this site and try again.",
        "service-not-allowed": "The browser speech service is unavailable or blocked. Use text input, the Windows voice host, or configure local transcription.",
        "audio-capture": "No microphone is available. Check the selected OS input device.",
        "network": "The browser speech service could not be reached. This does not indicate an Ollama problem; try text or another speech engine.",
        "no-speech": "No speech was detected. Check your microphone and try again.",
      };
      setStatus(explanations[event.error] || `Speech recognition failed (${event.error || "unknown error"}). Type your message or retry.`, "error");
    };
    recognition.onend = () => {
      setListening(false);
      if (!sentThisUtterance && $("message").value.trim()) setStatus("Speech ended without a final transcript. Review the text and press Send.", "error");
      else if (!activeRequest) setStatus("Ready · connected to local assistant", "ready");
    };
  }
  sentThisUtterance = false;
  try { recognition.start(); setListening(true); }
  catch (error) { setListening(false); setStatus(`Could not start speech recognition: ${error.message || error}. Check microphone permissions, then retry.`, "error"); }
}
function stopVoice() {
  $("continue").checked = false;
  try { recognition?.stop(); } catch {}
  window.speechSynthesis?.cancel();
  activeRequest?.abort();
  setListening(false);
  setStatus("Voice stopped", "ready");
}
async function approve(id, allowed) {
  const response = await fetch("/api/approve", {
    method: "POST", headers: apiHeaders(true), body: JSON.stringify({ id, allowed }),
  });
  if (!response.ok) throw new Error(`Approval response failed (HTTP ${response.status}).`);
}
async function sendMessage(text) {
  if (activeRequest) return;
  const userText = text.trim();
  if (!userText) return;
  addMessage("user", userText);
  $("message").value = "";
  const pending = addMessage("assistant", "Thinking with your configured model…", "pending");
  const controller = new AbortController(); activeRequest = controller;
  let answer = "", gotFinal = false;
  setStatus("Working · waiting for your local model", "checking");
  try {
    const response = await fetch("/api/chat", {
      method: "POST", headers: apiHeaders(true), signal: controller.signal,
      body: JSON.stringify({ text: userText, sessionId }),
    });
    for await (const item of readSse(response)) {
      const data = item.data;
      if (item.event === "step" && data?.type === "approval") {
        const card = document.createElement("section"); card.className = "approval";
        const description = document.createElement("div"); description.textContent = `Approval required: ${data.description || "Review this action"}`;
        const allow = document.createElement("button"); allow.textContent = "Allow once";
        const deny = document.createElement("button"); deny.textContent = "Deny";
        allow.onclick = () => { allow.disabled = deny.disabled = true; approve(data.id, true).catch((error) => addMessage("assistant", error.message, "error")); };
        deny.onclick = () => { allow.disabled = deny.disabled = true; approve(data.id, false).catch((error) => addMessage("assistant", error.message, "error")); };
        card.append(description, allow, deny); $("thread").append(card);
      } else if (item.event === "step" && data?.type === "delta" && data.text) {
        answer += data.text; pending.textContent = answer; pending.classList.remove("pending");
      } else if (item.event === "final") {
        answer = String(data?.text || answer || "The assistant returned an empty reply."); gotFinal = true;
      } else if (item.event === "error") {
        throw new Error(data?.message || "The local assistant returned an error.");
      }
    }
    if (!gotFinal && !answer) throw new Error("The assistant stream ended before a final reply. Check the server output and model readiness.");
    pending.classList.remove("pending"); pending.textContent = answer;
    lastAssistantText = answer;
    speak(answer);
    if (!$("speak").checked || !window.speechSynthesis || !localVoice()) {
      if ($("continue").checked) startListening(); else setStatus("Ready · connected to local assistant", "ready");
    }
  } catch (error) {
    pending.remove();
    if (error.name !== "AbortError") {
      addMessage("assistant", `${error.message}\n\nCheck that Quasnooze is running at localhost:7777 and that Ollama/model are ready (npm run doctor, then npm run brain).`, "error");
      setStatus(error.message, "error");
    }
  } finally {
    if (activeRequest === controller) activeRequest = null;
  }
}

if (hasDom) {
  $("composer").addEventListener("submit", (event) => { event.preventDefault(); void sendMessage($("message").value); });
  $("mic").addEventListener("click", () => { if (listening) { try { recognition?.stop(); } catch {} setListening(false); } else startListening(); });
  $("stop").addEventListener("click", stopVoice);
  $("message").addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); $("composer").requestSubmit(); } });
  window.addEventListener("pagehide", () => { try { recognition?.abort(); } catch {} window.speechSynthesis?.cancel(); activeRequest?.abort(); });

  async function checkReady() {
    try {
      const response = await fetch("/api/health", { headers: apiHeaders() });
      const health = await response.json();
      if (!response.ok) throw new Error(health.error || `Local server returned HTTP ${response.status}`);
      if (health.provider === "mock") {
        setStatus("Connected to mock mode · configure Ollama for real AI", "error");
        $("setupNotice").hidden = false;
      } else {
        setStatus(`Local server ready · ${health.provider} · ${health.model || "model configured"}`, "ready");
      }
    } catch (error) {
      setStatus(`Local assistant is unreachable: ${error.message}`, "error");
      $("setupNotice").hidden = false;
    }
  }
  if ("speechSynthesis" in window) window.speechSynthesis.addEventListener?.("voiceschanged", () => {
    if ($("speak").checked && !localVoice()) setStatus("No installed local speech voice; replies will stay on screen", "error");
  });
  checkReady();
}
