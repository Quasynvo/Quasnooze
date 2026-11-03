import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url));
test('README and current voice views use the Fluid Motion identity', () => {
  assert.match(read('README.md').toString(), /assets\/quasnooze-showcase\.gif/);
  for (const path of ['public/cosmic.html', 'public/desktop.html', 'site/index.html']) {
    const html = read(path).toString();
    assert.match(html, /voice-engine\.svg/);
    assert.match(html, /id="voiceCanvas"/);
    assert.doesNotMatch(html, /sloth|\.webp|mouth|avatarStage/i);
  }
});
test('retired character images are absent, not compatibility wrappers', () => {
  for (const path of ['assets/quasnooze-companion-source.png', 'public/brand/quasnooze-companion.webp', 'public/brand/quasnooze-companion-native.png', 'site/assets/quasnooze-companion.webp', 'docs/brand/quasnooze-avatar.png']) {
    assert.equal(existsSync(new URL('../' + path, import.meta.url)), false, path);
  }
  assert.deepEqual(read('assets/demo.gif'), read('assets/quasnooze-showcase.gif'));
  const gif = read('assets/demo.gif');
  assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
  assert.ok(gif.length < 2_000_000, 'README animation stays below 2 MB');
});
test('static and native marks are real replacements', () => {
  const svg = read('public/brand/voice-engine.svg').toString();
  assert.match(svg, /interference ribbons/);
  assert.doesNotMatch(svg, /<image|<script|data:image/);
  const png = read('public/brand/voice-engine-native.png');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 160);
  assert.equal(png.readUInt32BE(20), 160);
  assert.match(read('desktop/Companion.cs').toString(), /voice-engine-native\.png/);
});
test('static site carries exact shared engine source and no CDN dependency', () => {
  for (const name of ['visualizer.js', 'visualizer.css', 'demo-signal.js']) assert.deepEqual(read('site/assets/' + name), read('public/' + name));
  assert.doesNotMatch(read('site/index.html').toString(), /<script[^>]+src="https?:/);
});
test('current branding has no animal mascot language or image aliases', () => {
  const paths = ['README.md', 'CONTRIBUTING.md', 'docs/REBRANDING.md', 'docs/VISUALIZER.md', 'docs/VOICE.md', 'docs/DESKTOP.md', 'package.json', 'src/prompt.js', 'public/cosmic.html', 'public/cosmic.js', 'public/cosmic.css', 'public/desktop.html', 'public/index.html', 'site/index.html', 'site/app.js', 'site/style.css'];
  for (const path of paths) assert.doesNotMatch(read(path).toString(), /sloth|🦥|🦞|lobster theme|cosmic companion/i, path);
});
