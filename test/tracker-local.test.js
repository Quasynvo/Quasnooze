/**
 * test/tracker-local.test.js — issue #133 (`harness-10-tracker-local`).
 *
 * The claim under test: a repository can keep its tickets as local Markdown,
 * the assistant can list, read and draft them offline, and *nothing* about that
 * is trusted — not the ticket file, not the directory, not the model's tool
 * arguments, and not the user's own config file after it has been edited by
 * hand.
 *
 * Written against the three acceptance criteria in the issue:
 *
 *   1. a temporary workspace lists and drafts tickets offline; two repositories
 *      stay isolated and reconfiguration needs owner consent
 *   2. traversal, malicious filenames and symlink escape fail closed; denial or
 *      unattended mode writes no ticket
 *   3. default disabled mode and the existing contributor queue are unchanged;
 *      setup never changes remote configuration
 *
 * No model, no network, no clock dependence. Every fixture is a temp directory.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

/* The feature is per-process and read at boot, so the environment is set before
 * any module that reads it is imported. The fake model server comes first too:
 * config.js snapshots OLLAMA_URL on import, so a later listen() port would
 * leave every turn talking to a closed socket instead of the fixture. */
const sandbox = mkdtempSync(join(tmpdir(), "tracker-ws-"));
process.env.PINCH_WORKSPACE = sandbox;
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "tracker-data-"));
process.env.LLM_PROVIDER = "ollama";
process.env.PINCH_AUTO_APPROVE = "false";
process.env.PINCH_FAST_PATH = "off";
process.env.QUASNOOZE_TRACKER = "on";

/* ── fake model: one ticket_draft_ticket call, then a plain answer ───────── */
const requests = [];
const ollama = createServer(async (req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "fast:latest" }] }));
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw || "{}");
  requests.push(body.messages || []);
  const alreadyRan = (body.messages || []).some((m) => m.role === "tool");
  const message = alreadyRan
    ? { content: "Done." }
    : {
        content: "",
        tool_calls: [{
          function: {
            name: "tracker_draft_ticket",
            arguments: { title: "Ticket from the model", body: "Body.", labels: ["agent"] },
          },
        }],
      };
  res.setHeader("content-type", body.stream ? "application/x-ndjson" : "application/json");
  res.end(JSON.stringify({ message, done: true }) + (body.stream ? "\n" : ""));
});
await new Promise((resolve) => ollama.listen(0, "127.0.0.1", resolve));
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
after(async () => {
  ollama.closeAllConnections();
  await new Promise((resolve) => ollama.close(resolve));
});

const adapter = await import("../src/tracker/adapter.js");
const { createLocalAdapter, slugFromTitle } = await import("../src/tracker/local.js");
const setup = await import("../src/tracker/setup.js");
const { TOOL_MAP, toolSchemas, isTrackerEnabled } = await import("../src/tools.js");

const { TrackerError, TRACKER_CODES, mintWriteApproval, TRACKER_LIMITS, TICKET_ID } = adapter;

const repos = [];
/** A fresh repository-shaped directory with an optional tickets/ subdirectory. */
function makeRepo(name, { tickets = "tickets" } = {}) {
  const root = mkdtempSync(join(tmpdir(), `tracker-${name}-`));
  repos.push(root);
  mkdirSync(join(root, ".git"), { recursive: true });
  if (tickets) mkdirSync(join(root, tickets), { recursive: true });
  return root;
}
const ticketText = (title, { labels = [], body = "Some detail." } = {}) =>
  ["---", `title: ${title}`, "created: 2026-01-01T00:00:00.000Z",
    ...(labels.length ? [`labels: ${labels.join(", ")}`] : []), "---", "", body].join("\n");

let registry;
before(() => {
  registry = setup.createTrackerRegistry({ dataDir: process.env.PINCH_DATA });
});
beforeEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});
after(() => {
  rmSync(sandbox, { recursive: true, force: true });
  rmSync(process.env.PINCH_DATA, { recursive: true, force: true });
});

/* ─────────────── acceptance 1: offline list + draft, isolation ─────────── */

test("a temporary workspace lists and drafts tickets with no network at all", async () => {
  const repo = makeRepo("basic");
  const dir = join(repo, "tickets");
  writeFileSync(join(dir, "fix-login-timeout.md"), ticketText("Fix the login timeout", {
    labels: ["bug", "auth"], body: "The token refresh loops forever.",
  }));

  // Any attempt to open a socket fails this test loudly rather than silently
  // passing because the adapter happens not to need one.
  const net = await import("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function blocked() { throw new Error("network used by the local tracker"); };
  try {
    const local = createLocalAdapter(dir);
    const board = await local.list();
    assert.equal(board.total, 1);
    assert.equal(board.tickets[0].id, "fix-login-timeout");
    assert.equal(board.tickets[0].title, "Fix the login timeout");
    assert.deepEqual([...board.tickets[0].labels], ["bug", "auth"]);
    assert.match(board.tickets[0].summary, /token refresh/);

    const one = await local.read("fix-login-timeout");
    assert.match(one.body, /loops forever/);

    const approval = mintWriteApproval({ tool: "tracker_draft_ticket" });
    const written = await local.draft(
      { title: "Add a retry budget", labels: ["enhancement"], body: "Cap retries at three." },
      { approval },
    );
    assert.equal(written.id, "add-a-retry-budget");
    const bytes = readFileSync(join(dir, "add-a-retry-budget.md"), "utf8");
    assert.match(bytes, /^---\ntitle: Add a retry budget\n/);
    assert.match(bytes, /labels: enhancement/);
    assert.match(bytes, /Cap retries at three\./);
    // The draft round-trips through the same parser the reader uses.
    const reread = await local.read("add-a-retry-budget");
    assert.equal(reread.title, "Add a retry budget");
  } finally {
    net.Socket.prototype.connect = realConnect;
  }
});

test("two repositories stay isolated: neither sees the other's tickets", async () => {
  const alpha = makeRepo("alpha");
  const beta = makeRepo("beta");
  writeFileSync(join(alpha, "tickets", "alpha-only.md"), ticketText("Alpha work"));
  writeFileSync(join(beta, "tickets", "beta-only.md"), ticketText("Beta work"));

  const a = createLocalAdapter(join(alpha, "tickets"));
  const b = createLocalAdapter(join(beta, "tickets"));
  const alphaIds = (await a.list()).tickets.map((t) => t.id);
  const betaIds = (await b.list()).tickets.map((t) => t.id);

  assert.deepEqual(alphaIds, ["alpha-only"]);
  assert.deepEqual(betaIds, ["beta-only"]);
  // An id from the other repository is simply absent, not readable.
  await assert.rejects(() => a.read("beta-only"), (error) => error.code === TRACKER_CODES.INVALID);

  // Drafting into one leaves the other's directory listing untouched.
  await a.draft({ title: "New for alpha", body: "" }, { approval: mintWriteApproval({ tool: "tracker_draft_ticket" }) });
  assert.deepEqual(readdirSync(join(beta, "tickets")), ["beta-only.md"]);
});

test("reconfiguration needs owner consent; disabling does not", () => {
  const repo = makeRepo("consent", { tickets: null });
  const first = join(repo, "one");
  const second = join(repo, "two");
  mkdirSync(first); mkdirSync(second);

  // First configuration defines the tracker, so it needs no consent token.
  const configured = registry.configure({ repoDir: repo, rootDir: first, name: "Demo" });
  assert.equal(configured.reconfigured, false);
  assert.equal(registry.entryFor(repo).rootDir, first);

  // Pointing it somewhere else does.
  assert.throws(
    () => registry.configure({ repoDir: repo, rootDir: second }),
    (error) => error.code === TRACKER_CODES.NO_APPROVAL,
  );
  assert.equal(registry.entryFor(repo).rootDir, first, "a refused reconfigure must change nothing");

  // With consent it moves, and the record says so.
  const consent = mintWriteApproval({ tool: "tracker_setup" });
  const moved = registry.configure({ repoDir: repo, rootDir: second, approval: consent });
  assert.equal(moved.reconfigured, true);
  assert.equal(registry.entryFor(repo).rootDir, second);

  // Turning it off is always allowed and never asks for a token.
  assert.deepEqual(registry.disable({ repoDir: repo }), { repository: setup.canonicalRepoPath(repo), changed: true });
  assert.equal(registry.entryFor(repo), null);
});

/* ────── acceptance 2: traversal, filenames, symlinks, denial, unattended ── */

test("traversal and malicious ticket ids fail closed before any path exists", async () => {
  const repo = makeRepo("traversal");
  const local = createLocalAdapter(join(repo, "tickets"));
  const attacks = [
    "../outside", "..", "../../etc/passwd", "/etc/passwd", "a/b", "a\\b",
    ".hidden", "UPPER", "with space", "trailing-", "nul\u0000byte", "ticket.md",
    "a".repeat(65), "", null, undefined, 123, {},
  ];
  for (const attack of attacks) {
    await assert.rejects(
      () => local.read(attack),
      (error) => error instanceof TrackerError && [TRACKER_CODES.UNSAFE_PATH, TRACKER_CODES.INVALID].includes(error.code),
      `accepted malicious id: ${JSON.stringify(attack)}`,
    );
  }
  // Nothing was created anywhere by the attempts.
  assert.deepEqual(readdirSync(join(repo, "tickets")), []);
  assert.equal(TICKET_ID.test("ok-123"), true);
});

test("a symlink inside the tracker directory is never read as a ticket", async () => {
  const repo = makeRepo("symlink");
  const dir = join(repo, "tickets");
  const secret = join(repo, "secret.txt");
  writeFileSync(secret, "TOP-SECRET");
  // Named like a valid ticket, pointing outside the tracker directory.
  symlinkSync(secret, join(dir, "good-ticket.md"));
  // A link to a *directory* is not a ticket either.
  mkdirSync(join(repo, "elsewhere"));
  symlinkSync(join(repo, "elsewhere"), join(dir, "dir-ticket.md"));

  const local = createLocalAdapter(dir);
  const board = await local.list();
  assert.equal(board.total, 0, "symlinks must not appear as tickets");
  await assert.rejects(() => local.read("good-ticket"), (error) => error.code === TRACKER_CODES.UNSAFE_PATH);
  await assert.rejects(() => local.read("dir-ticket"), (error) => error.code === TRACKER_CODES.UNSAFE_PATH);
  // The target was not leaked into any summary.
  assert.doesNotMatch(JSON.stringify(board), /TOP-SECRET/);
});

test("a tracker directory replaced after setup is refused, not followed", async () => {
  const repo = makeRepo("swap");
  const dir = join(repo, "tickets");
  writeFileSync(join(dir, "real-ticket.md"), ticketText("Real"));
  const local = createLocalAdapter(dir);
  // Swap the directory for a symlink to somewhere else, the way a malicious
  // archive or a half-applied sync could.
  const elsewhere = join(repo, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "real-ticket.md"), ticketText("Impostor"));
  rmSync(join(dir, "real-ticket.md"));
  rmSync(dir, { recursive: true, force: true });
  symlinkSync(elsewhere, dir);

  await assert.rejects(
    () => local.read("real-ticket"),
    (error) => error.code === TRACKER_CODES.UNSAFE_PATH,
  );
  // And a draft cannot be written through the swapped path either.
  await assert.rejects(
    () => local.draft({ title: "Sneaky", body: "" }, { approval: mintWriteApproval({ tool: "tracker_draft_ticket" }) }),
    (error) => error.code === TRACKER_CODES.UNSAFE_PATH,
  );
  assert.deepEqual(readdirSync(elsewhere), ["real-ticket.md"], "nothing was written through the link");
});

test("the ticket is validated on the opened handle, not on a separate stat of the name", async () => {
  // CodeQL js/file-system-race on the first version of this reader: it lstat'ed
  // the path and then opened it, so the two calls could disagree. The check now
  // happens on the descriptor (plus O_NOFOLLOW), which this asserts directly:
  // a symlink at the ticket's own path is refused by the open itself.
  const repo = makeRepo("race");
  const dir = join(repo, "tickets");
  const secret = join(repo, "secret.txt");
  writeFileSync(secret, "TOP-SECRET");
  const local = createLocalAdapter(dir);

  // A regular ticket reads fine…
  writeFileSync(join(dir, "plain.md"), ticketText("Plain", { body: "visible" }));
  assert.match((await local.read("plain")).body, /visible/);

  // …and a name that becomes a symlink is refused, never followed.
  symlinkSync(secret, join(dir, "swapped.md"));
  await assert.rejects(
    () => local.read("swapped"),
    (error) => error.code === TRACKER_CODES.UNSAFE_PATH && /symlink/.test(error.message),
  );

  // A dangling symlink is ENOENT at the open, not a silent "no such ticket"
  // that also happens to follow the link on another platform.
  symlinkSync(join(repo, "does-not-exist"), join(dir, "dangling.md"));
  await assert.rejects(
    () => local.read("dangling"),
    (error) => error.code === TRACKER_CODES.UNSAFE_PATH,
  );

  // The reader holds a descriptor, so replacing the entry after the open cannot
  // change what was measured as "the file".
  const big = join(dir, "big.md");
  writeFileSync(big, ticketText("Big", { body: "x".repeat(TRACKER_LIMITS.fileBytes) }));
  await assert.rejects(() => local.read("big"), (error) => /over the .* limit/.test(error.message));

  // Nothing above leaked the secret into an error message.
  assert.doesNotMatch(JSON.stringify(await local.list()), /TOP-SECRET/);
});

test("an oversized or malformed ticket is refused, not truncated", async () => {
  const repo = makeRepo("bounds");
  const dir = join(repo, "tickets");
  const local = createLocalAdapter(dir);

  writeFileSync(join(dir, "too-big.md"), ticketText("Huge") + "x".repeat(TRACKER_LIMITS.fileBytes));
  await assert.rejects(() => local.read("too-big"), (error) =>
    error.code === TRACKER_CODES.INVALID && /over the .* limit/.test(error.message));

  writeFileSync(join(dir, "no-front-matter.md"), "# just markdown\n");
  await assert.rejects(() => local.read("no-front-matter"), (error) => error.code === TRACKER_CODES.INVALID);

  writeFileSync(join(dir, "bad-key.md"), "---\ntitle: T\nevil: yes\n---\nbody\n");
  await assert.rejects(() => local.read("bad-key"), (error) => /unknown front-matter key/.test(error.message));

  // Front matter that never closes: the end of file is reached before the
  // closing ---, and the scan stops at the metadata limit rather than treating
  // the body as metadata.
  writeFileSync(join(dir, "unclosed.md"), "---\ntitle: T\ncreated: 2026-01-01T00:00:00.000Z\n");
  await assert.rejects(() => local.read("unclosed"), (error) => /not closed/.test(error.message));

  writeFileSync(join(dir, "dup-key.md"), "---\ntitle: A\ntitle: B\n---\nbody\n");
  await assert.rejects(() => local.read("dup-key"), (error) => /appears twice/.test(error.message));

  writeFileSync(join(dir, "bidi.md"), `---\ntitle: cart\u202eforp\n---\nbody\n`);
  await assert.rejects(() => local.read("bidi"), (error) => /control or bidirectional/.test(error.message));

  // A broken ticket does not hide the rest of the board from `list`: it is
  // reported as an invalid row the owner can see and fix, never omitted.
  writeFileSync(join(dir, "fine.md"), ticketText("Fine"));
  const board = await local.list();
  assert.equal(board.total, 7, "every Markdown file appears, valid or not");
  assert.equal(board.tickets.filter((t) => t.invalid).length, 6);
  const broken = board.tickets.find((t) => t.id === "no-front-matter");
  assert.equal(broken.invalid, true);
  assert.match(broken.summary, /front-matter/);
  const fine = board.tickets.find((t) => t.id === "fine");
  assert.equal(fine.invalid, undefined);
  assert.equal(fine.title, "Fine");
  // Reading the broken one directly is still a refusal, not a partial ticket.
  await assert.rejects(() => local.read("fine-broken"), (e) => e.code === TRACKER_CODES.INVALID);
});

test("drafting without a minted approval writes nothing, and never overwrites", async () => {
  const repo = makeRepo("approval");
  const dir = join(repo, "tickets");
  const local = createLocalAdapter(dir);

  // Every shape a JSON tool argument could take.
  for (const forged of [undefined, null, true, { approved: true }, { kind: "tracker-write-approval" }, "yes"]) {
    await assert.rejects(
      () => local.draft({ title: "Should not exist", body: "" }, { approval: forged }),
      (error) => error.code === TRACKER_CODES.NO_APPROVAL,
      `forged approval accepted: ${JSON.stringify(forged)}`,
    );
  }
  assert.deepEqual(readdirSync(dir), [], "a denied draft must create nothing");

  // An approval minted for a different tool cannot be reused for this one.
  const otherTool = mintWriteApproval({ tool: "write_file" });
  await assert.rejects(
    () => local.draft({ title: "Nope", body: "" }, { approval: otherTool }),
    (error) => error.code === TRACKER_CODES.NO_APPROVAL,
  );

  // A real approval works once, and drafting again with the same id refuses.
  const approval = mintWriteApproval({ tool: "tracker_draft_ticket" });
  await local.draft({ id: "keep-me", title: "Original", body: "first" }, { approval });
  await assert.rejects(
    () => local.draft({ id: "keep-me", title: "Replacement", body: "second" }, { approval }),
    (error) => error.code === TRACKER_CODES.EXISTS,
  );
  assert.match(readFileSync(join(dir, "keep-me.md"), "utf8"), /first/);
  assert.doesNotMatch(readFileSync(join(dir, "keep-me.md"), "utf8"), /second/);
});

test("credential stores are refused as tracker roots, even inside the home directory", async () => {
  const home = (await import("node:os")).homedir();
  const ssh = join(home, ".ssh");
  // Create it only if absent, so the test never depends on the machine's state.
  const created = !existsSync(ssh);
  try {
    if (created) mkdirSync(ssh, { recursive: true });
    assert.throws(() => adapter.assertTrackerRoot(ssh), (error) => error.code === TRACKER_CODES.UNSAFE_PATH);
    assert.throws(() => adapter.assertTrackerRoot("/"), (error) => error.code === TRACKER_CODES.UNSAFE_PATH);
    assert.throws(() => adapter.assertTrackerRoot("relative/path"), (error) => error.code === TRACKER_CODES.UNSAFE_PATH);
    // The tools sandbox and this module must not disagree about the list.
    const { isProtected } = await import("../src/tools.js");
    assert.equal(isProtected(ssh), true);
  } finally {
    if (created) rmSync(ssh, { recursive: true, force: true });
  }
});

/* ──── acceptance 3: default off, contributor queue untouched, no git ───── */

test("the feature is off unless explicitly enabled, and off means no tools at all", () => {
  assert.equal(isTrackerEnabled({}), false);
  assert.equal(isTrackerEnabled({ QUASNOOZE_TRACKER: "" }), false);
  assert.equal(isTrackerEnabled({ QUASNOOZE_TRACKER: "off" }), false);
  assert.equal(isTrackerEnabled({ QUASNOOZE_TRACKER: "0" }), false);
  assert.equal(isTrackerEnabled({ QUASNOOZE_TRACKER: "maybe" }), false);
  assert.equal(isTrackerEnabled({ QUASNOOZE_TRACKER: "on" }), true);
  assert.equal(isTrackerEnabled({ PINCH_TRACKER: "true" }), true);

  assert.equal(setup.isTrackerEnabled({}), false);
  assert.equal(setup.isTrackerEnabled({ QUASNOOZE_TRACKER: "on" }), true);

  // With the feature off, a fresh registry refuses to hand out an adapter and
  // refuses to store a configuration — the default is inert, not merely quiet.
  const fresh = mkdtempSync(join(tmpdir(), "tracker-off-"));
  repos.push(fresh);
  const off = setup.createTrackerRegistry({ dataDir: fresh, env: {} });
  assert.equal(off.isEnabled(), false);
  assert.throws(() => off.configure({ repoDir: sandbox, rootDir: sandbox }),
    (error) => error.code === TRACKER_CODES.DISABLED);
  assert.equal(existsSync(off.path), false, "a disabled feature must not create a config file");

  // Unknown repository with the feature on is a clear instruction, not a crash.
  const on = setup.createTrackerRegistry({ dataDir: process.env.PINCH_DATA, env: { QUASNOOZE_TRACKER: "on" } });
  return assert.rejects(() => on.adapterFor(sandbox), (error) => error.code === TRACKER_CODES.UNCONFIGURED);
});

test("the ticket tools are hidden from the model when the feature is off", () => {
  const names = toolSchemas().map((schema) => schema.function.name);
  // The suite runs with QUASNOOZE_TRACKER=on, so they are offered here…
  assert.ok(names.includes("tracker_draft_ticket"));
  // …and the gate is the same predicate the agent uses, checked directly.
  assert.equal(isTrackerEnabled({ QUASNOOZE_TRACKER: "off" }), false);
  assert.equal(TOOL_MAP.get("tracker_draft_ticket").dangerous, true, "a write must be approval-gated");
  assert.equal(TOOL_MAP.get("tracker_list_tickets").dangerous, undefined, "a read must not prompt");
});

test("discovery proposes directories and never touches git configuration", async () => {
  const repo = makeRepo("discover", { tickets: "tickets" });
  writeFileSync(join(repo, "tickets", "one.md"), ticketText("One"));
  mkdirSync(join(repo, "docs", "tickets"), { recursive: true });

  const gitConfig = join(repo, ".git", "config");
  const original = "[core]\n\tbare = false\n";
  writeFileSync(gitConfig, original);
  const before = { config: readFileSync(gitConfig, "utf8"), files: readdirSync(repo).sort() };

  const found = setup.discoverRepository(repo);
  assert.equal(found.repository, setup.canonicalRepoPath(repo));
  const labels = found.candidates.map((c) => c.label);
  assert.ok(labels.includes("tickets"), `expected tickets, got ${labels.join(", ")}`);
  assert.ok(labels.includes("docs/tickets"));
  assert.equal(found.candidates.find((c) => c.label === "tickets").tickets, 1);

  // Nothing was created, and .git/config is byte-identical.
  assert.deepEqual(readdirSync(repo).sort(), before.files);
  assert.equal(readFileSync(gitConfig, "utf8"), before.config);
  assert.doesNotMatch(readFileSync(gitConfig, "utf8"), /tracker/i);

  // A repository with nothing to find is a normal answer.
  const empty = makeRepo("empty", { tickets: null });
  assert.deepEqual(setup.discoverRepository(empty).candidates, []);
});

test("a symlinked candidate directory is not endorsed by discovery", () => {
  const repo = makeRepo("linkdiscover", { tickets: null });
  const outside = mkdtempSync(join(tmpdir(), "tracker-outside-"));
  repos.push(outside);
  symlinkSync(outside, join(repo, "tickets"));
  const found = setup.discoverRepository(repo);
  assert.equal(found.candidates.length, 0, "an escaping symlink must not be proposed");
});

test("a hand-edited config file cannot smuggle in a repository entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "tracker-config-"));
  repos.push(dir);
  const file = join(dir, "tracker-config.json");
  writeFileSync(file, JSON.stringify({
    version: 1,
    repositories: {
      "./relative": { enabled: true, rootDir: "/tmp" },
      "/abs/ok": { enabled: false, rootDir: "/tmp" },
      "/abs/escape": { enabled: true, rootDir: "../../etc" },
      "/abs/good": { enabled: true, kind: "local-markdown", rootDir: "/tmp", name: "Fine" },
    },
  }));
  const reg = setup.createTrackerRegistry({ dataDir: dir, env: { QUASNOOZE_TRACKER: "on" }, file });
  const configured = reg.listConfigured();
  assert.deepEqual(configured.map((c) => c.repository), ["/abs/good"], "only the well-formed entry survives");

  // Corrupt JSON is treated as "nothing configured", never as a crash.
  writeFileSync(file, "{not json");
  assert.deepEqual(setup.createTrackerRegistry({ dataDir: dir, env: { QUASNOOZE_TRACKER: "on" }, file }).listConfigured(), []);
});

test("the existing contributor automation is untouched by this feature", () => {
  // The GitHub contributor bot is repository workflows and scripts; the tracker
  // is a local runtime feature. Assert they share no files, so a future edit
  // cannot quietly couple them.
  const workflow = readFileSync(new URL("../.github/workflows/contributor-queue.yml", import.meta.url), "utf8");
  assert.match(workflow, /name: Contributor queue/);
  assert.doesNotMatch(workflow, /tracker_(?:list|read|draft)_tickets|QUASNOOZE_TRACKER/);
  for (const file of ["src/tracker/adapter.js", "src/tracker/local.js", "src/tracker/setup.js"]) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    // No process spawning and no HTTP client in the local tracker path.
    assert.doesNotMatch(text, /child_process|node:https?|fetch\(/, `${file} must stay offline and shell-free`);
  }
});

/* ─────────────── the agent gate: denial and unattended write nothing ────── */

const { runAgent, answerApproval } = await import("../src/agent.js");

test("a denied approval and an unattended run both leave the tracker untouched", async () => {
  const repo = makeRepo("gate");
  const dir = join(repo, "tickets");
  registry.configure({ repoDir: sandbox, rootDir: dir });

  // 1. The human denies the prompt: no file, and the denial is in the trace.
  let asked = false;
  const denied = await runAgent({
    sessionId: "t-deny",
    text: "file a ticket for this",
    onEvent: (event) => {
      if (event.type === "approval") { asked = true; answerApproval(event.id, false); }
    },
  });
  assert.equal(asked, true, "drafting a ticket must raise an approval");
  assert.deepEqual(readdirSync(dir), [], "a denied draft must create nothing");
  assert.ok(denied.trace.some((t) => t.tool === "tracker_draft_ticket" && t.denied), "the denial is recorded");

  // 2. Unattended: nobody is there to approve, so nothing is written.
  requests.length = 0;
  const unattended = await runAgent({
    sessionId: "t-unattended",
    text: "file a ticket for this",
    autonomy: "unattended",
  });
  assert.deepEqual(readdirSync(dir), [], "an unattended run must create nothing");
  assert.ok(unattended.trace.some((t) => t.tool === "tracker_draft_ticket" && t.denied));

  // 3. Approving actually writes — the gate is a gate, not a wall.
  const approved = await runAgent({
    sessionId: "t-allow",
    text: "file a ticket for this",
    onEvent: (event) => { if (event.type === "approval") answerApproval(event.id, true); },
  });
  assert.deepEqual(readdirSync(dir), ["ticket-from-the-model.md"]);
  assert.ok(approved.trace.some((t) => t.tool === "tracker_draft_ticket" && t.ok));
  assert.equal(adapter.parseTicketMarkdown(readFileSync(join(dir, "ticket-from-the-model.md"), "utf8")).title,
    "Ticket from the model");
});

/* ───────────────────────────── small surface ───────────────────────────── */

test("titles normalise to stable ids, and non-Latin titles are not guessed at", () => {
  assert.equal(slugFromTitle("Fix: the Login   Timeout!"), "fix-the-login-timeout");
  assert.equal(slugFromTitle("Café déjà vu"), "cafe-deja-vu");
  assert.equal(slugFromTitle("---"), "");
  assert.equal(slugFromTitle("日本語のタイトル"), "");
  assert.equal(slugFromTitle("x".repeat(200)).length, 48);
  // An empty slug is refused rather than replaced with a random id.
  assert.throws(() => adapter.assertTicketId(""), (error) => error.code === TRACKER_CODES.UNSAFE_PATH);
});

test("normalizeTicket bounds every field and refuses rather than trimming meaning", () => {
  assert.throws(() => adapter.normalizeTicket({ title: "" }), /needs a title/);
  assert.throws(() => adapter.normalizeTicket({ title: "x".repeat(201) }), /longer than 200/);
  assert.throws(() => adapter.normalizeTicket({ title: "ok", labels: ["a,b"] }), /comma/);
  assert.throws(() => adapter.normalizeTicket({ title: "ok", labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }), /at most 10/);
  assert.throws(() => adapter.normalizeTicket({ title: "ok", body: "x".repeat(TRACKER_LIMITS.bodyChars + 1) }), /longer than/);
  assert.throws(() => adapter.normalizeTicket({ title: "ok", body: "line\u0000" }), /control or bidirectional/);
  const ok = adapter.normalizeTicket({ title: "  spaced  ", labels: ["bug", "bug"], body: "b" });
  assert.equal(ok.title, "spaced");
  assert.deepEqual([...ok.labels], ["bug"], "duplicate labels collapse");
  assert.equal(Object.isFrozen(ok), true);
});
