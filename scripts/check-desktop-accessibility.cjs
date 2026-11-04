// Optional developer tooling, not a runtime dependency or screen-reader pass.
// Serves real static UI locally with synthetic, intercepted API responses only.
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('playwright-core')); }

(async () => {
  const root = path.resolve(__dirname, '../public'), errors = [], posts = [], passed = [];
  let state = { available: true, mic: false, phase: 'muted', busy: false, recent: [], approval: null }, unauthorized = false;
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname;
    const file = path.resolve(root, '.' + (name === '/' ? '/desktop.html' : name));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    try {
      const body = await fs.readFile(file);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)];
      res.writeHead(200, { 'content-type': mime || 'application/octet-stream' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.QUASNOOZE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.QUASNOOZE_CHROMIUM_EXECUTABLE } : {}), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { await route.abort(); return; }
      if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
      if (unauthorized) { await route.fulfill({ status: 401, json: { error: 'Synthetic unauthorized' } }); return; }
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); posts.push({ path: url.pathname, body });
        if (body.approval) state = { ...state, approval: null, busy: false, phase: 'muted' };
        if (body.control === 'listen') state = { ...state, mic: true, phase: 'listening' };
        if (body.control === 'mute') state = { ...state, mic: false, phase: 'muted' };
        await route.fulfill({ json: { ...state, ok: true } }); return;
      }
      const data = url.pathname === '/api/desktop' ? state : url.pathname === '/api/models'
        ? { active: { provider: 'ollama', model: 'fixture-model' }, ollama: { models: ['fixture-model'] } }
        : { provider: 'mock', model: 'fixture-model' };
      await route.fulfill({ json: data });
    });
    await page.goto(origin);
    await page.getByText('LOCAL SERVICE CONNECTED', { exact: true }).waitFor();
    const active = () => page.evaluate(() => document.activeElement.id || document.activeElement.getAttribute('href'));
    const refresh = () => page.evaluate(() => refresh());
    // Native dialogs may include the browser-chrome Tab boundary (BODY in a
    // headless DOM) before wrapping; never mistake it for a focusable page control.
    const tab = async () => { await page.keyboard.press('Tab'); if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press('Tab'); };
    const noMicPosts = () => assert.equal(posts.filter(p => ['listen', 'mute'].includes(p.body.control)).length, 0);
    await page.keyboard.press('Tab'); assert.equal(await active(), '#overview');
    await page.keyboard.press('Tab'); assert.equal(await active(), '/cosmic.html');
    await page.keyboard.press('Tab'); assert.equal(await active(), '#activity');
    await page.keyboard.press('Tab'); assert.equal(await active(), 'settingsNav');
    passed.push('natural Tab order reaches navigation and settings'); noMicPosts();

    await page.locator('#nativeHelp').focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Your Windows voice host' }).waitFor();
    assert.equal(await page.locator('#nativeDialog [data-close]').evaluate(el => el === document.activeElement), true);
    await tab();
    assert.equal(await page.locator('#nativeDialog').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#nativeDialog').isVisible(), false);
    assert.equal(await active(), 'nativeHelp');
    passed.push('named native help dialog: keyboard entry, focus containment, Escape and return');

    await page.locator('#modelButton').focus(); await page.keyboard.press('Space');
    await page.getByRole('dialog', { name: 'Choose the real local model' }).waitFor();
    await page.waitForFunction(() => !document.getElementById('saveModel').disabled);
    assert.equal(await active(), 'modelSelect');
    await page.keyboard.press('Tab'); assert.equal(await active(), 'saveModel');
    await page.keyboard.press('Tab'); assert.equal(await active(), 'refreshModels');
    await tab();
    assert.equal(await page.locator('#modelDialog').evaluate(el => el.contains(document.activeElement)), true);
    await page.keyboard.press('Escape'); assert.equal(await active(), 'modelButton');
    assert.equal(posts.some(p => p.path === '/api/models'), false);
    passed.push('model dialog focus order/return and Escape without saving');

    await page.locator('#command').focus(); unauthorized = true; await refresh();
    await page.getByRole('dialog', { name: 'Connect securely' }).waitFor();
    assert.equal(await active(), 'keyInput');
    unauthorized = false; await page.keyboard.press('Escape');
    assert.equal(await active(), 'command'); await refresh();
    assert.equal(posts.length, 0);
    passed.push('key dialog focus entry and Escape/return without connecting');

    assert.notEqual(await page.locator('#command').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    passed.push('keyboard command input has visible focus');
    const addApproval = async id => {
      state = { ...state, busy: true, phase: 'approval', approval: { id, description: 'Synthetic permission <img src=x onerror=alert(1)>' } };
      await refresh(); await page.locator('#permission').waitFor({ state: 'visible' });
    };
    await addApproval('fixture-deny-escape');
    assert.equal(await active(), 'command'); // Background polling must not steal typing focus.
    await page.getByRole('region', { name: 'Quasnooze needs your permission' }).waitFor();
    assert.match(await page.locator('#permissionStatus').textContent(), /Permission required/);
    await page.keyboard.press('Escape'); assert.equal(posts.filter(p => p.body.approval).length, 0);
    await page.locator('[data-command="system status"]').focus();
    await page.keyboard.press('Tab'); assert.equal(await active(), 'allow');
    await page.keyboard.press('Tab'); assert.equal(await active(), 'deny');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('permission').hidden);
    assert.deepEqual(posts.at(-1).body, { approval: { id: 'fixture-deny-escape', allowed: false } });
    assert.equal(await active(), 'command');
    passed.push('visible permission status, no background focus theft, scoped Escape denies exact ID');
    await addApproval('fixture-deny-space'); await page.locator('#deny').focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('permission').hidden);
    assert.deepEqual(posts.at(-1).body, { approval: { id: 'fixture-deny-space', allowed: false } });
    assert.equal(await active(), 'command');
    passed.push('Deny activates with Space and restores command focus');
    await addApproval('fixture-allow-enter'); await page.locator('#allow').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('permission').hidden);
    assert.deepEqual(posts.at(-1).body, { approval: { id: 'fixture-allow-enter', allowed: true } });
    assert.equal(await active(), 'command');
    passed.push('Allow once requires explicit button activation with the current ID'); noMicPosts();

    await page.locator('#listenButton').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('micState').textContent === 'ON');
    await page.locator('#muteButton').focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('micState').textContent === 'OFF');
    assert.deepEqual(posts.filter(p => p.body.control).map(p => p.body.control), ['listen', 'mute']);
    assert.equal(await page.locator('#micStatus').getAttribute('role'), 'status');
    state = { ...state, mic: false, micUnknown: true, available: false, phase: 'unavailable' }; await refresh();
    assert.equal(await page.locator('#micState').textContent(), 'UNKNOWN');
    assert.match(await page.locator('#audioLabel').textContent(), /UNKNOWN/);
    assert.match(await page.locator('#footerState').textContent(), /UNKNOWN/);
    assert.equal(await page.locator('#listenButton').isDisabled(), true);
    passed.push('explicit Talk/Mute only; visible ON/OFF/UNKNOWN states and disabled unavailable input');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'pass', environment: { platform: process.platform, node: process.version, browser: await browser.version(), backend: 'synthetic intercepted API; no native host/model', assistiveTechnology: 'not-run' }, passed, limitations: ['Automated Chromium keyboard/DOM checks are not a Windows, microphone or screen-reader pass.', 'No manual hardware or assistive-technology observations were collected.'] }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
