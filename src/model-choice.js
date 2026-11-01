/** Resolve onboarding menu numbers to actual model names, never the string "1". */
export function resolveModelChoice(input, models, fallback) {
  const value = String(input || "").trim() || fallback || models[0] || "qwen2.5-coder:7b";
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (!Number.isSafeInteger(index) || !models[index]) throw new Error("Choose an installed model number from the list, or enter a model name.");
    return models[index];
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(value)) throw new Error("Use a model name, not spaces, quotes or shell syntax.");
  return value;
}
