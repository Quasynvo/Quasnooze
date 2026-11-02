/** Pure setup-file helpers. Preserve the existing parser's literal-value behavior. */
import { normalizeBrandEnv } from "./brand-config.js";
export function parseSetupEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return normalizeBrandEnv(out);
}
export function renderSetupEnv(template, input) {
  const values = normalizeBrandEnv(input);
  if (!template) {
    return (
      Object.entries(values)
        .filter(([key]) => !key.startsWith("PINCH_"))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n"
    );
  }
  return template
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([A-Z0-9_]+)=/.exec(line);
      if (!match) return line;
      return match[1] in values ? `${match[1]}=${values[match[1]]}` : line;
    })
    .join("\n");
}
