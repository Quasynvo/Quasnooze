import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url));
test('README and every current companion view reference refreshed artwork',()=>{
 assert.match(read('README.md').toString(),/assets\/quasnooze-showcase\.gif/);
 for(const path of ['public/cosmic.html','public/desktop.html','site/index.html']){
  assert.match(read(path).toString(),/quasnooze-companion\.webp/);
  assert.doesNotMatch(read(path).toString(),/cosmic-sloth\.webp/);
 }
});
test('legacy artwork URLs contain the new art, and site/app use identical pixels',()=>{
 const current=read('public/brand/quasnooze-companion.webp');
 for(const path of ['public/brand/cosmic-sloth.webp','site/assets/quasnooze-companion.webp','site/assets/cosmic-sloth.webp'])assert.deepEqual(read(path),current);
 assert.deepEqual(read('assets/demo.gif'),read('assets/quasnooze-showcase.gif'));
});
test('native Windows decoration is a small PNG rather than unsupported WebP',()=>{
 const png=read('public/brand/quasnooze-companion-native.png');
 assert.equal(png.subarray(1,4).toString(),'PNG');assert.equal(png.readUInt32BE(16),160);assert.equal(png.readUInt32BE(20),160);
 const native=read('desktop/Companion.cs').toString();assert.match(native,/quasnooze-companion-native\.png/);assert.match(native,/AccessibleName = "Quasnooze companion illustration", TabStop = false/);
});
