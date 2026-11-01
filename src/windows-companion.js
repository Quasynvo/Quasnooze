import { StringDecoder } from "node:string_decoder";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config, ROOT } from "./config.js";
import { desktop } from "./desktop.js";
import { registerSender } from "./outbound.js";

/** Minimal child environment: never give the UI LLM/chat credentials. */
export function companionEnv(source = process.env) {
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export function startWindowsCompanion({ onQuit = () => process.emit("SIGINT"), log = console } = {}) {
  if (process.platform !== "win32") throw new Error("The resident companion requires Windows.");
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const executable = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "desktop", "windows.ps1")], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: companionEnv(),
  });
  const pending = new Map();
  const decoder = new StringDecoder("utf8");
  let buffer = "", closed = false;
  function send(message) { if (!closed && child.stdin.writable) child.stdin.write(JSON.stringify(message) + "\n"); }
  const bridge = {
    send,
    action(intent) {
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const deadline = Date.now() + 30_000;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Desktop confirmation expired; request it again.")); }, 30_000);
        pending.set(id, { resolve, reject, timer });
        send({ op: "action", id, action: intent.action, url: intent.url, deadline });
      });
    },
  };
  function cleanup() {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Windows companion disconnected.")); }
    pending.clear(); desktop.detach();
  }
  child.on("error", () => { cleanup(); log.warn?.("Windows companion could not start. See docs/DESKTOP.md; no browser/cloud microphone fallback was enabled."); });
  child.on("exit", () => { cleanup(); });
  child.stdin.on("error", () => cleanup());
  // Native diagnostics can include transcript/file data; don't print them or secrets.
  child.stderr.on("data", () => { log.warn?.("Windows companion reported a diagnostic; inspect speech-pack prerequisites in docs/DESKTOP.md."); });
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    if (buffer.length > 100_000) { child.kill(); cleanup(); return; }
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "ready") {
        desktop.attach(bridge);
        send({ op: "init", owner: config.ownerName, panel: `http://127.0.0.1:${config.port}/desktop.html?key=${encodeURIComponent(config.authKey)}`, node: process.execPath, launcher: join(ROOT, "scripts", "desktop.js"), root: ROOT });
      } else if (event.type === "command" && typeof event.text === "string" && event.text.length <= 2000) {
        desktop.request(event.text).catch((err) => send({ op: "reply", text: err.message, speak: false }));
      } else if (event.type === "approval") {
        desktop.approve(event.id, event.allowed);
      } else if (event.type === "voice" && typeof event.mic === "boolean") {
        desktop.update({ mic: event.mic, voice: String(event.detail || "").slice(0, 200) });
      } else if (event.type === "state" && ["listening", "speaking", "muted", "armed"].includes(event.phase)) {
        desktop.update({ phase: event.phase });
      } else if (event.type === "result" && pending.has(event.id)) {
        const item = pending.get(event.id); pending.delete(event.id); clearTimeout(item.timer);
        if (event.ok === true && typeof event.text === "string") item.resolve(event.text.slice(0, 16_000));
        else item.reject(new Error(String(event.text || "Desktop action failed.").slice(0, 500)));
      } else if (event.type === "quit") { onQuit(); }
    }
  });
  registerSender("desktop", async (_target, text) => {
    if (!desktop.state.available) throw new Error("Windows companion is not running");
    desktop.notify(text);
  });
  return { stop() {
    send({ op: "quit" });
    cleanup();
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000).unref();
  } };
}
