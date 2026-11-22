/** Validate the JSON Schema subset used by tool parameters, without changing input. */
export function validateSchema(schema, value) {
  const errors = [];
  const add = (message) => { if (errors.length < 12) errors.push(message); };
  function visit(rule, item, path, depth) {
    if (depth > 64) { add(`${path} exceeds the maximum validation depth`); return; }
    if (!rule || typeof rule !== "object" || errors.length >= 12) return;
    const type = rule.type;
    const actual = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
    const valid = type === undefined || (type === "object" ? actual === "object" :
      type === "array" ? actual === "array" : type === "integer" ? typeof item === "number" && Number.isInteger(item) :
      type === "number" ? typeof item === "number" && Number.isFinite(item) :
      type === "null" ? item === null : actual === type);
    if (!valid) { add(`${path} must be ${type}, not ${actual}`); return; }
    if (Array.isArray(rule.enum) && !rule.enum.some((v) => Object.is(v, item))) {
      add(`${path} must be one of ${rule.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    }
    if (actual === "object") {
      const properties = rule.properties || {};
      const missing = (rule.required || []).filter((key) => !Object.hasOwn(item, key) || item[key] === undefined);
      if (missing.length) add(`Missing required argument${missing.length === 1 ? "" : "s"}: ${missing.map((k) => path === "$" ? k : `${path}.${k}`).join(", ")}`);
      const allowed = Object.keys(properties);
      // Preserve the existing top-level unknown-argument contract. Nested
      // objects follow JSON Schema's default (additional properties allowed).
      if ((path === "$" && allowed.length) || rule.additionalProperties === false) {
        const unknown = Object.keys(item).filter((key) => !Object.hasOwn(properties, key));
        if (unknown.length) add(`Unknown argument${unknown.length === 1 ? "" : "s"} at ${path}: ${unknown.join(", ")}. Allowed: ${allowed.join(", ")}`);
      }
      for (const key of allowed) if (Object.hasOwn(item, key)) visit(properties[key], item[key], `${path}.${key}`, depth + 1);
    } else if (actual === "array" && rule.items) {
      for (let i = 0; i < item.length && errors.length < 12; i++) visit(rule.items, item[i], `${path}[${i}]`, depth + 1);
    }
  }
  visit(schema, value, "$", 0);
  return errors;
}
