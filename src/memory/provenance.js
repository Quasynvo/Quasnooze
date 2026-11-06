/** Local, owner-selected memory scopes. A scope is never taken from model output. */
import { createHash, randomUUID } from 'node:crypto';

export const MEMORY_VERSION = 2;
export function memoryScope(value = 'user') {
  if (typeof value !== 'string' || !/^(?:user|project:[a-z0-9][a-z0-9_-]{0,63})$/.test(value)) {
    throw new Error('Memory scope must be user or project:<lowercase-name>.');
  }
  return value;
}
export function legacyId(fact, index) {
  return 'legacy-' + createHash('sha256').update(JSON.stringify([index, fact])).digest('hex');
}
export function migrateMemory(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.facts)) throw new Error('memory.json is malformed; restore or repair it before editing.');
  if (value.version !== undefined && value.version !== 1 && value.version !== MEMORY_VERSION) throw new Error('Unsupported memory version; no changes made.');
  if (value.version === MEMORY_VERSION) return structuredClone(value);
  return { ...value, version: MEMORY_VERSION, facts: value.facts.map((fact, i) => {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact) || typeof fact.text !== 'string') return fact;
    // Legacy fields with version-2 meanings cannot select a scope or hide a
    // record. Preserve the complete original if any reserved fields collide.
    const reserved = ['id', 'scope', 'supersededBy'].some(key => Object.hasOwn(fact, key));
    const migrated = { ...fact, id: legacyId(fact, i), scope: 'user', ...(reserved ? { legacyOriginal: fact } : {}) };
    delete migrated.supersededBy;
    return migrated;
  }) };
}
export function validFact(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f) || typeof f.text !== 'string' || !f.text.trim() || typeof f.id !== 'string' || !f.id) return false;
  try { memoryScope(f.scope); } catch { return false; }
  return f.supersededBy === undefined || (typeof f.supersededBy === 'string' && f.supersededBy.length > 0);
}
export function createFact(text, tag, scope, source) {
  const clean = typeof text === 'string' ? text.trim().slice(0, 500) : '';
  if (!clean) throw new Error('A non-empty memory fact is required.');
  if (source !== undefined && (typeof source !== 'string' || !source.trim() || source.length > 200)) throw new Error('Source must be a non-empty string of at most 200 characters.');
  return { id: randomUUID(), text: clean, tag: typeof tag === 'string' && tag ? tag.slice(0, 100) : 'general', scope: memoryScope(scope), at: new Date().toISOString(), ...(source === undefined ? {} : { source: source.trim() }) };
}
