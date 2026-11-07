/**
 * recall.js — put only the memories that overlap this utterance in the prompt.
 *
 * The agent path injects the last 40 facts every turn. On a long-running
 * personal assistant that is a growing prefill and a growing chance the model
 * recites an unrelated grocery list. Overlap scoring is crude (token
 * intersection, stopwords dropped) on purpose: it is milliseconds, it does not
 * call a model, and a zero-overlap query still gets the most recent facts so
 * "what did I tell you?" does not go blank.
 */
const STOP = new Set("the a an and or to of in on for with from that this is are was were be been it you i me my we our".split(" "));

export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function relevantFacts(query, facts, { limit = 8, recentFallback = 6 } = {}) {
  const list = Array.isArray(facts) ? facts.filter((f) => f && typeof f.text === "string") : [];
  if (!list.length) return [];
  const q = new Set(tokens(query));
  const scored = list.map((f, i) => {
    const words = tokens(f.text);
    let n = 0;
    for (const w of words) if (q.has(w)) n += 1;
    return { f, n, i };
  });
  scored.sort((a, b) => b.n - a.n || b.i - a.i);
  const hits = scored.filter((s) => s.n > 0).slice(0, limit).map((s) => s.f);
  if (hits.length) return hits;
  return list.slice(-recentFallback);
}
