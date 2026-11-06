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

export function startWindowsCompanion({ onQuit = () => process.emit("SIGINT"), log = console,
  spawnChild = spawn, runtime = desktop, platform = process.platform,
  clock = { setTimeout, clearTimeout }, readyTimeoutMs = 15_000, retryDelayMs = 1000,
} = {}) {
  if (platform !== "win32") throw new Error("The resident companion requires Windows.");
  let stopped = false, current = null, retryTimer = null, attempts = 0;
  const later = (fn, ms) => { const timer = clock.setTimeout(fn, ms); timer?.unref?.(); return timer; };
  const clear = timer => { if (timer != null) clock.clearTimeout(timer); };
  function status(phase, text) {
    runtime.update({ available: false, mic: false, phase, text, recoveryAttempts: attempts,
      retryAvailable: phase === "unavailable" });
  }
  function schedule() {
    if (stopped) return;
    if (attempts >= 3) { status("unavailable", "Companion unavailable after three recovery attempts. Choose Retry companion. Interrupted side-effect outcomes remain unknown; nothing was replayed."); return; }
    status("recovering", "Companion disconnected. Recovering muted; interrupted side-effect outcomes are unknown. Nothing will be replayed.");
    retryTimer = later(() => { retryTimer = null; attempts++; launch(); }, retryDelayMs);
  }
  function launch() {
    if (stopped) return;
    const context = { child: null, dead: false, exited: false, ready: false, pending: new Map(), timer: null, killTimer: null };
    current = context;
    status(attempts ? "recovering" : "starting", "Waiting for Windows companion readiness. Microphone has not been enabled.");
    const live = () => !stopped && current === context && !context.dead;
    function fail() {
      if (!live()) return;
      context.dead = true; clear(context.timer);
      for (const item of context.pending.values()) {
        clear(item.timer); item.cleanup?.();
        const err = new Error("Companion disconnected; side-effect outcome unknown. Inspect before requesting again.");
        err.code = "UNREACHABLE";
        item.reject(err);
      }
      context.pending.clear(); runtime.detach();
      status("recovering", "Companion lost. Side-effect outcome unknown; nothing will be replayed.");
      if (context.exited || !context.child) { schedule(); return; }
      // Never start another host until the old process has actually exited.
      context.killTimer = later(() => {
        if (!context.exited && !stopped && current === context) {
          status("unavailable", "Previous companion has not exited. Quit it before explicit retry; microphone state cannot be verified.");
          runtime.update({ micUnknown: true });
        }
      }, 2000);
      try { context.child.kill(); } catch { /* exit watchdog exposes uncertainty */ }
    }
    function send(message) {
      if (!live()) return false;
      try {
        if (!context.child.stdin.writable) { fail(); return false; }
        context.child.stdin.write(JSON.stringify(message) + "\n", error => { if (error) fail(); });
        return live();
      } catch { fail(); return false; }
    }
    const bridge = { send, action(intent) {
      return new Promise((resolve, reject) => {
        if (!live() || !context.ready) {
          const err = new Error("Companion unavailable; action not sent.");
          err.code = "UNREACHABLE";
          reject(err); return;
        }
        const id = randomUUID(), deadline = Date.now() + 30_000;
        const timer = later(() => {
          context.pending.delete(id);
          const err = new Error("Desktop confirmation expired; outcome unknown. Inspect before requesting again.");
          err.code = "UNREACHABLE"; err.timeout = true;
          reject(err);
        }, 30_000);
        context.pending.set(id, { resolve, reject, timer });
        // media/level carry the volume/media-key subset: an enum name and an
        // integer. JSON.stringify drops them when undefined, so the wire shape
        // for clipboard/url/app actions is unchanged.
        send({ op: "action", id, action: intent.action, url: intent.url, media: intent.media, level: intent.level, deadline });
      });
    },
      /**
       * Typed request/response to the companion's OS host (windows, app
       * launch). Carries a deadline and its own timeout: a host that does not
       * answer rejects with code UNREACHABLE — never a silent success.
       * Resolves with the host's structured `data` payload (plus `text`);
       * rejects with a typed `code` (CLOSED, DENIED, UNKNOWN_APP, …).
       */
      os(payload, { timeoutMs = 15_000, signal } = {}) {
        return new Promise((resolve, reject) => {
          if (signal?.aborted) {
            const err = new Error("Action aborted before it was sent to the Windows companion. Nothing was sent.");
            err.code = "ABORTED";
            reject(err); return;
          }
          if (!live() || !context.ready) {
            const err = new Error("Windows companion is not running; request not sent.");
            err.code = "UNREACHABLE";
            reject(err); return;
          }
          if (!payload || typeof payload.kind !== "string" || payload.kind.length > 40) {
            const err = new Error("Invalid os request kind.");
            err.code = "BAD_REQUEST";
            reject(err); return;
          }
          const id = randomUUID(), deadline = Date.now() + timeoutMs;
          const cleanup = () => { if (signal && abort) signal.removeEventListener("abort", abort); };
          const timer = later(() => {
            context.pending.delete(id); cleanup();
            const err = new Error(`Windows companion did not answer "${payload.kind}" within ${timeoutMs} ms; the host is UNREACHABLE and nothing may be assumed about the machine.`);
            err.code = "UNREACHABLE"; err.timeout = true;
            reject(err);
          }, timeoutMs);
          const abort = () => {
            // Keep the request pending until the native host reports exactly
            // how many characters were sent. It checks this flag per character.
            send({ op: "abort_type", id });
          };
          context.pending.set(id, { resolve, reject, timer, structured: true, cleanup });
          if (signal) signal.addEventListener("abort", abort, { once: true });
          send({ op: "os", id, ...payload, deadline });
        });
      } };
    try {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      context.child = spawnChild(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "desktop", "windows.ps1")], {
        shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: companionEnv(),
      });
    } catch { fail(); return; }
    const child = context.child, decoder = new StringDecoder("utf8");
    let buffer = "";
    context.timer = later(fail, readyTimeoutMs);
    const exited = () => {
      if (context.exited) return;
      context.exited = true; clear(context.killTimer);
      if (!context.dead) fail();
      else if (!stopped && current === context) schedule();
    };
    child.on("error", fail); child.on("exit", exited); child.on("close", exited);
    child.stdin.on("error", fail); child.stdout.on("error", fail);
    child.stdout.on("end", fail);
    child.stderr.on("error", fail);
    child.stderr.on("data", () => { if (live()) log.warn?.("Windows companion diagnostic; see docs/DESKTOP.md. No transcript or credentials logged."); });
    child.stdout.on("data", chunk => {
      if (!live()) return;
      buffer += decoder.write(chunk);
      if (buffer.length > 100_000) { fail(); return; }
      let end;
      while (live() && (end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== "object") continue;
        if (event.type === "quit") { stop(); onQuit(); return; }
        if (event.type === "ready") {
          if (context.ready) continue;
          context.ready = true; clear(context.timer);
          if (!send({ op: "init", owner: config.ownerName, panel: `http://127.0.0.1:${config.port}/desktop.html?key=${encodeURIComponent(config.authKey)}`, node: process.execPath, launcher: join(ROOT, "scripts", "desktop.js"), root: ROOT })) return;
          runtime.attach(bridge); runtime.update({ retryAvailable: false, recoveryAttempts: attempts });
        } else if (!context.ready) continue;
        else if (event.type === "command" && typeof event.text === "string" && event.text.length <= 2000) {
          runtime.request(event.text).catch(() => { if (live()) send({ op: "reply", text: "Request failed; inspect the command deck. Nothing was replayed.", speak: false }); });
        } else if (event.type === "approval") runtime.approve(event.id, event.allowed);
        else if (event.type === "audio") runtime.audio(event.level);
        else if (event.type === "recognition") runtime.recognition(event);
        else if (event.type === "voice" && typeof event.mic === "boolean") runtime.update({ ...(event.mic ? {} : { audioLevel: null, audioUpdatedAt: null }), mic: event.mic, voice: String(event.detail || "").slice(0, 200) });
        else if (event.type === "state" && ["listening", "speaking", "muting", "muted", "armed"].includes(event.phase)) runtime.update({ phase: event.phase });
        else if (event.type === "result" && context.pending.has(event.id)) {
          const item = context.pending.get(event.id); context.pending.delete(event.id); clear(item.timer); item.cleanup?.();
          if (event.ok === true && typeof event.text === "string") {
            // Typed os requests resolve with the host's structured payload so
            // callers can see the window that was actually focused, etc.
            if (item.structured && event.data && typeof event.data === "object") item.resolve({ ...event.data, text: event.text.slice(0, 16_000) });
            else item.resolve(event.text.slice(0, 16_000));
          } else {
            const err = new Error(String(event.text || "Desktop action failed.").slice(0, 500));
            if (typeof event.code === "string" && event.code) err.code = event.code.slice(0, 40);
            if (item.structured && event.data && typeof event.data === "object") err.data = event.data;
            item.reject(err);
          }
        }
      }
    });
  }
  function retry() {
    if (stopped || !runtime.state.retryAvailable || (current?.child && !current.exited)) return false;
    clear(retryTimer); retryTimer = null; attempts = 0; launch(); return true;
  }
  function stop() {
    if (stopped) return;
    stopped = true; clear(retryTimer); retryTimer = null;
    if (current) {
      clear(current.timer); clear(current.killTimer); current.dead = true;
      for (const item of current.pending.values()) {
        clear(item.timer); item.cleanup?.();
        const err = new Error("Companion stopped; side-effect outcome unknown.");
        err.code = "UNREACHABLE";
        item.reject(err);
      }
      current.pending.clear();
      try { current.child?.stdin.end(JSON.stringify({ op: "quit" }) + "\n"); } catch { /* process may already be gone */ }
      const context = current;
      later(() => { if (!context.exited) { try { context.child?.kill(); } catch { /* already gone */ } } }, 1000);
    }
    runtime.retryHost = null; runtime.detach();
    runtime.update({ retryAvailable: false });
  }
  runtime.retryHost = retry;
  registerSender("desktop", async (_target, text) => {
    if (stopped || !runtime.state.available) throw new Error("Windows companion is not running");
    runtime.notify(text);
  });
  launch();
  return { stop, retry };
}
