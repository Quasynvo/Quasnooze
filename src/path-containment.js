/**
 * path-containment.js — "is this path inside that one?", asked the same way
 * everywhere.
 *
 * The answer is trivial on one platform and quietly wrong on the other.
 * Comparing strings with `startsWith(root + "/")` is correct on POSIX and fails
 * on Windows, where the separator is `\` and NTFS compares case-insensitively.
 * Three copies of that comparison lived in the codebase, and on a Windows
 * machine every one of them answered "no":
 *
 *   - `risk.js` — the read-only screen. `cat README.md` inside the workspace
 *     was classified as a write-class action, because the workspace root and
 *     the file path never "matched". Over-strict rather than unsafe, but it
 *     made the read tier unreachable on the platform the desktop companion
 *     targets. Reproduced on Windows with this repo's own tests: `cat README.md`
 *     classifies as `act`, not `read`.
 *   - `tools.js` `isProtected` — the credential blocklist (~/.ssh, ~/.aws,
 *     ~/.gnupg, .git-credentials, …). Failing closed here is not over-strict, it
 *     is *silently inert*: with the default workspace of $HOME, a Windows user's
 *     SSH private key was not recognised as protected at all.
 *   - `tools.js` `describeEscapes` — the "this command reaches outside the
 *     workspace" warning, which on Windows never even considered `C:\…` paths
 *     because it only looked at arguments starting with `/`.
 *
 * One predicate, tested from any platform, because the machine running the
 * tests is not always the machine with the bug.
 */
import { sep } from "node:path";

const WINDOWS = sep === "\\";

/**
 * Reduce a path to the form we compare: one separator, no doubled separators,
 * no trailing separator (except a bare root), and lower-cased on a filesystem
 * that does not distinguish case.
 *
 * Deliberately lexical. Callers resolve `.`/`..` and symlinks before asking
 * (risk.js resolves against the cwd, tools.js canonicalises); this function
 * answers a question about two strings that are already absolute.
 */
function normalise(value, caseInsensitive) {
  let s = String(value ?? "");
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  s = s.replace(/\/{2,}/g, "/");
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return caseInsensitive ? s.toLowerCase() : s;
}

/**
 * Is `candidate` the same as `root`, or beneath it?
 *
 * Separator- and case-agnostic, with a boundary check so `/work2` is not inside
 * `/work`. `caseInsensitive` defaults to whether this platform has Windows path
 * semantics; pass it explicitly to test one platform's rules from another.
 */
export function isWithin(root, candidate, { caseInsensitive = WINDOWS } = {}) {
  const r = normalise(root, caseInsensitive);
  const c = normalise(candidate, caseInsensitive);
  if (!r || !c) return false;
  if (c === r) return true;
  return c.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/**
 * Does this argument claim to be an absolute path, on either platform?
 *
 * `path.isAbsolute` answers for the platform it runs on, which is no use to a
 * Windows path inspection happening on Linux (or to a test). POSIX `/x`, Windows
 * drive `C:\x` and UNC `\\server\share` all qualify.
 */
export function looksAbsolute(value) {
  const s = String(value ?? "");
  if (!s) return false;
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s);
}
