/**
 * schema.js — structured output the model cannot shrug off.
 *
 * Tool arguments already use JSON Schema in tools.js. This module is the
 * same idea for *replies* the rest of the system must parse: HITL decisions,
 * A2A envelopes, gateway routes. A model that returns prose where a schema
 * was required is a refusal, not a best-effort parse.
 *
 * Subset only: type, properties, required, enum, additionalProperties,
 * minLength/maxLength, minimum/maximum, items. Enough to be useful, small
 * enough to audit.
 */
export class SchemaError extends Error {
  constructor(message, path = "") {
    super(message);
    this.name = "SchemaError";
    this.path = path;
  }
}

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function validate(schema, value, path = "$") {
  if (!schema || typeof schema !== "object") throw new SchemaError("schema missing", path);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes(typeOf(value))) {
      throw new SchemaError(`expected ${types.join("|")}, got ${typeOf(value)}`, path);
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new SchemaError(`value not in enum`, path);
  }
  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) throw new SchemaError("too short", path);
    if (schema.maxLength != null && value.length > schema.maxLength) throw new SchemaError("too long", path);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum != null && value < schema.minimum) throw new SchemaError("below minimum", path);
    if (schema.maximum != null && value > schema.maximum) throw new SchemaError("above maximum", path);
  }
  if (typeOf(value) === "array" && schema.items) {
    if (schema.maxItems != null && value.length > schema.maxItems) throw new SchemaError("too many items", path);
    value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`));
  }
  if (typeOf(value) === "object" && schema.properties) {
    const extra = schema.additionalProperties === false;
    for (const key of Object.keys(value)) {
      if (!schema.properties[key] && extra) throw new SchemaError(`unknown property ${key}`, path);
    }
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) throw new SchemaError(`missing ${key}`, path);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) validate(sub, value[key], `${path}.${key}`);
    }
  }
  return value;
}

export function parseJson(text, schema) {
  const raw = String(text ?? "").trim();
  const start = raw.indexOf("{") >= 0 && (raw.indexOf("[") < 0 || raw.indexOf("{") < raw.indexOf("["))
    ? raw.indexOf("{")
    : raw.indexOf("[");
  if (start < 0) throw new SchemaError("no JSON value");
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start));
  } catch (err) {
    throw new SchemaError(`invalid JSON: ${err.message}`);
  }
  return schema ? validate(schema, parsed) : parsed;
}
