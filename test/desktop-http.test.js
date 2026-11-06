import { get } from "node:http";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "pinch-desktop-http-"));
process.env.PINCH_DATA = data;
process.env.PINCH_WORKSPACE = data;
process.env.LLM_PROVIDER = "mock";
process.env.PINCH_KEY = "desktop-test-key";
const { createQuasnoozeServer } = await import("../src/server.js");
const { ensureData } = await import("../src/store.js"); ensureData();
const server = createQuasnoozeServer(); await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const headers = { "x-pinch-key": "desktop-test-key", "content-type": "application/json" };
after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); rmSync(data, { recursive: true, force: true }); });

test("desktop API has the existing key, Origin, Host and cookie-only defenses", async () => {
  assert.equal((await fetch(base + "/api/desktop")).status, 401);
  assert.equal((await fetch(base + "/api/desktop", { headers: { cookie: "pinch_key=desktop-test-key" } })).status, 401);
  assert.equal((await fetch(base + "/api/desktop", { headers: { ...headers, origin: "https://attacker.invalid" } })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    get(base + "/api/desktop", { headers: { ...headers, host: "attacker.invalid" } }, (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject);
  });
  assert.equal(foreignHost, 403);
  const response = await fetch(base + "/api/desktop", { headers });
  assert.equal(response.status, 200); assert.equal((await response.json()).available, false);
});

test("desktop API validates request shape, methods, approvals and unavailable controls", async () => {
  for (const body of [{}, [], { text: "x", control: "listen" }, { execute: "cmd.exe" }, { text: 123 }, { approval: { id: "x", allowed: "true" } }]) {
    assert.equal((await fetch(base + "/api/desktop", { method: "POST", headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal((await fetch(base + "/api/desktop", { method: "PUT", headers })).status, 405);
  assert.equal((await fetch(base + "/api/desktop", { method: "POST", headers, body: JSON.stringify({ control: "listen" }) })).status, 503);
  assert.equal((await fetch(base + "/api/desktop", { method: "POST", headers, body: JSON.stringify({ approval: { id: "foreign", allowed: true } }) })).status, 404);
});

test("desktop clock fast path works without inference or native processes", async () => {
  const response = await fetch(base + "/api/desktop", { method: "POST", headers, body: JSON.stringify({ text: "what time is it" }) });
  assert.equal(response.status, 200); const result = await response.json();
  assert.equal(result.fastPath, true); assert.equal(result.ok, true); assert.match(result.text, /It is/);
});

test("command deck is served as a real local asset and contains no external runtime dependencies", async () => {
  const response = await fetch(base + "/desktop.html", { headers });
  assert.equal(response.status, 200); const html = await response.text();
  const home = await fetch(base + "/", { headers });
  assert.match(await home.text(), /Command Deck/);
  assert.equal((await fetch(base + "/index.html", { headers })).status, 200);
  assert.match(html, /Command Deck/);
  assert.ok(html.includes('<script src="/desktop.js" defer></script>'));
  const scriptResponse = await fetch(base + "/desktop.js", { headers });
  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type"), /javascript/);
  const source = await scriptResponse.text();
  assert.match(source, /api\/desktop/);
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:|<link[^>]+href=["']https?:/);
});

test("voice brand assets and the opt-in visualizer use correct MIME types", async () => {
  const response = await fetch(base + "/cosmic.html", { headers });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Quasnooze/);
  const image = await fetch(base + "/brand/voice-engine.svg", { headers });
  assert.equal(image.status, 200); assert.match(image.headers.get("content-type"), /image\/svg\+xml/);
  assert.ok((await image.arrayBuffer()).byteLength < 200_000);
  for (const path of ["/cosmic.js", "/cosmic.css", "/brand/voice-engine.svg", "/visualizer.html", "/visualizer.js", "/audio-input.js"]) assert.equal((await fetch(base + path, { headers })).status, 200);
  assert.match(await (await fetch(base + "/", { headers })).text(), /Command Deck/);
});

test("owner memory API isolates scopes and requires the existing authentication", async () => {
  const post = body => fetch(base + '/api/memory', { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/memory?scope=project:sample')).status, 401);
  assert.equal((await post({ scope: 'project:sample', fact: 'old deadline', source: 'owner' })).status, 200);
  const selected = await (await fetch(base + '/api/memory?scope=project:sample', { headers })).json();
  assert.equal(selected.facts.length, 1);
  const corrected = await post({ scope: 'project:sample', correct: { id: selected.facts[0].id, fact: 'new deadline', source: 'meeting' } });
  assert.equal(corrected.status, 200);
  assert.equal((await corrected.json()).text, 'new deadline');
  const user = await (await fetch(base + '/api/memory', { headers })).json();
  assert.equal(user.facts.some(f => f.text.includes('deadline')), false);
  assert.equal((await post({ scope: 'project:other', correct: { id: selected.facts[0].id, fact: 'wrong' } })).status, 400);
  assert.equal((await post({ scope: 'project:sample', forget: 'old deadline' })).status, 200);
  assert.deepEqual((await (await fetch(base + '/api/memory?scope=project:sample', { headers })).json()).facts, []);
  assert.equal((await fetch(base + '/api/memory?scope=bad', { headers })).status, 400);
});
