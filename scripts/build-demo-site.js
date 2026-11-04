#!/usr/bin/env node
/**
 * build-demo-site.js — publish a read-only preview of the interface to Pages.
 *
 * Why this exists: the application cannot be tried without Node 22, a checkout
 * and (for real answers) Ollama. That is the whole funnel, and it is four steps
 * long. Anyone deciding whether Quasnooze is interesting has to take all four on
 * trust. The renderer already runs in a browser with no backend — `?demo=1` and
 * `data-preview` were built for exactly this — so the honest preview has always
 * been one static copy away. This script is that copy.
 *
 * What it does, in order:
 *
 *   1. copies the renderer's assets from public/ into site/demo/
 *   2. emits two pages: the conversation preview (forced into preview mode by
 *      the `<html data-preview="true">` flag, not a query string, so it cannot
 *      accidentally address a live backend) and the five-state playground
 *   3. rewrites every absolute `/asset` reference to a relative one, because
 *      Pages serves this from /Quasnooze/demo/ and `/visualizer.css` there is a
 *      404
 *   4. refuses to finish if any reference in the output does not resolve to a
 *      file that was actually copied
 *
 * Run `--check` to build into a temp directory and compare against the
 * committed site/demo/. CI uses that so the published preview cannot drift away
 * from public/ — the same reason the brand assets are committed and verified.
 *
 * The banner injected into each page is not decoration. A preview of a product
 * that normally has a microphone, a model and a shell must say, in the page
 * itself, that none of them are here.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const OUT = join(ROOT, "site", "demo");

/** Assets copied verbatim. HTML is emitted per page below; the backend-coupled
 * pages (index.html, desktop.html) are deliberately not published — they open an
 * API connection on load, and a preview that says "unreachable" teaches nothing. */
const ASSETS = [
  "approval-preview.js",
  "audio-input.js",
  "cosmic.css",
  "cosmic.js",
  "demo-signal.js",
  "desktop-motion.js",
  "mark.svg",
  "favicon.svg",
  "favicon-32.png",
  "apple-touch-icon.png",
  "visualizer.css",
  "visualizer-demo.js",
  "visualizer.js",
  "brand/voice-engine.svg",
  "brand/voice-engine-native.png",
];

/** Nav targets that only exist on a running server. Each is re-pointed at
 * something that exists on Pages, and the label is patched so the link still
 * describes where it goes. */
const NAV = {
  "/cosmic.html": "./index.html",
  "/cosmic.html?demo=1": "./index.html",
  "/index.html": "./index.html",
  "/desktop.html": "../index.html",
};

const LABELS = [["Current Quasnooze deck ↗", "About Quasnooze ↗"]];

const PAGES = [
  {
    from: "cosmic.html",
    to: "index.html",
    preview: true,
    title: "Quasnooze — static conversation preview",
    description:
      "A scripted, no-install preview of the Quasnooze conversation surface and its Fluid Motion voice signal. No model, no tools, no microphone, no account.",
    note: "STATIC PREVIEW · NO MODEL, NO TOOLS, NO ACCOUNT",
    detail:
      "Everything on this page is scripted. A running Quasnooze answers with a local model and asks before it acts; this copy cannot.",
  },
  {
    from: "visualizer.html",
    to: "visualizer.html",
    preview: false,
    title: "Quasnooze — Fluid Motion state playground",
    description:
      "Try the five motion states of the Quasnooze voice visualizer in the browser. Synthetic motion by default; microphone frequency analysis is opt-in and stays in the page.",
    note: "STATIC PREVIEW · SYNTHETIC MOTION BY DEFAULT",
    detail:
      "The microphone stays off until you enable it, and samples never leave this page. Analysis is not transcription.",
  },
];

function banner(page) {
  const styles = {
    wrap: "position:relative;z-index:60;display:flex;gap:14px;flex-wrap:wrap;align-items:center;justify-content:center;padding:10px 16px;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.08em;color:#c8d8ea;background:#0a1220;border-bottom:1px solid #ffffff24",
    link: "color:#6ee7f9;text-decoration:none;border-bottom:1px solid #6ee7f955",
    detail: "font:11px/1.7 ui-monospace,Consolas,monospace;color:#8ea3b8;letter-spacing:.02em",
  };
  return (
    `<div role="note" style="${styles.wrap}"><span>${page.note}</span>` +
    `<span style="${styles.detail}">${page.detail}</span>` +
    `<a style="${styles.link}" href="../index.html">About Quasnooze ↗</a>` +
    `<a style="${styles.link}" href="https://github.com/Quasynvo/Quasnooze">Source ↗</a></div>`
  );
}

/** Absolute `/x` → relative `x`; nav targets first so their query strings and
 *  destinations survive. Returns the rewritten HTML plus a failure list rather
 *  than throwing, so the caller can report every broken reference at once. */
function rewrite(html, page) {
  for (const [from, to] of LABELS) html = html.split(from).join(to);
  for (const [from, to] of Object.entries(NAV)) {
    html = html.split(`"${from}"`).join(`"${to}"`);
  }
  html = html.replace(/(href|src)="\/([^"]*)"/g, (_m, attr, path) => `${attr}="${path}"`);

  if (page.preview) {
    // Query-string demo mode can be lost in a share, a redirect or a preview
    // card. The document flag cannot.
    if (!html.includes("<html")) throw new Error(`${page.from}: no <html> tag to carry data-preview`);
    html = html.replace(/<html([^>]*)>/, (_m, attrs) => {
      const cleaned = attrs.replace(/\sdata-preview="[^"]*"/, "");
      return `<html${cleaned} data-preview="true">`;
    });
  }

  const head = [
    `<meta name="description" content="${page.description}" />`,
    `<link rel="canonical" href="https://quasynvo.github.io/Quasnooze/demo/${page.to === "index.html" ? "" : page.to}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${page.title}" />`,
    `<meta property="og:description" content="${page.description}" />`,
    `<meta property="og:image" content="https://quasynvo.github.io/Quasnooze/og-image.png" />`,
  ].join("\n    ");
  html = html.replace("</head>", `    ${head}\n  </head>`);
  html = html.replace(/<title>[^<]*<\/title>/, `<title>${page.title}</title>`);
  html = html.replace(/<body([^>]*)>/, (_m, attrs) => `<body${attrs}>${banner(page)}`);
  return html;
}

/** The only parent reference the build emits: back to the landing page. */
const LANDING = "../index.html";

/** `./module.js` — one segment below the importing file, no traversal. */
const SIBLING_MODULE = /^\.\/[A-Za-z0-9_-][A-Za-z0-9._-]*\.js$/;

/** A relative reference that is not a URL, an anchor, a data URI or a mailto. */
function isLocalRef(ref) {
  return ref && !/^(https?:|mailto:|tel:|data:|#|\/\/)/.test(ref);
}

function refs(html) {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1].split("#")[0].split("?")[0]);
}

function imports(js) {
  return [...js.matchAll(/(?:from|import)\s*\(?\s*"(\.[^"]+)"/g)].map((m) => m[1]);
}

function build(outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "brand"), { recursive: true });

  const missing = [];
  for (const asset of ASSETS) {
    const from = join(PUBLIC, asset);
    if (!existsSync(from)) {
      missing.push(`public/${asset} is listed in ASSETS but does not exist`);
      continue;
    }
    cpSync(from, join(outDir, asset), { dereference: true });
  }

  const written = [];
  const emitted = new Map();
  for (const page of PAGES) {
    const source = readFileSync(join(PUBLIC, page.from), "utf8");
    const html = rewrite(source, page);
    emitted.set(page.to, html);
    writeFileSync(join(outDir, page.to), html);
    written.push(page.to);
  }

  // Every reference must resolve to a file that is really here. This is the
  // check that catches `/visualizer.css` on a project Pages site, and the one
  // that catches a new asset added to public/ without being added to ASSETS.
  for (const [page, html] of emitted) {
    if (/(?:href|src)="\//.test(html)) missing.push(`${page} still contains an absolute path`);
    for (const ref of refs(html)) {
      if (!isLocalRef(ref)) continue;
      // The one parent reference this build emits on purpose: the landing page
      // that links here. It is not built by this script, so it is checked
      // against site/ itself even when everything else goes to a temp dir.
      if (ref === LANDING) {
        if (!existsSync(join(ROOT, "site", "index.html"))) {
          missing.push(`${page} links to "${ref}", which is not in site/`);
        }
        continue;
      }
      // Anything else trying to leave the preview directory is a build error,
      // not a path to follow. A page is a file in this repository today, but a
      // reference that climbs directories is how a generator stops being one.
      if (ref.includes("..")) {
        missing.push(`${page} references "${ref}", which escapes the published preview`);
        continue;
      }
      if (!existsSync(resolve(outDir, ref))) {
        missing.push(`${page} references "${ref}", which is not in the published preview`);
      }
    }
  }

  for (const file of readdirSync(outDir, { recursive: true })) {
    const path = join(outDir, file.toString());
    if (!statSync(path).isFile() || !path.endsWith(".js")) continue;
    for (const spec of imports(readFileSync(path, "utf8"))) {
      // A relative sibling module and nothing else: no parent segments, no
      // absolute paths, no bare package names. This is a static copy, so an
      // import it cannot resolve is a 404 at runtime rather than a build error.
      if (!SIBLING_MODULE.test(spec)) {
        missing.push(`${relative(outDir, path)} imports "${spec}", which is not a sibling module`);
        continue;
      }
      if (!existsSync(resolve(dirname(path), spec))) {
        missing.push(`${relative(outDir, path)} imports "${spec}", which was not copied`);
      }
    }
  }

  return { missing, written };
}

/** Compare a fresh build against the committed one, byte for byte. */
function check() {
  const tmp = mkdtempSync(join(tmpdir(), "quasnooze-demo-"));
  const fresh = join(tmp, "demo");
  const { missing } = build(fresh);
  const drift = [];
  if (missing.length) return { missing, drift };
  const walk = (dir, base = "") => {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? join(base, entry.name) : entry.name;
      if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };
  const freshFiles = new Set(walk(fresh));
  const committedFiles = existsSync(OUT) ? new Set(walk(OUT)) : new Set();
  for (const file of freshFiles) {
    if (!committedFiles.has(file)) {
      drift.push(`site/demo/${file} is missing — run: npm run demo:site`);
      continue;
    }
    const a = readFileSync(join(fresh, file));
    const b = readFileSync(join(OUT, file));
    if (!a.equals(b)) drift.push(`site/demo/${file} is out of date — run: npm run demo:site`);
  }
  for (const file of committedFiles) {
    if (!freshFiles.has(file)) drift.push(`site/demo/${file} is not produced by the builder any more`);
  }
  rmSync(tmp, { recursive: true, force: true });
  return { missing, drift };
}

export { ASSETS, PAGES, NAV, build, check, rewrite };

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!invokedDirectly) {
  // Imported by a test, not run. Nothing to do.
} else if (process.argv.includes("--check")) {
  const { missing, drift } = check();
  for (const m of missing) console.error(`✖ ${m}`);
  for (const d of drift) console.error(`✖ ${d}`);
  if (missing.length || drift.length) process.exit(1);
  console.log(`✓ the published preview matches public/ (${readdirSync(OUT, { recursive: true }).length} entries)`);
} else {
  const { missing, written } = build(OUT);
  for (const m of missing) console.error(`✖ ${m}`);
  if (missing.length) process.exit(1);
  console.log(`✓ built ${written.length} preview pages into site/demo (${written.join(", ")})`);
}
