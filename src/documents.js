/** Bounded, in-memory, incremental lexical passage index. No network or disk cache. */
import { readdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { join, extname, relative, isAbsolute } from "node:path";
import { extract } from "./attachments.js";
import { SKIP_DIRS } from "./scan.js";

const TYPES = new Set([".txt", ".md", ".markdown", ".rst", ".csv", ".pdf", ".docx"]);
export const DOCUMENT_LIMITS = Object.freeze({
  entries: 2000, bytes: 12 * 1024 * 1024, fileBytes: 2 * 1024 * 1024,
  depth: 8, lines: 24, passageChars: 4000, fileChars: 256 * 1024,
  totalChars: 4 * 1024 * 1024, cacheWeight: 16 * 1024 * 1024,
});
const terms = (text) => text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || [];

// LRU is only an optimization, never an authority. Every search re-walks the
// folder, re-applies the caller's policy and opens/fstats each candidate.
const cache = new Map();
let cacheWeight = 0;
function forget(path) {
  const previous = cache.get(path);
  if (previous) { cacheWeight -= previous.weight; cache.delete(path); }
}
function remember(path, entry) {
  forget(path);
  if (entry.weight > DOCUMENT_LIMITS.cacheWeight) return;
  while (cacheWeight + entry.weight > DOCUMENT_LIMITS.cacheWeight || cache.size >= DOCUMENT_LIMITS.entries) {
    forget(cache.keys().next().value);
  }
  cache.set(path, entry);
  cacheWeight += entry.weight;
}
function signature(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

// Split long lines as well as groups of lines; unlike clipping a 24-line group,
// this never silently loses the rest of a long line. Line numbers on PDF/DOCX
// refer to extracted text, not physical page or Word line numbers.
function makeChunks(path, text, extracted) {
  const chunks = [];
  let parts = [], length = 0, start = 1, end = 1;
  function flush() {
    if (!parts.length) return;
    const body = parts.join("\n");
    const counts = new Map();
    for (const word of terms(body)) counts.set(word, (counts.get(word) || 0) + 1);
    chunks.push({ path, start, end, text: body, counts, length: [...counts.values()].reduce((a, b) => a + b, 0), extracted });
    parts = []; length = 0;
  }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    do {
      if (parts.length && (i + 1 - start >= DOCUMENT_LIMITS.lines || length + 1 >= DOCUMENT_LIMITS.passageChars)) flush();
      if (!parts.length) start = i + 1;
      const room = DOCUMENT_LIMITS.passageChars - length - (parts.length ? 1 : 0);
      let cut = room;
      if (line.length > room) {
        const boundary = Math.max(line.lastIndexOf(" ", room - 1), line.lastIndexOf("\t", room - 1), line.lastIndexOf("\r", room - 1));
        if (boundary >= 0) cut = boundary + 1;
        else if (parts.length) { flush(); continue; }
        // A single word longer than a passage has no safe boundary.
      }
      const piece = line.slice(0, cut);
      line = line.slice(cut);
      parts.push(piece); length += piece.length + (parts.length > 1 ? 1 : 0); end = i + 1;
      if (line.length) flush();
    } while (line.length);
  }
  flush();
  return chunks;
}

/**
 * Symlinks found during traversal are never followed; the caller checks each
 * path against workspace and credential rules. O_NOFOLLOW protects the final
 * component where supported. Like the other file tools this is not an OS
 * sandbox against concurrent replacement of parent directories.
 */
export async function searchDocuments({ path, query, resolvePath, limit = 5 }) {
  if (typeof query !== "string" || query.length > 1000 || !terms(query).length) {
    throw new Error("Provide a query containing words (maximum 1,000 characters).");
  }
  const root = resolvePath(path);
  const chunks = [];
  const seen = new Set();
  let entries = 0, bytes = 0, chars = 0, files = 0, skipped = 0, truncated = false, reused = 0, indexed = 0;
  async function walk(dir, depth) {
    resolvePath(dir);
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of children) {
      if (++entries > DOCUMENT_LIMITS.entries || bytes >= DOCUMENT_LIMITS.bytes || chars >= DOCUMENT_LIMITS.totalChars) { truncated = true; return; }
      if (item.name.startsWith(".") || SKIP_DIRS.has(item.name)) continue;
      const full = join(dir, item.name);
      if (item.isSymbolicLink()) { forget(full); skipped++; continue; }
      if (item.isDirectory()) {
        if (depth >= DOCUMENT_LIMITS.depth) { truncated = true; continue; }
        try { await walk(full, depth + 1); } catch { skipped++; truncated = true; }
        continue;
      }
      if (!item.isFile() || !TYPES.has(extname(item.name).toLowerCase())) continue;
      let handle;
      try {
        resolvePath(full);
        handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const stat = await handle.stat({ bigint: true });
        if (!stat.isFile() || stat.size > BigInt(DOCUMENT_LIMITS.fileBytes) || stat.size > BigInt(DOCUMENT_LIMITS.bytes - bytes)) {
          forget(full); skipped++; truncated = true; continue;
        }
        bytes += Number(stat.size);
        const sig = signature(stat);
        // Some filesystems give two different writes identical timestamps and
        // sizes. Hash the bounded bytes too; metadata alone can return stale
        // evidence. Reuse still avoids extraction, chunking and tokenization.
        const buffer = Buffer.alloc(Number(stat.size) + 1);
        let n = 0;
        while (n < buffer.length) {
          const { bytesRead } = await handle.read(buffer, n, buffer.length - n, n);
          if (!bytesRead) break;
          n += bytesRead;
        }
        if (signature(await handle.stat({ bigint: true })) !== sig || n !== Number(stat.size)) {
          forget(full); skipped++; truncated = true; continue;
        }
        const data = buffer.subarray(0, n);
        const digest = createHash("sha256").update(data).digest("hex");
        let entry = cache.get(full);
        if (entry?.signature === sig && entry.digest === digest) {
          // Refresh LRU only after the policy and the opened file are verified.
          remember(full, entry); reused++;
        } else {
          forget(full);
          const extension = extname(full).toLowerCase();
          const extracted = extension === ".pdf" || extension === ".docx";
          let text, partial = false;
          if (extracted) {
            const result = extract(data, item.name);
            if (result.kind !== extension.slice(1) || !result.text) { skipped++; truncated = true; continue; }
            text = result.text;
            partial = Boolean(result.truncated || result.note);
          } else {
            if (data.includes(0)) { skipped++; continue; }
            text = data.toString("utf8");
          }
          if (text.length > DOCUMENT_LIMITS.fileChars) { text = text.slice(0, DOCUMENT_LIMITS.fileChars); partial = true; }
          const fileChunks = makeChunks(full, text, extracted);
          // Approximate the cost of strings and per-term Map entries, not just input bytes.
          const weight = text.length * 4 + fileChunks.reduce((n, c) => n + c.counts.size * 80 + 256, 0);
          entry = { signature: sig, digest, chunks: fileChunks, chars: text.length, weight, partial };
          remember(full, entry); indexed++;
        }
        seen.add(full);
        if (entry.chars > DOCUMENT_LIMITS.totalChars - chars) { skipped++; truncated = true; continue; }
        chars += entry.chars; files++; truncated ||= entry.partial;
        chunks.push(...entry.chunks);
      } catch { forget(full); skipped++; truncated = true; }
      finally { await handle?.close(); }
    }
  }
  await walk(root, 0);
  // Remove entries no longer visible under this root, including deleted files.
  for (const key of cache.keys()) {
    const rel = relative(root, key);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && !seen.has(key)) forget(key);
  }
  const words = [...new Set(terms(query))];
  const frequencies = new Map(words.map((w) => [w, chunks.reduce((n, c) => n + Number(c.counts.has(w)), 0)]));
  const averageLength = chunks.reduce((sum, c) => sum + c.length, 0) / (chunks.length || 1);
  const k1 = 1.2, b = 0.75;
  const hits = chunks.map((c) => ({ ...c, score: words.reduce((score, w) => {
    const tf = c.counts.get(w) || 0, df = frequencies.get(w);
    if (!tf) return score;
    const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
    return score + idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * c.length / (averageLength || 1)));
  }, 0) }))
    // Coverage gate: a passage that matches only a minority of the query's
    // terms is vocabulary overlap, not evidence. Returning it teaches the
    // agent to answer questions the corpus cannot answer ("travel
    // teleportation allowance" used to return the travel and meals
    // policies). Half the terms is the floor that keeps every labelled
    // relevant passage in the evaluation corpus while refusing that case;
    // single-term queries are unaffected (coverage is 0 or 1).
    .filter((c) => c.score > 0 && words.filter((w) => c.counts.has(w)).length * 2 >= words.length)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.start - b.start)
    .slice(0, Math.max(1, Math.min(8, Math.floor(Number(limit) || 5))))
    .map(({ counts, length, ...hit }) => hit);
  return { hits, files, chunks: chunks.length, skipped, truncated, reused, indexed };
}
