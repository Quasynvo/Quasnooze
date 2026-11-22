/**
 * skill-compiler.test.js — the contract behind `skill-01` (issue #207).
 *
 * The claim under test is narrow and checkable: a successful conversation
 * turn compiles into a data-only program that replays with **zero model
 * calls**, with arguments byte-identical to the recorded run, with every
 * permission re-checked against current policy, and with every applied step
 * verified by independent read-back. Anything that smells like authority in
 * skill content — grants, permissions, "allow": true — must be refused at
 * parse time, and chat must never load skills at all.
 *
 * Deterministic fakes throughout: no model, no network, no microphone, no
 * real shell. What is real is the policy layer (src/risk.js), the tool
 * registry (src/tools.js) and the verifier (src/verify.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.env.PINCH_WORKSPACE = mkdtempSync(join(tmpdir(), "pinch-skill-ws-"));
process.env.PINCH_DATA = mkdtempSync(join(tmpdir(), "pinch-skill-data-"));
process.env.PINCH_AUTO_APPROVE = "true";
process.env.LLM_PROVIDER = "ollama";
process.env.OLLAMA_URL = "http://127.0.0.1:9"; // nothing listens; nothing may call it

// A replayed turn is a statement about the world (F08 re-reads it before each
// step), so the world must exist for the turn to be honest: these tests fake
// the *executor*, not the system of record.
writeFileSync(join(process.env.PINCH_WORKSPACE, "report.txt"), "draft one\n");

const { compileSkill } = await import("../src/skills/compiler.js");
const { saveSkill, loadSkill, listSkills, approveSkill, revokeSkill, deleteSkill, skillsDir } = await import("../src/skills/registry.js");
const { replaySkill } = await import("../src/skills/replay.js");
const { validateSkill, skillDigest, SkillError, SKILL_KIND, SKILL_SCHEMA_VERSION } = await import("../src/skills/manifest.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/* ─────────────────────────── recorded turns ────────────────────────────── */

const okWrite = {
  tool: "write_file",
  args: { path: "report.txt", content: "draft one\n" },
  result: { ok: true, output: "wrote report.txt (10 bytes)" },
  verification: { status: "verified", detail: "read back matches" },
};
const okRead = {
  tool: "read_file",
  args: { path: "report.txt" },
  result: { ok: true, output: "draft one\n" },
  verification: { status: "verified", detail: "independent read agrees" },
};
const okNote = {
  tool: "remember",
  args: { fact: "report drafted", tag: "work" },
  result: { ok: true, output: "remembered" },
  verification: { status: "unverified", detail: "no independent read-back is defined for remember" },
};

const turn = (calls = [okWrite, okRead]) => ({
  name: "draft-report",
  description: "write the report and read it back",
  utterance: "draft the report and check it",
  calls,
});

function manifestFor(steps, name = "hand-built") {
  return {
    kind: SKILL_KIND,
    schema_version: SKILL_SCHEMA_VERSION,
    name,
    description: "",
    compiled_from: { utterance: "written by the test" },
    steps,
  };
}

function fakeExecute({ failOn = null, result = { ok: true, output: "done" } } = {}) {
  const calls = [];
  return {
    calls,
    async execute(tool, args) {
      calls.push({ tool, args });
      if (tool === failOn) return { ok: false, output: "it did not work" };
      return result;
    },
  };
}

const verified = async () => ({ status: "verified", detail: "read back matches" });

/* ─────────────────────────── compile: the happy path ───────────────────── */

test("a successful multi-step turn compiles into a frozen, ordered, data-only program", () => {
  const skill = compileSkill(turn());
  assert.equal(skill.kind, "quasnooze-skill");
  assert.equal(skill.name, "draft-report");
  assert.deepEqual(skill.steps.map((s) => s.tool), ["write_file", "read_file"]);
  // Byte-identity starts here: the compiled arguments are the recorded ones.
  assert.equal(JSON.stringify(skill.steps[0].args), JSON.stringify(okWrite.args));
  assert.equal(JSON.stringify(skill.steps[1].args), JSON.stringify(okRead.args));
  assert.ok(Object.isFrozen(skill) && Object.isFrozen(skill.steps[0]), "a compiled skill is frozen");
  assert.equal(skillDigest(skill), skillDigest(compileSkill(turn())), "digest is content, not assembly order");
});

test("compile accepts honest unverified steps and keeps their order across three steps", () => {
  const skill = compileSkill(turn([okWrite, okRead, okNote]));
  assert.deepEqual(skill.steps.map((s) => s.tool), ["write_file", "read_file", "remember"]);
});

/* ─────────────────────────── compile: refusals ─────────────────────────── */

test("a single call does not compile — a skill is a program, not a shortcut", () => {
  assert.throws(() => compileSkill(turn([okWrite])), SkillError);
  assert.throws(() => compileSkill(turn([okWrite])), /at least 2 tool calls/);
});

test("failed, denied and contradicted steps never compile", () => {
  const failed = { ...okWrite, result: { ok: false, output: "nope" } };
  const denied = { ...okWrite, denied: true };
  const contradicted = { ...okWrite, verification: { status: "contradicted", detail: "the read-back disagrees" } };
  for (const bad of [failed, denied, contradicted]) {
    assert.throws(() => compileSkill(turn([bad, okRead])), SkillError, JSON.stringify(bad));
  }
  assert.throws(() => compileSkill(turn([contradicted, okRead])), /contradicted/);
});

test("a skill cannot invent tools", () => {
  assert.throws(
    () => compileSkill(turn([{ ...okWrite, tool: "mind_control" }, okRead])),
    /cannot invent tools/,
  );
});

test("blocked commands are refused at compile time", () => {
  const doomed = {
    tool: "shell",
    args: { command: "mkfs.ext4 /dev/sdb1" },
    result: { ok: true, output: "pretend" },
    verification: null,
  };
  assert.throws(() => compileSkill(turn([doomed, okRead])), /blocked/);
});

test("missing required arguments do not compile", () => {
  const half = { ...okWrite, args: { path: "report.txt" } };
  assert.throws(() => compileSkill(turn([half, okRead])), /missing required argument "content"/);
});

/* ─────────────────── the manifest is data, not authority ───────────────── */

test("the manifest schema refuses authority fields by name", () => {
  assert.throws(
    () => validateSkill({ ...manifestFor([okWrite, okRead].map(({ tool, args }) => ({ tool, args }))), grants: { shell: true } }),
    /data, not authority.*grants/,
  );
  assert.throws(
    () => validateSkill(manifestFor([{ tool: "write_file", args: { path: "a", content: "b" }, allow: true }, { tool: "read_file", args: { path: "a" } }])),
    /data, not authority.*allow/,
  );
  assert.throws(
    () => validateSkill({ ...manifestFor([{ tool: "write_file", args: { path: "a", content: "b" } }, { tool: "read_file", args: { path: "a" } }]), compiled_from: { utterance: "x", approved: true } }),
    /data, not authority.*approved/,
  );
});

test("manifest arguments cannot reach the prototype chain", () => {
  const evil = JSON.parse('{"__proto__": {"polluted": true}, "path": "a.txt", "content": "x"}');
  assert.throws(
    () => validateSkill(manifestFor([{ tool: "write_file", args: evil }, { tool: "read_file", args: { path: "a.txt" } }])),
    /prototype chain/,
  );
});

test("skill names may not walk out of the registry", () => {
  const body = manifestFor([{ tool: "write_file", args: { path: "a", content: "b" } }, { tool: "read_file", args: { path: "a" } }]);
  for (const name of ["../../evil", "skills/approvals", "..", "UPPER", "a b", "approvals"]) {
    assert.throws(() => saveSkill({ ...body, name }), SkillError, name);
    assert.throws(() => loadSkill(name), SkillError, name);
  }
});

/* ─────────────────────────── registry + approval ───────────────────────── */

test("saving registers a skill; it is not approved by saving", () => {
  const skill = compileSkill(turn());
  const { digest } = saveSkill(skill);
  assert.equal(digest, skillDigest(skill));
  const loaded = loadSkill("draft-report");
  assert.equal(loaded.approval.approved, false);
  assert.equal(loaded.approval.stale, false);
  assert.deepEqual(listSkills().map((r) => r.name), ["draft-report"]);
  assert.equal(listSkills()[0].approved, false);
});

test("approval binds to the content, not to the filename", async () => {
  saveSkill(compileSkill(turn()));
  approveSkill("draft-report");
  assert.equal(loadSkill("draft-report").approval.approved, true, "the owner approved this content");

  // The same name, edited content — an attacker's swap after review.
  const edited = compileSkill(turn([okWrite, okNote]));
  saveSkill(edited);
  const afterEdit = loadSkill("draft-report");
  assert.equal(afterEdit.approval.approved, false, "edited content is not approved");
  assert.equal(afterEdit.approval.stale, true, "the loader says the approval went stale");

  const { execute, calls } = fakeExecute();
  const refused = await replaySkill(afterEdit, { execute, verify: verified, approve: () => true });
  assert.equal(refused.status, "refused");
  assert.match(refused.reason, /changed after the owner approved/);
  assert.equal(calls.length, 0, "nothing runs on a stale approval");

  approveSkill("draft-report"); // the owner reviews the new content and approves again
  const rerun = await replaySkill(loadSkill("draft-report"), { execute, verify: verified, approve: () => true });
  assert.equal(rerun.status, "completed");
});

test("revoke keeps the file; delete removes both", () => {
  saveSkill(compileSkill(turn()));
  approveSkill("draft-report");
  assert.equal(revokeSkill("draft-report").revoked, true);
  assert.equal(loadSkill("draft-report").approval.approved, false);
  assert.ok(existsSync(join(skillsDir(), "draft-report.json")), "revoke keeps the file");
  const gone = deleteSkill("draft-report");
  assert.equal(gone.deleted, true);
  assert.equal(existsSync(join(skillsDir(), "draft-report.json")), false);
  assert.throws(() => loadSkill("draft-report"), SkillError);
});

/* ──────────────────────────── replay: the contract ─────────────────────── */

test("replay runs a compiled turn with zero model calls and byte-identical arguments", async () => {
  const skill = compileSkill(turn());
  saveSkill(skill);
  approveSkill("draft-report");
  const loaded = loadSkill("draft-report");
  const { execute, calls } = fakeExecute();
  // approve: () => true stands in for the owner at the keyboard: write_file is
  // a dangerous tool, and every dangerous step re-enters the gate on replay.
  const report = await replaySkill(loaded, { execute, verify: verified, approve: () => true });

  assert.equal(report.status, "completed");
  assert.equal(report.completed, 2);
  assert.equal(report.total, 2);
  assert.equal(calls.length, 2, "exactly the recorded tool calls — nothing else ran");
  assert.equal(JSON.stringify(calls[0].args), JSON.stringify(okWrite.args), "arguments are byte-identical");
  assert.equal(JSON.stringify(calls[1].args), JSON.stringify(okRead.args), "arguments are byte-identical");
  assert.equal(report.steps[0].argsJson, JSON.stringify(okWrite.args));
  assert.deepEqual(report.steps.map((s) => s.verification.status), ["verified", "verified"]);
  deleteSkill("draft-report");
});

test("replay refuses skills that are not owner-approved, before running anything", async () => {
  const skill = compileSkill({ ...turn(), name: "unapproved-turn" });
  saveSkill(skill);
  const { execute, calls } = fakeExecute();
  const report = await replaySkill(loadSkill("unapproved-turn"), { execute, verify: verified, approve: () => true });
  assert.equal(report.status, "refused");
  assert.match(report.reason, /not owner-approved/);
  assert.equal(calls.length, 0);
  deleteSkill("unapproved-turn");
});

test("replay re-checks policy: a dangerous step stops cleanly at the gate", async () => {
  const skill = compileSkill(turn([
    okRead,
    { tool: "shell", args: { command: "git log -p" }, result: { ok: true, output: "log" }, verification: { status: "unverified", detail: "shell cannot be read back" } },
  ]));
  saveSkill(skill);
  approveSkill("draft-report");
  const loaded = loadSkill("draft-report");

  const denied = fakeExecute();
  const stopped = await replaySkill(loaded, { execute: denied.execute, verify: verified });
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.reason, /needs approval/);
  assert.equal(denied.calls.length, 1, "the read step ran, the dangerous step did not");
  assert.equal(stopped.steps[1].notRun, true);

  const approved = fakeExecute();
  const done = await replaySkill(loaded, { execute: approved.execute, verify: verified, approve: () => true });
  assert.equal(done.status, "completed");
  assert.equal(approved.calls.length, 2);
  deleteSkill("draft-report");
});

test("a plan is not authority: today's policy wins over the recorded one", async () => {
  // Hand-built: what a recorded-and-approved skill looked like before the
  // screen grew to refuse `shutdown`. Policy moved; the replay must not.
  const skill = manifestFor([
    { tool: "read_file", args: { path: "report.txt" } },
    { tool: "shell", args: { command: "shutdown now" } },
  ], "old-shutdown");
  saveSkill(skill);
  approveSkill("old-shutdown");
  const { execute, calls } = fakeExecute();
  const report = await replaySkill(loadSkill("old-shutdown"), {
    execute,
    verify: verified,
    approve: () => true,
    freshConsent: true,
  });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /policy refused step 2/);
  assert.equal(calls.length, 1, "the blocked command never executes, even with blanket approval");
  deleteSkill("old-shutdown");
});

test("drift stops the replay: a tool that no longer exists is not guessed around", async () => {
  const skill = manifestFor([
    { tool: "read_file", args: { path: "report.txt" } },
    { tool: "gone_tool", args: { query: "x" } },
  ], "drifted");
  saveSkill(skill);
  approveSkill("drifted");
  const { execute, calls } = fakeExecute();
  const report = await replaySkill(loadSkill("drifted"), { execute, verify: verified, approve: () => true });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /no such tool in the current registry/);
  assert.equal(calls.length, 1);
  deleteSkill("drifted");
});

test("fresh-consent steps cannot be bypassed by a blanket approval", async () => {
  const skill = manifestFor([
    { tool: "read_file", args: { path: "report.txt" } },
    { tool: "type_text", args: { text: "hello there" } },
  ], "typer");
  saveSkill(skill);
  approveSkill("typer");
  const loaded = loadSkill("typer");

  const waved = fakeExecute();
  const stopped = await replaySkill(loaded, { execute: waved.execute, verify: verified, approve: () => true });
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.reason, /fresh consent/);
  assert.equal(waved.calls.length, 1);

  const consented = fakeExecute();
  const done = await replaySkill(loaded, { execute: consented.execute, verify: verified, approve: () => true, freshConsent: true });
  assert.equal(done.status, "completed");
  assert.equal(consented.calls.length, 2);
  deleteSkill("typer");
});

test("a contradicted read-back stops the replay and is reported as a contradiction", async () => {
  saveSkill(compileSkill(turn([okWrite, okRead, okNote])));
  approveSkill("draft-report");
  const { execute, calls } = fakeExecute();
  const report = await replaySkill(loadSkill("draft-report"), {
    execute,
    verify: async () => ({ status: "contradicted", detail: "the file on disk is not what the tool claimed" }),
    approve: () => true,
  });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /contradicted/);
  assert.equal(report.steps[0].verification.status, "contradicted");
  assert.equal(report.steps[0].applied, false, "a contradicted step does not count as applied");
  assert.equal(report.completed, 0);
  assert.equal(calls.length, 1, "the replay stops — later steps never run");
  deleteSkill("draft-report");
});

test("a failed step stops the replay — stop, don't guess", async () => {
  saveSkill(compileSkill(turn([okWrite, okRead, okNote])));
  approveSkill("draft-report");
  const { execute } = fakeExecute({ failOn: "read_file" });
  const report = await replaySkill(loadSkill("draft-report"), { execute, verify: verified, approve: () => true });
  assert.equal(report.status, "stopped");
  assert.match(report.reason, /failed — stopping rather than guessing/);
  assert.equal(report.steps.length, 2);
  assert.equal(report.steps[1].ok, false);
  assert.equal(report.steps[1].applied, false);
  deleteSkill("draft-report");
});

test("unverified steps are recorded as unverified — honest, not hidden", async () => {
  saveSkill(compileSkill(turn([okWrite, okRead])));
  approveSkill("draft-report");
  const { execute } = fakeExecute();
  const report = await replaySkill(loadSkill("draft-report"), {
    execute,
    verify: async () => ({ status: "unverified", detail: "no independent read-back is defined for write_file" }),
    approve: () => true,
  });
  assert.equal(report.status, "completed");
  assert.deepEqual(report.steps.map((s) => s.verification.status), ["unverified", "unverified"]);
  deleteSkill("draft-report");
});

/* ─────────────────── zero-model and chat-separation proofs ─────────────── */

test("the skills modules are zero-model by construction", () => {
  for (const file of ["manifest.js", "compiler.js", "registry.js", "replay.js"]) {
    const src = readFileSync(join(ROOT, "src", "skills", file), "utf8");
    assert.ok(!/from "\.\.\/(agent|brain|model-choice|server)\.js"/.test(src), `${file} imports a model-side module`);
    assert.ok(!/from "\.\/(agent|brain|model-choice)\.js"/.test(src), `${file} imports a model-side module`);
  }
});

test("simple chat never loads skills", () => {
  for (const file of ["agent.js", "brain.js", "fast-path.js", "tools.js", "model-choice.js"]) {
    const src = readFileSync(join(ROOT, "src", file), "utf8");
    assert.ok(!src.includes("skills/"), `${file} must not reach into src/skills/ — skills load only through the owner-facing registry`);
  }
});

/* ─────────────── the thousandth run costs the same as the first ────────── */

test("replay p50 stays under 300 ms across 50 runs (n=50, fake execution)", async () => {
  saveSkill(compileSkill(turn([okWrite, okRead, okNote])));
  approveSkill("draft-report");
  const loaded = loadSkill("draft-report");
  const samples = [];
  for (let i = 0; i < 50; i++) {
    const { execute, calls } = fakeExecute();
    const report = await replaySkill(loaded, { execute, verify: verified, approve: () => true });
    assert.equal(report.status, "completed");
    assert.equal(calls.length, 3);
    samples.push(report.ms);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  assert.ok(p50 < 300, `replay p50 was ${p50} ms over 50 runs — contract is < 300 ms with zero model calls`);
  deleteSkill("draft-report");
});
