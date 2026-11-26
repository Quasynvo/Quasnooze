/**
 * auth.js — "may this person drive my assistant?", answered the same way by
 * every chat channel.
 *
 * ONE SENTENCE: AN EMPTY ALLOWLIST AUTHORISES NOBODY.
 *
 * This file exists because that sentence was implemented three different ways
 * and two of them were backwards. Telegram read
 *
 *     approved.size === 0 || approved.has(id)      // nobody configured => everybody
 *     allowed.size && !allowed.has(channel)        // Discord: same inversion
 *
 * so the shipped default — a token in `.env` with the allowlist left blank, as
 * `.env.example` hands it to you — made the bot answer strangers. A stranger
 * here is not a chat partner: Telegram usernames are public, anyone can invite a
 * Discord bot (bots are public by default), and the tool list behind the message
 * includes `shell`, `write_file` and clipboard access. `docs/CHANNELS.md` and
 * `.env.example` both already promised the opposite ("refuse everyone and echo
 * their id back"), which is how the bug was found: the documentation was right
 * and the code disagreed with it.
 *
 * The inversion is easy to retype, so the predicate lives here once and every
 * channel imports it. `test/channel-auth.test.js` asserts both halves: that an
 * empty list denies everything, and that no channel file reintroduces the
 * `size &&` / `size === 0 ||` shape.
 */

/** Digits only — the form WhatsApp gives you in a jid and in a typed number. */
export function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

const asText = (value) => String(value ?? "").trim();

/**
 * @param {string[]} configured the ids/channels/numbers from `.env`
 * @param {object} [opts]
 * @param {(value: unknown) => string} [opts.normalize] how to canonicalise both
 *   sides of the comparison (WhatsApp: digits only)
 * @returns {{
 *   size: number,
 *   configured: boolean,
 *   has: (id: unknown) => boolean,
 * }} a read-only view; there is no `add()`, because nothing at runtime may grow
 *   its own authority
 */
export function createAllowList(configured = [], { normalize = asText } = {}) {
  const entries = Array.isArray(configured) ? configured : [configured];
  // A blank entry is not an id. Dropping them means a trailing comma in `.env`
  // cannot become "allow the empty id", which is a shape some messages carry.
  // Non-scalars are dropped rather than String()-ed: `String(false)` is "false",
  // and an id spelled "false" is a strange thing to grant.
  const approved = new Set(
    entries
      .filter((entry) => typeof entry === "string" || typeof entry === "number")
      .map(normalize)
      .filter(Boolean)
  );

  return {
    size: approved.size,
    /** Was this channel configured at all? False means it answers nobody. */
    configured: approved.size > 0,
    has(id) {
      if (!approved.size) return false;
      const key = normalize(id);
      return Boolean(key) && approved.has(key);
    },
  };
}
