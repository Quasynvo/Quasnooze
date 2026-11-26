/**
 * Regression tests for path containment on both platforms.
 *
 * Every assertion here failed — or could not even be expressed — before
 * `src/path-containment.js` existed. The bug was platform-shaped: the code
 * compared `startsWith(root + "/")`, which is the POSIX spelling of "inside",
 * so on Windows three separate containment checks answered "no":
 *
 *   - risk.js   → `cat README.md` in the workspace classified as `act`, not `read`
 *   - tools.js  → `~/.ssh/id_rsa` was not in the protected list at all
 *   - tools.js  → `describeEscapes` never looked at `C:\…` or `\\server\…`
 *
 * The machine running these tests is usually Linux, so each platform's rules are
 * exercised explicitly through the `caseInsensitive` option rather than by hoping
 * CI has a Windows runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

import { isWithin, looksAbsolute } from "../src/path-containment.js";

const WIN = { caseInsensitive: true };
const POSIX = { caseInsensitive: false };

test("POSIX containment: identity, descendants, and the sibling that shares a prefix", () => {
  assert.equal(isWithin("/work", "/work", POSIX), true);
  assert.equal(isWithin("/work", "/work/a.txt", POSIX), true);
  assert.equal(isWithin("/work", "/work/deep/er/a.txt", POSIX), true);
  assert.equal(isWithin("/work/", "/work/a.txt", POSIX), true, "a trailing slash is the same root");
  assert.equal(isWithin("/work", "/work2/a.txt", POSIX), false, "/work2 is not inside /work");
  assert.equal(isWithin("/work", "/workspace/a.txt", POSIX), false);
  assert.equal(isWithin("/work", "/", POSIX), false, "the parent is not a child");
  assert.equal(isWithin("/", "/etc/passwd", POSIX), true, "a root of / contains everything");
});

test("Windows containment: backslashes, mixed separators, drive roots", () => {
  assert.equal(isWithin("C:\\work", "C:\\work\\a.txt", WIN), true);
  assert.equal(isWithin("C:/work", "C:\\work\\a.txt", WIN), true, "either separator may be typed");
  assert.equal(isWithin("C:\\work", "C:/work/sub/a.txt", WIN), true);
  assert.equal(isWithin("C:\\work", "C:\\work2\\a.txt", WIN), false, "sibling, not child");
  assert.equal(isWithin("C:\\", "C:\\Users\\ranji\\a.txt", WIN), true, "drive root contains the drive");
  assert.equal(isWithin("C:\\work", "D:\\work\\a.txt", WIN), false, "another drive is elsewhere");
  assert.equal(isWithin("\\\\server\\share", "\\\\server\\share\\a.txt", WIN), true, "UNC shares contain their files");
  assert.equal(isWithin("\\\\server\\share", "\\\\other\\share\\a.txt", WIN), false);
});

test("Windows containment is case-insensitive, because NTFS is", () => {
  assert.equal(isWithin("C:\\Work", "c:\\work\\Sub\\File.txt", WIN), true);
  assert.equal(isWithin("c:\\work", "C:\\WORK\\a.txt", WIN), true);
  // The same two strings on a case-sensitive filesystem really are different
  // paths, so the option has to be what decides — not the platform the test runs on.
  assert.equal(isWithin("C:\\Work", "C:\\work\\a.txt", POSIX), false);
});

test("separator folding is platform-independent; only case folding is not", () => {
  // A Windows-shaped path asked with POSIX case rules still normalises its
  // separators. Getting this wrong is what made the fix look Windows-only.
  assert.equal(isWithin("C:\\work", "C:\\work\\a.txt", POSIX), true);
  // The difference has to be in the root, not the leaf: the leaf is inside
  // either way. Here the root itself differs by case, which is only "inside"
  // where the filesystem says those are the same directory.
  assert.equal(isWithin("C:\\Work", "C:\\work\\a.txt", POSIX), false);
});

test("degenerate inputs contain nothing", () => {
  assert.equal(isWithin("", "/work/a", POSIX), false);
  assert.equal(isWithin("/work", "", POSIX), false);
  assert.equal(isWithin(null, undefined, POSIX), false);
});

test("looksAbsolute knows both platforms, from any platform", () => {
  assert.equal(looksAbsolute("/etc/passwd"), true);
  assert.equal(looksAbsolute("C:\\Users\\ranji\\.ssh\\id_rsa"), true);
  assert.equal(looksAbsolute("c:/users/ranji/x"), true);
  assert.equal(looksAbsolute("\\\\server\\share\\x.txt"), true, "UNC");
  assert.equal(looksAbsolute("src/index.js"), false);
  assert.equal(looksAbsolute("./x"), false);
  assert.equal(looksAbsolute("C:"), false, "a bare drive letter is a drive-relative path, not absolute");
  assert.equal(looksAbsolute(""), false);
});

test("the credential blocklist matches with Windows separators too", async () => {
  const { isProtected } = await import("../src/tools.js");
  const ssh = join(homedir(), ".ssh", "id_rsa");
  assert.equal(isProtected(ssh), true, "an SSH key is protected on whatever platform builds this path…");
  // …and the same path written the other way round, which is how a Windows
  // homedir arrives in a string that also came from a config file.
  assert.equal(isProtected(ssh.replace(/\//g, "\\")), true, "separator must not decide protection");
  assert.equal(isProtected(join(homedir(), ".sshfoo", "x")), false, "a lookalike directory is not the key store");
});
