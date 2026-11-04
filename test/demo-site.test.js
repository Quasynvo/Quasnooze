/**
 * demo-site.test.js — the published preview is a claim about the product.
 *
 * site/demo/ is the only way to look at Quasnooze without installing it, which
 * makes it the most-read page in the repository and the easiest place to
 * mislead someone. Three things therefore get tested rather than trusted:
 *
 *   1. The preview cannot reach a backend. It carries `<html data-preview>`,
 *      not `?demo=1` — a query string disappears when someone shares the link.
 *   2. Every asset reference resolves. The interface was built against a server
 *      serving `/visualizer.css` at the root; Pages serves it two directories
 *      down, where an absolute path is a 404 nobody notices until a visitor
 *      reports a blank canvas.
 *   3. It says what it is. A page showing a microphone button and a "speaking"
 *      state, with no model behind either, has to say so on the page.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ASSETS, PAGES, build, rewrite } from "../scripts/build-demo-site.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const demo = join(root, "site", "demo");

test("the conversation preview is pinned to preview mode in the document, not the query string", () => {
  const html = readFileSync(join(demo, "index.html"), "utf8");
  assert.match(html, /<html[^>]*data-preview="true"/);
  assert.doesNotMatch(html, /\?demo=1/, "a query string can be lost when the link is shared");
});

test("preview mode is what cosmic.js reads", () => {
  // If the renderer ever stops honouring data-preview, the published page would
  // silently start trying to reach /api on the Pages origin.
  const js = readFileSync(join(demo, "cosmic.js"), "utf8");
  assert.match(js, /dataset\.preview/);
  assert.match(js, /if \(demo \|\| polling \|\| document\.hidden\) return;/);
});

test("no absolute asset path survives the rewrite", () => {
  for (const page of PAGES) {
    const html = readFileSync(join(demo, page.to), "utf8");
    const absolute = [...html.matchAll(/(?:href|src)="(\/[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(absolute, [], `${page.to} still points at the server root`);
  }
});

test("every asset the preview references was copied", () => {
  for (const page of PAGES) {
    const html = readFileSync(join(demo, page.to), "utf8");
    const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((r) => !/^(https?:|mailto:|data:|#)/.test(r));
    for (const ref of refs) {
      const target = ref.startsWith("../") ? join(root, "site", ref.slice(3)) : join(demo, ref);
      assert.ok(existsSync(target), `${page.to} references ${ref}, which is not published`);
    }
  }
});

test("the preview says, on the page, that nothing behind it is real", () => {
  const html = readFileSync(join(demo, "index.html"), "utf8");
  assert.match(html, /STATIC PREVIEW · NO MODEL, NO TOOLS, NO ACCOUNT/);
  assert.match(html, /scripted/i);
  const playground = readFileSync(join(demo, "visualizer.html"), "utf8");
  assert.match(playground, /SYNTHETIC MOTION BY DEFAULT/);
  assert.match(playground, /stays off until you enable it|never leave this page/);
});

test("backend-coupled surfaces are not published by accident", () => {
  // index.html and desktop.html poll /api on load. A static copy of either
  // greets the visitor with "unreachable", which is worse than not shipping it.
  assert.ok(!existsSync(join(demo, "desktop.html")));
  assert.ok(!ASSETS.some((a) => a.includes("desktop.js")), "desktop.js opens an API connection");
});

test("the builder is idempotent and reports broken references instead of succeeding quietly", () => {
  const tmp = mkdtempSync(join(tmpdir(), "quasnooze-demo-test-"));
  try {
    const first = build(join(tmp, "a"));
    assert.deepEqual(first.missing, []);
    const second = build(join(tmp, "b"));
    assert.deepEqual(second.missing, []);
    for (const page of PAGES) {
      const a = readFileSync(join(tmp, "a", page.to), "utf8");
      const b = readFileSync(join(tmp, "b", page.to), "utf8");
      assert.equal(a, b, "two builds of the same source must agree");
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the committed preview matches a fresh build from public/", () => {
  // Runs the real CLI so the check CI uses is the check tested here.
  const out = execFileSync(process.execPath, [join(root, "scripts", "build-demo-site.js"), "--check"], {
    encoding: "utf8",
  });
  assert.match(out, /matches public\//);
});

test("rewrite moves a root-relative link under the preview instead of leaving a 404", () => {
  const html = rewrite(
    '<html lang="en"><head><link rel="stylesheet" href="/visualizer.css"></head><body></body></html>',
    { from: "visualizer.html", to: "visualizer.html", preview: false, title: "t", description: "d", note: "n", detail: "x" },
  );
  assert.match(html, /href="visualizer\.css"/);
  assert.doesNotMatch(html, /href="\/visualizer\.css"/);
});
