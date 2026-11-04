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
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    // Copy, then classify the failure. Asking `existsSync` first and copying
    // second is a check-then-use: the answer can change between the two calls,
    // and the copy already reports ENOENT for a source that is not there. One
    // operation, one failure mode, nothing to race.
    try {
      cpSync(join(PUBLIC, asset), join(outDir, asset), { dereference: true });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      missing.push(`public/${asset} is listed in ASSETS but does not exist`);
    }
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

  // Membership in this set is the whole test for "will this 404?": a reference
  // either names a file that is here or it does not. Resolving it into a path
  // and then asking the filesystem asked the same question, in a way that made
  // the build script a file-existence oracle for whatever HTML it was given.
  const publishedFiles = new Set(readdirSync(outDir, { recursive: true }).map(String));

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
        // Read it rather than stat it: "is it there" is the question, "can it
        // be served" is the answer, and reading asks it once.
        try {
          readFileSync(join(ROOT, "site", "index.html"));
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
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
      if (!publishedFiles.has(ref.replace(/^\.\//, ""))) {
        missing.push(`${page} references "${ref}", which is not in the published preview`);
      }
    }
  }

  // The import graph is read from the sources named in ASSETS, not from the
  // output directory. Same files, no filesystem walk feeding a read: a build
  // script that turns whatever it finds into a path is a file-existence oracle
  // with extra steps, and "the files it finds" is not a set this script can
  // vouch for the way it can vouch for a literal array.
  for (const asset of ASSETS.filter((a) => a.endsWith(".js"))) {
    if (!publishedFiles.has(asset)) {
      missing.push(`public/${asset} was not published`);
      continue;
    }
    for (const spec of imports(readFileSync(join(PUBLIC, asset), "utf8"))) {
      // A relative sibling module and nothing else: no parent segments, no
      // absolute paths, no bare package names. In a static copy an import that
      // cannot be resolved is a 404 at runtime, not a build failure to skip.
      if (!SIBLING_MODULE.test(spec)) {
        missing.push(`${asset} imports "${spec}", which is not a sibling module`);
        continue;
      }
      if (!publishedFiles.has(spec.slice(2))) {
        missing.push(`${asset} imports "${spec}", which was not copied`);
      }
    }
  }

  return { missing, written };
}

/** Every file under `dir`, read once, keyed by its path relative to `dir`.
 *  Returning the bytes alongside the name means the comparison in `check`
 *  never turns a name it found on disk back into a path to open: a directory
 *  listing is read, not trusted as a description of what will be there next.
 *  A missing directory is an empty snapshot — that is the state before the
 *  first build, not an error. */
function snapshot(dir) {
  const files = new Map();
  const visit = (current, base) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return;
    }
    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(join(current, entry.name), rel);
      else files.set(rel, readFileSync(join(current, entry.name)));
    }
  };
  visit(dir, "");
  return files;
}

/** Compare a fresh build against the committed one, byte for byte. */
function check() {
  const tmp = mkdtempSync(join(tmpdir(), "quasnooze-demo-"));
  const fresh = join(tmp, "demo");
  const { missing } = build(fresh);
  const drift = [];
  if (missing.length) return { missing, drift };
  // The expected contents are known: the copied assets plus the emitted pages.
  // Comparing that list (rather than whatever is on disk) keeps the check
  // deterministic, and means a stale file left behind is reported instead of
  // being read.
  const expected = [...ASSETS, ...PAGES.map((p) => p.to)];
  const built = snapshot(fresh);
  const committedFiles = snapshot(OUT);
  for (const file of expected) {
    if (!committedFiles.has(file)) {
      drift.push(`site/demo/${file} is missing — run: npm run demo:site`);
      continue;
    }
    if (!built.get(file).equals(committedFiles.get(file))) {
      drift.push(`site/demo/${file} is out of date — run: npm run demo:site`);
    }
  }
  for (const file of committedFiles.keys()) {
    if (!expected.includes(file)) drift.push(`site/demo/${file} is not produced by the builder any more`);
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
