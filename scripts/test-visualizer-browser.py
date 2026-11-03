"""Optional browser checks: Python Playwright + Chromium; no runtime dependency.

Uses Chromium's synthetic audio device, never a physical microphone. Tests real
Web Audio/permission/canvas paths plus a mocked denial and unavailable canvas.
Run: python3 scripts/test-visualizer-browser.py
"""
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json, tempfile, threading
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1] / 'public'
OUT = Path(tempfile.mkdtemp(prefix='quasnooze-visualizer-'))
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, *args):
        pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_address[1]}'
results = []
def passed(name):
    results.append(name)
    print('PASS', name)

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'
        ])
        context = browser.new_context(viewport={'width': 1440, 'height': 1000}, permissions=['microphone'])
        context.add_init_script('''
          window.__captureCalls = 0; window.__testTracks = [];
          if (navigator.mediaDevices) {
            const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = async (...args) => {
              window.__captureCalls++;
              const stream = await original(...args);
              window.__testTracks.push(...stream.getTracks());
              return stream;
            };
          }
        ''')
        page = context.new_page()
        errors, requests = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: requests.append(request.url))
        page.goto(base + '/visualizer.html')
        expect(page.locator('#voiceCanvas')).to_have_attribute('data-running', 'true')
        assert page.evaluate('window.__captureCalls') == 0
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(OUT / 'visualizer-desktop.png'), full_page=True)
        passed('Default preview renders without capture or horizontal overflow')

        for state in ['idle', 'listening', 'thinking', 'speaking', 'error']:
            button = page.locator(f'button[data-state="{state}"]')
            button.click()
            expect(button).to_have_attribute('aria-pressed', 'true')
            expect(page.locator('#voiceCanvas')).to_have_attribute('data-motion-state', state)
            expect(page.locator('#stateTitle')).not_to_have_text('')
            page.wait_for_timeout(250)
            page.locator('#visualizer').screenshot(path=str(OUT / f'{state}.png'))
        assert page.evaluate('window.__captureCalls') == 0
        passed('Five states update geometry, pressed semantics and text without capture')

        page.locator('#reduceMotion').check()
        expect(page.locator('#voiceCanvas')).to_have_attribute('data-running', 'false')
        first = page.locator('#voiceCanvas').screenshot()
        page.wait_for_timeout(300)
        second = page.locator('#voiceCanvas').screenshot()
        assert first == second, 'Reduced-motion canvas must remain pixel-stable'
        page.locator('#reduceMotion').uncheck()
        passed('Reduced motion stops RAF and produces a pixel-stable canvas')

        page.locator('#micButton').click()
        expect(page.locator('#micButton')).to_have_text('Turn microphone off')
        expect(page.locator('#signalSource')).to_contain_text('LIVE MICROPHONE')
        assert page.evaluate('window.__captureCalls') == 1
        assert page.evaluate('window.__testTracks.every(track => track.readyState === "live")')
        page.wait_for_timeout(350)
        page.locator('#micButton').click()
        expect(page.locator('#inputLabel')).to_have_text('INPUT / OFF')
        assert page.evaluate('window.__testTracks.every(track => track.readyState === "ended")')
        passed('Explicit click starts real Web Audio with synthetic device; mute ends tracks')

        page.locator('#micButton').click()
        expect(page.locator('#micButton')).to_have_text('Turn microphone off')
        page.evaluate('''() => {
          Object.defineProperty(document, 'hidden', {configurable:true, value:true});
          document.dispatchEvent(new Event('visibilitychange'));
        }''')
        expect(page.locator('#inputLabel')).to_have_text('INPUT / OFF')
        assert page.evaluate('window.__testTracks.every(track => track.readyState === "ended")')
        passed('Visibility handler releases an active microphone')

        page.evaluate("Object.defineProperty(document, 'hidden', {configurable:true, value:false})")
        page.locator('#micButton').click()
        expect(page.locator('#micButton')).to_have_text('Turn microphone off')
        page.goto('about:blank')
        assert page.evaluate('window.__testTracks.every(track => track.readyState === "ended")')
        passed('Page exit releases microphone tracks')

        page.goto(base + '/visualizer.html')
        page.evaluate('''() => {
          navigator.mediaDevices.getUserMedia = async () => {
            window.__captureCalls++;
            throw new DOMException('Denied for test', 'NotAllowedError');
          };
        }''')
        page.locator('#micButton').click()
        expect(page.locator('#micNotice')).to_contain_text('permission was denied')
        expect(page.locator('#voiceCanvas')).to_have_attribute('data-motion-state', 'error')
        expect(page.locator('#inputLabel')).to_have_text('INPUT / OFF')
        page.locator('button[data-state="idle"]').click()
        expect(page.locator('button[data-state="idle"]')).to_have_attribute('aria-pressed', 'true')
        passed('Permission denial is actionable; state controls remain usable')

        for width in [390, 320]:
            page.set_viewport_size({'width': width, 'height': 844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path=str(OUT / 'visualizer-mobile.png'), full_page=True)
        passed('390px and 320px layouts have no horizontal overflow')

        page.goto(base + '/visualizer.html')
        page.locator('button[data-state="thinking"]').focus()
        page.keyboard.press('Enter')
        expect(page.locator('button[data-state="thinking"]')).to_have_attribute('aria-pressed', 'true')
        passed('State selection works with keyboard alone')

        assert all(url.startswith(base + '/') for url in requests)
        assert not any('/api/' in url for url in requests)
        assert not errors, errors
        passed('No external requests, backend calls or browser JavaScript exceptions')

        fallback = context.new_page()
        fallback.add_init_script('''
          const original = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function(type, ...args) {
            return type === '2d' ? null : original.call(this, type, ...args);
          };
        ''')
        fallback.goto(base + '/visualizer.html')
        expect(fallback.locator('.visualizer-fallback')).to_be_visible()
        fallback.locator('button[data-state="error"]').click()
        expect(fallback.locator('#stateTitle')).to_contain_text('Interrupted')
        passed('Unavailable Canvas 2D retains SVG fallback and usable state controls')
        browser.close()
finally:
    server.shutdown()
(OUT / 'results.json').write_text(json.dumps({'passed': results, 'audio': 'Chromium synthetic device; no physical microphone', 'errors': []}, indent=2))
print(len(results), 'visualizer browser scenarios passed')
print('Browser artifacts:', OUT)
