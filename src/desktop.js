/** Resident-desktop orchestration. No microphone or process starts on import. */
import { personaCommand } from "./personas.js";
import { randomUUID } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import { freemem, totalmem, uptime } from "node:os";
import { brain } from "./brain.js";
import { runAgent, answerApproval, pendingApprovalsFor } from "./agent.js";
import { config } from "./config.js";
import { resolveInWorkspace } from "./tools.js";
import { parseWhen, formatClock } from "./timeparse.js";
import { addReminder } from "./store.js";

const SESSION = "desktop-resident";
const APPS = new Map([["calculator", "calculator"], ["calc", "calculator"], ["notepad", "notepad"], ["file explorer", "explorer"], ["explorer", "explorer"]]);
const SITES = new Map([["github", "https://github.com/"], ["youtube", "https://www.youtube.com/"], ["google", "https://www.google.com/"]]);

export function desktopIntent(input) {
  const text = /^open https:\/\//i.test(input.trim()) ? input.trim() : input.trim().replace(/[.!?]+$/, "");
  if (/^\/persona(?:\s|$)/i.test(text)) return {kind:"persona"};
  const lower = text.toLowerCase();
  if (/^(?:what(?:'s| is) the )?time$/.test(lower) || lower === "what time is it") return { kind: "time" };
  if (["system status", "computer status", "status"].includes(lower)) return { kind: "system" };
  if (["mute", "stop listening", "mute microphone"].includes(lower)) return { kind: "mute" };
  if (["read clipboard", "read my clipboard"].includes(lower)) return { kind: "native", action: "clipboard" };
  const open = /^open (.+)$/i.exec(text);
  if (open) {
    const target = open[1].toLowerCase();
    if (APPS.has(target)) return { kind: "native", action: APPS.get(target) };
    const candidate = SITES.get(target) || open[1];
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2000) return { kind: "native", action: "url", url: url.href };
    } catch { /* not an explicit HTTPS URL */ }
    return { kind: "unsupported-open" };
  }
  const reminder = /^remind me (.+?) to (.+)$/i.exec(text);
  if (reminder) return { kind: "reminder", when: reminder[1], text: reminder[2] };
  const find = /^find (?:file )?(.+)$/i.exec(text);
  if (find) return { kind: "find", query: find[1] };
  return { kind: "agent" };
}

/** Bounded name-only search; never follows symlinks or opens file contents. */
export async function findDesktopFiles(query, { roots = config.workspaceRoots, limit = 2000, guard = resolveInWorkspace } = {}) {
  if (!query.trim() || query.length > 120 || /[\\/\x00-\x1f]/.test(query)) return "Use a short filename, not a path.";
  const matches = [];
  let visited = 0;
  const started = Date.now();
  const queue = roots.map((root) => ({ root, path: root, depth: 0 }));
  while (queue.length && visited < limit && Date.now() - started < 1000 && matches.length < 20) {
    const current = queue.shift();
    try {
      const directory = await opendir(guard(current.path));
      for await (const entry of directory) {
        if (visited >= limit || Date.now() - started >= 1000 || matches.length >= 20) break;
        visited++;
        if (entry.isSymbolicLink() || entry.name.startsWith(".") || ["node_modules", "AppData", "Windows"].includes(entry.name)) continue;
        const path = join(current.path, entry.name);
        try { guard(path); } catch { continue; }
        if (entry.isFile() && entry.name.toLowerCase().includes(query.toLowerCase())) matches.push(relative(current.root, path));
        if (entry.isDirectory() && current.depth < 4) queue.push({ ...current, path, depth: current.depth + 1 });
      }
    } catch { /* unreadable/protected/disappearing directory: do not broaden scope */ }
  }
  return `${matches.length ? matches.join("\n") : "No matching files in this bounded search."}\nSearched ${Math.min(visited, limit)} entries, up to 4 folder levels; hidden folders, symlinks and protected paths excluded. This is not a full-disk search.`;
}

export class DesktopRuntime {
  constructor({ agent = runAgent, selection = () => brain.active, finder = findDesktopFiles } = {}) {
    this.agent = agent; this.selection = selection; this.finder = finder;
    this.bridge = null; this.busy = false; this.approval = null;
    this.state = { available: false, phase: "not-running", mic: false, voice: "Windows companion not running", text: "Run npm run desktop on Windows.", lastMs: null };
    this.recent = []; this.notices = [];
  }
  snapshot() { return { ...this.state, audioAgeMs: this.state.audioUpdatedAt ? Date.now() - this.state.audioUpdatedAt : null, ...(this.state.speech ? { speech: { ...this.state.speech } } : {}), busy: this.busy, approval: this.approval ? { ...this.approval } : null, recent: this.recent.map((r) => ({ ...r })) }; }
  update(patch) { Object.assign(this.state, patch); this.bridge?.send({ op: "state", ...patch }); }
  attach(bridge) { this.bridge = bridge; this.update({ available: true, phase: "muted", text: "Ready. Local wake listening is off until you enable it." }); }
  detach() { this.bridge = null; if (this.approval) this.approve(this.approval.id, false); this.update({ available: false, phase: "not-running", mic: false, voice: "Companion disconnected" }); }
  approve(id, allowed) {
    if (typeof allowed !== "boolean" || this.approval?.id !== id || !pendingApprovalsFor(SESSION).some((p) => p.id === id)) return false;
    const ok = answerApproval(id, allowed); this.approval = null; return ok;
  }
  audio(level) {
    if (!this.bridge || !this.state.mic || !Number.isFinite(level) || level < 0 || level > 100) return false;
    this.update({ audioLevel: Math.round(level), audioUpdatedAt: Date.now() }); return true;
  }
  recognition(event) {
    if (!this.bridge || !["permission", "denied", "stopping", "listening", "hearing", "heard", "rejected", "timeout", "error", "audio-problem"].includes(event.status)) return false;
    const speech = { status: event.status, detail: String(event.detail || "").slice(0, 600), text: String(event.text || "").slice(0, 2000), confidence: Number.isFinite(event.confidence) ? Math.max(0, Math.min(1, event.confidence)) : null };
    this.update({ speech, ...(event.status === "error" && !this.busy ? { phase: "attention" } : {}) });
    return true;
  }
  control(action) {
    if (!this.bridge) throw Object.assign(new Error("Windows companion is not running."), { status: 503 });
    if (!["mute", "listen", "stop-voice", "show"].includes(action)) throw Object.assign(new Error("Unknown desktop control."), { status: 400 });
    this.bridge.send({ op: action });
    return this.snapshot();
  }
  async request(text) {
    if (typeof text !== "string" || !text.trim() || text.length > 2000) throw Object.assign(new Error("Use a command of 1–2000 characters."), { status: 400 });
    if (this.busy) throw Object.assign(new Error("Finish or deny the current request first."), { status: 409 });
    this.busy = true;
    const started = Date.now();
    this.update({ phase: "working", text: "Working…", draft: "", firstTextMs: null, lastMs: null });
    this.bridge?.send({ op: "working" }); // releases recognition until the response finishes
    const intent = desktopIntent(text);
    let reply, failed = false, streamDraft = "", lastDraftAt = 0;
    try {
      switch (intent.kind) {
        case "persona": reply = personaCommand(text, SESSION); break;
        case "time": reply = `It is ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: config.timezone })}.`; break;
        case "system": reply = `${(freemem() / 2 ** 30).toFixed(1)} GB free of ${(totalmem() / 2 ** 30).toFixed(1)} GB RAM. Computer uptime: ${Math.floor(uptime() / 3600)} hours.`; break;
        case "mute": this.control("mute"); reply = "Microphone muted."; break;
        case "unsupported-open": reply = "I can open Calculator, Notepad, File Explorer, GitHub, YouTube, Google, or an explicit https:// address. I will not guess an executable or run a shell command."; break;
        case "native":
          if (!this.bridge) throw new Error("Start npm run desktop on Windows for local app and clipboard actions.");
          reply = await this.bridge.action(intent); break;
        case "find": reply = await this.finder(intent.query); break;
        case "reminder": {
          const when = parseWhen(intent.when);
          if (!when || when.at.getTime() <= Date.now()) { reply = "Please use a future time, for example: remind me in 20 minutes to stretch."; break; }
          if (!this.bridge) throw new Error("Start the Windows companion so this reminder can be delivered there.");
          addReminder({ id: `r_${randomUUID()}`, text: intent.text.slice(0, 300), at: when.at.toISOString(), address: "desktop:resident", channel: "desktop", sessionId: SESSION, fired: false, createdAt: new Date().toISOString() });
          reply = `Reminder set for ${formatClock(when.at, config.timezone)}: ${intent.text}. Pinch must be running to deliver it.`; break;
        }
        default: {
          if (!this.bridge) throw new Error("Start npm run desktop on Windows for resident model requests. Conversation history remains available in the web panel.");
          const local = new URL(config.llm.ollamaUrl);
          if (this.selection().provider === "openai" || !["localhost", "127.0.0.1", "[::1]"].includes(local.hostname) || !["http:", "https:"].includes(local.protocol)) {
            throw new Error("Desktop requests require loopback Ollama (or explicit mock demo mode). No remote model or cloud fallback is permitted.");
          }
          const result = await this.agent({ sessionId: SESSION, channel: "desktop", target: "resident", text, onEvent: (event) => {
            if (event.type === "delta") {
              streamDraft = (streamDraft + event.text).slice(0, 16000);
              const now = Date.now(), first = this.state.firstTextMs === null;
              // Model text is filtered at brain.chat. Bound native pipe/UI traffic.
              if (first || now - lastDraftAt >= 120) {
                lastDraftAt = now;
                this.update({ draft: streamDraft, firstTextMs: this.state.firstTextMs ?? now - started });
              }
            } else if (event.type === "approval") {
              this.approval = { id: event.id, description: event.description };
              this.update({ phase: "approval", text: event.description });
              this.bridge?.send({ op: "approval", id: event.id, text: event.description });
            } else if (event.type === "tool") { this.approval = null; this.update({ phase: "working", text: event.label || event.name }); }
          } });
          reply = result.text; failed = Boolean(result.error); break;
        }
      }
    } catch (err) { reply = String(err.message || "Desktop request failed."); failed = true; }
    finally { this.busy = false; this.approval = null; }
    if (this.notices.length) reply = `${this.notices.splice(0).map((notice) => `Reminder: ${notice}`).join("\n")}\n\n${reply}`;
    const ms = Date.now() - started;
    this.recent.unshift({ command: text.slice(0, 160), ok: !failed, ms }); this.recent = this.recent.slice(0, 8);
    this.update({ phase: failed ? "attention" : "ready", text: reply, draft: "", lastMs: ms });
    this.bridge?.send({ op: "reply", text: reply.slice(0, 4000), speak: intent.kind !== "mute" && !failed });
    return { text: reply, ok: !failed, ms, fastPath: intent.kind !== "agent" };
  }
  notify(text) {
    const notice = String(text).slice(0, 2000);
    // A reminder must not clear the native Working/approval gate or re-arm its mic.
    if (this.busy) {
      if (this.notices.length >= 20) throw new Error("Desktop reminder queue is full.");
      this.notices.push(notice); return;
    }
    this.update({ text: notice, phase: "reminder" }); this.bridge?.send({ op: "reply", text: notice, speak: true });
  }
}

export const desktop = new DesktopRuntime();
