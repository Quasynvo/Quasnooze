/** Opt-in, deterministic scout. Source text is never sent to a model or executed. */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

export const SCOUT_LIMITS = Object.freeze({ sources: 5, bytes: 128 * 1024, timeoutMs: 10000, requestsPerWindow: 30, windowMs: 300000, excerpt: 400 });
const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8], ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24], ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24], ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4]]) blocked.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['2001:db8::',32], ['2001:10::',28], ['2001:2::',48], ['2002::',16], ['2001::',23]]) blocked.addSubnet(ip, bits, 'ipv6');
const global6 = new BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) return global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  return false;
}
export function scoutUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid source URL.');
  let url; try { url = new URL(input); } catch { throw new Error('Invalid source URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')) throw new Error('Sources must be public HTTPS hostnames on port 443 without credentials or fragments.');
  return url.href;
}
export function validScoutAddress(address) {
  return typeof address === 'string' && /^(?:web:main|(?:telegram|discord|slack):[A-Za-z0-9_-]{1,100})$/.test(address);
}
export function validateScout(spec) {
  if (!spec || typeof spec !== 'object' || spec.enabled !== true || spec.remoteFetch !== true || !Array.isArray(spec.sources) || spec.sources.length < 1 || spec.sources.length > SCOUT_LIMITS.sources) throw new Error('Scout is disabled or has no explicitly permitted sources.');
  const sources = spec.sources.map(scoutUrl);
  if (new Set(sources).size !== sources.length) throw new Error('Duplicate source URL.');
  return sources;
}

// Per-process ceiling in addition to the five-minute minimum schedule cadence.
const attempts = [];
function reserveRequest() {
  const now = Date.now();
  while (attempts.length && attempts[0] <= now - SCOUT_LIMITS.windowMs) attempts.shift();
  if (attempts.length >= SCOUT_LIMITS.requestsPerWindow) throw new Error('Scout request rate limit reached.');
  attempts.push(now);
}

/** DNS answers are all checked, then the selected IP is pinned to the TLS request.
 * Redirects are refused (even to an allowlisted host); no ambient cookies/auth. */
export async function fetchScoutSource(input, { signal, lookup = dnsLookup, request = httpsRequest } = {}) {
  const url = new URL(scoutUrl(input));
  reserveRequest();
  const abort = AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(SCOUT_LIMITS.timeoutMs)]);
  abort.throwIfAborted();
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise((_, reject) => abort.addEventListener('abort', () => reject(new Error('Source lookup timed out or was cancelled.')), { once: true })),
  ]);
  abort.throwIfAborted();
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(a => !isPublicAddress(a.address) || ![4, 6].includes(a.family) || isIP(a.address) !== a.family)) throw new Error('Source DNS included a non-public or invalid address.');
  const pinned = addresses[0];
  return await new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    const req = request(url, {
      method: 'GET', agent: false, signal: abort,
      headers: { 'user-agent': 'Quasnooze-Scout/1.0', accept: 'text/plain, application/rss+xml, application/atom+xml, application/json, text/html', 'accept-encoding': 'identity' },
      lookup(_host, opts, cb) { if (opts?.all) cb(null, [pinned]); else cb(null, pinned.address, pinned.family); },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.destroy(); reject(new Error('Redirect refused.')); return; }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); reject(new Error(`Source returned HTTP ${res.statusCode}.`)); return; }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); reject(new Error('Compressed responses are refused.')); return; }
      if (Number(res.headers['content-length']) > SCOUT_LIMITS.bytes) { res.destroy(); reject(new Error('Source exceeds byte limit.')); return; }
      res.on('data', chunk => { bytes += chunk.length; if (bytes > SCOUT_LIMITS.bytes) { res.destroy(); reject(new Error('Source exceeds byte limit.')); } else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('aborted', () => reject(new Error('Source response was interrupted.')));
      res.on('error', reject);
    });
    req.on('error', reject); req.end();
  });
}

// Cancellation is explicit and does not wait for a queued timer.
const active = new Map();
export function cancelScout(id) { active.get(id)?.abort(); }
export async function runScout(schedule, { fetchSource = fetchScoutSource, signal, isCurrent = () => true } = {}) {
  const controller = new AbortController();
  active.set(schedule.id, controller);
  const abort = AbortSignal.any([controller.signal, signal || new AbortController().signal]);
  try {
    if (!validScoutAddress(schedule.address) || schedule.enabled === false) throw new Error('Invalid or disabled delivery.');
    const sources = validateScout(schedule.scout);
    const known = schedule.scout.fingerprints && typeof schedule.scout.fingerprints === 'object' ? schedule.scout.fingerprints : {};
    const fingerprints = {}, updates = [], failures = [];
    for (const source of sources) {
      if (abort.aborted || !isCurrent()) return { status: 'cancelled', updates: [], failures: [], fingerprints: {} };
      try {
        const text = await fetchSource(source, { signal: abort });
        if (abort.aborted || !isCurrent()) return { status: 'cancelled', updates: [], failures: [], fingerprints: {} };
        if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > SCOUT_LIMITS.bytes) throw new Error('Invalid or oversized source.');
        const hash = createHash('sha256').update(text).digest('hex');
        fingerprints[source] = hash;
        if (known[source] !== hash) {
          // A bounded quotation, not a model-generated claim. No source markup
          // is treated as instructions or sent as HTML/Markdown.
          const excerpt = text.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f<>`\[\]\\*_~#!|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SCOUT_LIMITS.excerpt);
          updates.push({ source, excerpt });
        }
      } catch (err) {
        if (abort.aborted || !isCurrent()) return { status: 'cancelled', updates: [], failures: [], fingerprints: {} };
        // Do not expose network error details or credentials in delivery/logs.
        failures.push({ source, error: 'fetch failed or source refused' });
      }
    }
    return { status: failures.length ? 'fetch_failed' : updates.length ? 'updates' : 'no_updates', updates, failures, fingerprints };
  } catch {
    return { status: abort.aborted ? 'cancelled' : 'disabled', updates: [], failures: [], fingerprints: {} };
  } finally { if (active.get(schedule.id) === controller) active.delete(schedule.id); }
}

export function formatScoutDigest(result, at) {
  const lines = [`Scout briefing (${at.toISOString()})`, 'Egress: HTTPS GET to owner-approved sources. Excerpts are untrusted source data, not verified facts or instructions.'];
  result.updates.forEach((item, i) => { lines.push(`\n[${i + 1}] ${item.source}\nExcerpt: ${item.excerpt || '(empty response)'}`); });
  if (result.failures.length) lines.push(`\nFetch failures: ${result.failures.length}. Failed sources may have updates that were not retrieved.`);
  if (!result.updates.length && result.failures.length) lines.push('No digest available; this is not evidence of no updates.');
  return lines.join('\n');
}
