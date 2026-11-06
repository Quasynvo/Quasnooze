/**
 * laptop-02 / issue #126 — list, launch, focus, minimise and close
 * applications by name through the Windows companion.
 *
 * Covers the acceptance criteria: ambiguous names return candidates instead
 * of acting, a window that closed mid-call is a typed failure, no
 * model-provided string is ever concatenated into a command line, the
 * assistant reports the window it actually focused, and a host that does not
 * answer is UNREACHABLE — never a silent success.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "quasnooze-windows-test-"));
process.env.PINCH_WORKSPACE = root;
process.env.PINCH_DATA = join(root, "data");
process.env.LLM_PROVIDER = "mock";
after(async () => { await rm(root, { recursive: true, force: true }); });

const { DesktopRuntime, desktop } = await import("../src/desktop.js");
const { startWindowsCompanion } = await import("../src/windows-companion.js");
const { TOOL_MAP, DANGEROUS, matchWindows, WINDOW_QUERY_MAX } = await import("../src/tools.js");

const WINDOWS = [
  { handle: "1001", title: "Home - Spotify", process: "Spotify.exe" },
  { handle: "1002", title: "notes - Notepad", process: "notepad.exe" },
  { handle: "1003", title: "Untitled - Notepad", process: "notepad.exe" },
  { handle: "1004", title: "Quasnooze - Visual Studio Code", process: "Code.exe" },
];

/** Fake bridge whose os() is driven by a handler, like the real companion. */
function fakeBridge(handler) {
  const calls = [];
  return {
    calls,
    send() {},
    action: async (intent) => { calls.push(intent); return "ok"; },
    os: async (payload, opts) => { calls.push(payload); return handler(payload, opts); },
  };
}

function withWindows(fn, handler = listHandler) {
  return async () => {
    const bridge = fakeBridge(handler);
    desktop.attach(bridge);
    try { await fn(bridge); } finally { desktop.detach(); }
  };
}

const listHandler = (payload) => {
  if (payload.kind === "list_windows") return { windows: WINDOWS, count: WINDOWS.length, text: "4 visible window(s)." };
  throw new Error(`unexpected kind ${payload.kind}`);
};

/* ── matchWindows: fuzzy but bounded ─────────────────────────────────── */

test("matchWindows matches by process name, title, tokens and small typos", () => {
  assert.equal(matchWindows("spotify", WINDOWS).status, "unique");
  assert.equal(matchWindows("spotify", WINDOWS).matches[0].handle, "1001");
  assert.equal(matchWindows("NOTEPAD.EXE", WINDOWS).status, "ambiguous", "two Notepad windows must not collapse to one");
  assert.equal(matchWindows("notes", WINDOWS).status, "unique");
  assert.equal(matchWindows("notes", WINDOWS).matches[0].handle, "1002");
  assert.equal(matchWindows("visual studio code", WINDOWS).matches[0].handle, "1004", "all query tokens hit the title");
  assert.equal(matchWindows("notebad", WINDOWS).status, "ambiguous", "typo matches the process name of both Notepads");
  assert.equal(matchWindows("code", WINDOWS).status, "unique");
  assert.equal(matchWindows("no such app anywhere", WINDOWS).status, "none");
});

test("matchWindows rejects invalid input and never treats it as a path", () => {
  for (const bad of ["", "   ", "a".repeat(WINDOW_QUERY_MAX + 1), "x\x00y", "C:\\Windows\\cmd.exe; rm -rf /"]) {
    const r = matchWindows(bad, WINDOWS);
    assert.ok(r.status === "invalid" || r.status === "none", `query ${JSON.stringify(bad.slice(0, 20))} -> ${r.status}`);
    if (bad.includes("cmd.exe")) assert.equal(r.status, "none", "a shell string must never match a window");
  }
  assert.equal(matchWindows("spotify", null).status, "none");
  assert.equal(matchWindows("spotify", "not an array").status, "none");
});

/* ── tools over a fake companion bridge ───────────────────────────────── */

test("list_windows reports what the companion returned", withWindows(async (bridge) => {
  const result = await TOOL_MAP.get("list_windows").run({});
  assert.equal(result.ok, true);
  assert.match(result.output, /4 visible window\(s\)/);
  assert.match(result.output, /"Home - Spotify" — Spotify\.exe/);
  assert.deepEqual(bridge.calls.map((c) => c.kind), ["list_windows"]);
}));

test("list_windows without a companion is a typed UNREACHABLE failure, not a silent success", async () => {
  desktop.detach();
  const result = await TOOL_MAP.get("list_windows").run({});
  assert.equal(result.ok, false);
  assert.match(result.output, /UNREACHABLE/);
  assert.match(result.output, /npm run desktop/);
});

test("focus_window on an ambiguous name returns candidates and focuses nothing", withWindows(async (bridge) => {
  const result = await TOOL_MAP.get("focus_window").run({ name: "notepad" });
  assert.equal(result.ok, false);
  assert.match(result.output, /matches 2 windows/);
  assert.match(result.output, /notes - Notepad/);
  assert.match(result.output, /Untitled - Notepad/);
  assert.deepEqual(bridge.calls.map((c) => c.kind), ["list_windows"], "no focus call may be made for an ambiguous name");
}));

test("focus_window reports the window the companion actually focused, not the guess", async () => {
  const bridge = fakeBridge((payload) => {
    if (payload.kind === "list_windows") return { windows: WINDOWS, count: WINDOWS.length };
    if (payload.kind === "focus_window") {
      assert.equal(payload.handle, "1001");
      // The host read-back wins over the caller's guess: it reports what is
      // really frontmost, so a wrong match is visible in the reply.
      return { handle: "1001", title: "Home - Spotify", process: "Spotify", focused: true, text: "Focused..." };
    }
    throw new Error("unexpected");
  });
  desktop.attach(bridge);
  try {
    const result = await TOOL_MAP.get("focus_window").run({ name: "spotify" });
    assert.equal(result.ok, true);
    assert.match(result.output, /Focused window "Home - Spotify" \(Spotify\)\. That is the window now in front/);
    assert.deepEqual(bridge.calls.map((c) => c.kind), ["list_windows", "focus_window"]);
  } finally { desktop.detach(); }
});

test("focus_window that closed mid-call returns a typed failure", withWindows(async (bridge) => {
  desktop.detach();
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "list_windows") return { windows: WINDOWS, count: WINDOWS.length };
    if (payload.kind === "focus_window") {
      const err = new Error("That window no longer exists - it closed before this action ran.");
      err.code = "CLOSED";
      throw err;
    }
    throw new Error("unexpected");
  }));
  const result = await TOOL_MAP.get("focus_window").run({ name: "spotify" });
  assert.equal(result.ok, false);
  assert.match(result.output, /closed before it could be focused/);
  assert.match(result.output, /Nothing was focused/);
}));

test("focus_window with no match lists what is open instead of guessing", withWindows(async () => {
  const result = await TOOL_MAP.get("focus_window").run({ name: "chrome" });
  assert.equal(result.ok, false);
  assert.match(result.output, /No open window matches "chrome"/);
  assert.match(result.output, /Home - Spotify/);
}));

test("minimise_window minimises a unique match and reports it", withWindows(async () => {
  desktop.detach();
  const bridge = fakeBridge((payload) => {
    if (payload.kind === "list_windows") return { windows: WINDOWS, count: WINDOWS.length };
    if (payload.kind === "minimise_window") return { handle: payload.handle, title: "Home - Spotify", process: "Spotify", minimised: true };
    throw new Error("unexpected");
  });
  desktop.attach(bridge);
  const result = await TOOL_MAP.get("minimise_window").run({ name: "spotify" });
  assert.equal(result.ok, true);
  assert.match(result.output, /Minimised window "Home - Spotify" \(Spotify\)/);
  assert.deepEqual(bridge.calls.map((c) => c.kind), ["list_windows", "minimise_window"]);
}));

test("close_window is approval-gated, names the application, and surfaces denial", withWindows(async () => {
  assert.equal(DANGEROUS.has("close_window"), true, "closing a window is destructive and must require approval");
  desktop.detach();
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "list_windows") return { windows: WINDOWS, count: WINDOWS.length };
    if (payload.kind === "close_window") {
      const err = new Error("Closing Spotify was denied at the confirmation dialog. Nothing was closed.");
      err.code = "DENIED";
      throw err;
    }
    throw new Error("unexpected");
  }));
  const denied = await TOOL_MAP.get("close_window").run({ name: "spotify" });
  assert.equal(denied.ok, false);
  assert.match(denied.output, /denied at the confirmation dialog/);
  assert.match(denied.output, /Spotify/);

  desktop.detach();
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "list_windows") return { windows: WINDOWS, count: WINDOWS.length };
    if (payload.kind === "close_window") return { handle: payload.handle, title: "Home - Spotify", process: "Spotify", closed: true };
    throw new Error("unexpected");
  }));
  const closed = await TOOL_MAP.get("close_window").run({ name: "spotify" });
  assert.equal(closed.ok, true);
  assert.match(closed.output, /Closed window "Home - Spotify" \(Spotify\)/);
}));

test("launch_app refuses paths and shell strings before any host call, and passes plain names through", withWindows(async (bridge) => {
  assert.equal(DANGEROUS.has("launch_app"), true);
  for (const bad of ["C:\\Windows\\cmd.exe", "spotify & calc", "notepad; rm -rf /", "a".repeat(200), ""]) {
    const before = bridge.calls.length;
    const result = await TOOL_MAP.get("launch_app").run({ name: bad });
    assert.equal(result.ok, false, bad);
    assert.match(result.output, /Nothing was started/);
    assert.equal(bridge.calls.length, before, "invalid names must never reach the companion");
  }

  desktop.detach();
  const okBridge = fakeBridge((payload) => {
    if (payload.kind === "launch_app") {
      assert.equal(payload.name, "spotify");
      return { name: "spotify", path: "C:\\Users\\u\\AppData\\Local\\Spotify\\Spotify.exe", pid: 4242 };
    }
    throw new Error("unexpected");
  });
  desktop.attach(okBridge);
  const launched = await TOOL_MAP.get("launch_app").run({ name: "spotify" });
  assert.equal(launched.ok, true);
  assert.match(launched.output, /Launched spotify/);
  assert.deepEqual(okBridge.calls.map((c) => c.kind), ["launch_app"]);

  desktop.detach();
  desktop.attach(fakeBridge((payload) => {
    if (payload.kind === "launch_app") {
      const err = new Error('"rm" is not an approved application. Available: calculator, notepad, ... Nothing was started.');
      err.code = "UNKNOWN_APP";
      throw err;
    }
    throw new Error("unexpected");
  }));
  const unknown = await TOOL_MAP.get("launch_app").run({ name: "rm" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /not an approved application/);
  assert.match(unknown.output, /Nothing was started/);
}));

test("no window/app tool source ever reaches a shell", () => {
  for (const name of ["list_windows", "focus_window", "minimise_window", "close_window", "launch_app"]) {
    const src = TOOL_MAP.get(name).run.toString();
    assert.doesNotMatch(src, /runShell|spawn|execFile|child_process/, `${name} must not shell out`);
  }
});

/* ── windows-companion bridge: typed request/response, timeout, UNREACHABLE ── */

function hostFixture() {
  let id = 0;
  const jobs = new Map(), children = [];
  const clock = { setTimeout(fn) { jobs.set(++id, fn); return id; }, clearTimeout(j) { jobs.delete(j); } };
  const tick = () => { const [jid, fn] = jobs.entries().next().value || []; assert.ok(fn, "expected scheduled work"); jobs.delete(jid); fn(); };
  const runtime = new DesktopRuntime();
  const host = startWindowsCompanion({
    platform: "win32", runtime, clock, log: { warn() {} }, onQuit() {},
    spawnChild() {
      const child = new EventEmitter();
      child.stdin = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      child.messages = []; child.stdin.writable = true;
      child.stdin.write = (line) => { child.messages.push(JSON.parse(line)); return true; };
      child.stdin.end = child.stdin.write;
      child.kill = () => child.emit("exit", 1);
      child.event = (e) => child.stdout.emit("data", Buffer.from(JSON.stringify(e) + "\n"));
      children.push(child);
      return child;
    },
  });
  return { runtime, host, children, jobs, tick };
}

test("bridge os() resolves with the structured payload and passes typed failure codes through", async () => {
  const f = hostFixture();
  const child = f.children[0];
  child.event({ type: "ready" });
  assert.equal(f.runtime.state.available, true);

  const listPromise = f.runtime.os("list_windows");
  const listMsg = child.messages.find((m) => m.op === "os" && m.kind === "list_windows");
  assert.ok(listMsg, "the os request went over the pipe with a deadline");
  assert.ok(Number.isFinite(listMsg.deadline));
  child.event({ type: "result", id: listMsg.id, ok: true, text: "2 visible window(s).", code: "", data: { windows: WINDOWS.slice(0, 2), count: 2 } });
  const list = await listPromise;
  assert.equal(list.count, 2);
  assert.equal(list.windows[0].process, "Spotify.exe");

  const focusPromise = f.runtime.os("focus_window", { handle: "1001" });
  const focusMsg = child.messages.find((m) => m.op === "os" && m.kind === "focus_window");
  assert.equal(focusMsg.handle, "1001");
  child.event({ type: "result", id: focusMsg.id, ok: false, text: "That window no longer exists.", code: "CLOSED", data: null });
  await assert.rejects(focusPromise, (err) => err.code === "CLOSED" && /no longer exists/.test(err.message));

  f.host.stop(); while (f.jobs.size) f.tick();
});

test("an os request the host never answers rejects UNREACHABLE, never resolves", async () => {
  const f = hostFixture();
  const child = f.children[0];
  child.event({ type: "ready" });
  const pending = f.runtime.os("list_windows", { timeoutMs: 5000 });
  assert.equal(child.messages.filter((m) => m.op === "os").length, 1);
  f.tick(); // fire the request timeout
  await assert.rejects(pending, (err) => err.code === "UNREACHABLE" && err.timeout === true && /did not answer/.test(err.message));
  f.host.stop(); while (f.jobs.size) f.tick();
});

test("a companion disconnect mid-os-request is UNREACHABLE too", async () => {
  const f = hostFixture();
  const child = f.children[0];
  child.event({ type: "ready" });
  const pending = f.runtime.os("focus_window", { handle: "1001" });
  child.stdin.emit("error", new Error("pipe gone"));
  await assert.rejects(pending, (err) => err.code === "UNREACHABLE" && /outcome unknown/.test(err.message));
  f.host.stop(); while (f.jobs.size) f.tick();
});

test("os() with no running host rejects immediately with UNREACHABLE", async () => {
  const runtime = new DesktopRuntime();
  await assert.rejects(runtime.os("list_windows"), (err) => err.code === "UNREACHABLE" && err.status === 503);
  await assert.rejects(runtime.focusWindow("1001"), (err) => err.code === "UNREACHABLE");
  await assert.rejects(runtime.launchApp("spotify"), (err) => err.code === "UNREACHABLE");
});

/* ── Companion.cs host policy (source-level; the host only runs on Windows) ── */

test("Companion.cs enumerates windows and exposes focus/minimise/restore/close with handle re-validation", () => {
  const cs = readFileSync(new URL("../desktop/Companion.cs", import.meta.url), "utf8");
  for (const needle of ["EnumWindows", "IsWindowVisible", "GetWindowThreadProcessId", "SetForegroundWindow", "ShowWindow", "IsIconic", "PostMessage", "WM_CLOSE", "GetForegroundWindow"]) {
    assert.ok(cs.includes(needle), `Companion.cs must P/Invoke ${needle}`);
  }
  assert.ok(cs.includes('case "os": OsRequest(m); break;'), "the os op must be dispatched");
  // A window that closed mid-call is a typed CLOSED failure at action time.
  assert.match(cs, /static bool Alive\(IntPtr h\)\s*\{\s*return User32\.IsWindow\(h\);/);
  assert.match(cs, /if \(!Alive\(h\)\)\s*\{\s*throw new OsFailure\("CLOSED"/);
  assert.match(cs, /if \(!Alive\(h\)\)\s*\{\s*throw new OsFailure\("CLOSED", "The window closed while it was being focused/);
  // Closing is destructive: native confirmation naming the application.
  assert.ok(cs.includes("Confirm(") && cs.includes("Close the window") && cs.includes("+ app + "), "the confirmation dialog names the window title and application");
  assert.match(cs, /OsFailure\("DENIED"/);
});

test("Companion.cs launch never concatenates model text into a command line or path", () => {
  const cs = readFileSync(new URL("../desktop/Companion.cs", import.meta.url), "utf8");
  const launch = cs.slice(cs.indexOf("public static Dictionary<string, object> LaunchApp"), cs.indexOf("public static class QuasnoozeCompanion"));
  assert.match(launch, /KnownApps\.TryGetValue\(key, out path\)/, "known list is a dictionary lookup by name");
  assert.match(launch, /UserApps\(\)\.TryGetValue\(key, out path\)/, "user entries are a dictionary lookup by name");
  assert.match(launch, /Process\.Start\(new ProcessStartInfo\(path\) \{ UseShellExecute = false \}\)/, "only the resolved path starts, never through a shell, with no arguments");
  assert.doesNotMatch(launch, /Process\.Start\([^)]*(Value\(m|name\s*\+|key\s*\+)/, "no model string may be concatenated into Process.Start");
  assert.doesNotMatch(launch, /ProcessStartInfo\([^)]*\{?\s*Arguments/, "no model-controlled arguments");
  assert.ok(cs.includes("apps.json"), "user-configured entries load from apps.json");
  assert.match(cs, /public static bool ValidAppKey\(string key\)/);
  assert.ok(cs.includes('ValidAppKey("note; echo x")'), "SelfTest rejects shell strings as app names");
  assert.ok(cs.includes('case "launch_app"'));
});

test(
  "Companion.cs and desktop runtime handle read_clipboard and write_clipboard over the typed os channel",
  withWindows(
    async (bridge) => {
      const cs = readFileSync(new URL("../desktop/Companion.cs", import.meta.url), "utf8");
      assert.ok(cs.includes('case "read_clipboard"'), "Companion.cs must handle read_clipboard");
      assert.ok(cs.includes('case "write_clipboard"'), "Companion.cs must handle write_clipboard");
      assert.ok(cs.includes("Encoding.UTF8.GetByteCount"), "Companion.cs must report full UTF-8 byte length before wire capping");
      assert.ok(cs.includes("ExternalException"), "Companion.cs must translate locked clipboard ExternalException to OsFailure");

      const readRes = await TOOL_MAP.get("read_clipboard").run({});
      assert.equal(readRes.ok, true);
      assert.match(readRes.output, /9000 bytes total; truncated to 28 bytes/);

      const writeRes = await TOOL_MAP.get("write_clipboard").run({ text: "hello companion" });
      assert.equal(writeRes.ok, true);
      assert.deepEqual(bridge.calls.map((c) => c.kind), ["read_clipboard", "write_clipboard"]);
      assert.equal(bridge.calls[1].content, "hello companion");
    },
    (payload) => {
      if (payload.kind === "read_clipboard") {
        return { hasText: true, content: "Copied via Windows companion", bytes: 9000, wireClipped: true };
      }
      if (payload.kind === "write_clipboard") {
        return { bytes: Buffer.byteLength(payload.content, "utf8") };
      }
      return {};
    },
  ),
);
