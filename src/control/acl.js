/**
 * acl.js — retrieval that honours who asked.
 *
 * documents.js already searches. This filter is applied *after* ranking so a
 * vector neighbour from another channel never becomes a citation. Fail closed:
 * a hit without acl is visible only to the same tenant.
 */
import { mayRead, subject } from "./identity.js";

export function filterHits(hits, who) {
  const viewer = who?.id ? who : subject(who || {});
  if (!Array.isArray(hits)) return [];
  return hits.filter((hit) => mayRead(viewer, hit));
}

export function redactHit(hit) {
  if (!hit || typeof hit !== "object") return hit;
  const { acl, ...rest } = hit;
  return rest;
}
