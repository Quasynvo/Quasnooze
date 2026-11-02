/** Brand aliases at each configuration layer; process env still wins over .env. */
export function normalizeBrandEnv(input) {
  const out = { ...input };
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith("PINCH_")) {
      const canonical = "QUASNOOZE_" + key.slice(6);
      if (!(canonical in input)) out[canonical] = value;
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith("QUASNOOZE_")) out["PINCH_" + key.slice(10)] = value;
  }
  return out;
}
