import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  copyFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeBrandEnv } from "../src/brand-config.js";
import { parseSetupEnv, renderSetupEnv } from "../src/setup-env.js";
const root = fileURLToPath(new URL("..", import.meta.url));
test("brand aliases preserve unrelated keys, explicit canonical empty values, and the input", () => {
  const input = {
    PINCH_KEY: "legacy",
    QUASNOOZE_KEY: "",
    PINCH_PORT: "1234",
    QUASNOOZE_HOST: "127.0.0.1",
    LLM_MODEL: "local",
  };
  const snapshot = { ...input },
    out = normalizeBrandEnv(input);
  assert.deepEqual(input, snapshot);
  assert.equal(out.PINCH_KEY, "");
  assert.equal(out.QUASNOOZE_KEY, "");
  assert.equal(out.QUASNOOZE_PORT, "1234");
  assert.equal(out.PINCH_HOST, "127.0.0.1");
  assert.equal(out.LLM_MODEL, "local");
});
test("real config precedence works across prefixes and native residency ignores file flags", () => {
  const dir = mkdtempSync(join(tmpdir(), "quasnooze-brand-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, ".git"));
    for (const f of ["config.js", "brand-config.js", "state-paths.js", "providers.js"])
      copyFileSync(join(root, "src", f), join(dir, "src", f));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const base = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) => !k.startsWith("PINCH_") && !k.startsWith("QUASNOOZE_"),
      ),
    );
    function inspect(file, env = {}, platform = "win32") {
      writeFileSync(join(dir, ".env"), file);
      const code = `Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});const {config}=await import(${JSON.stringify(pathToFileURL(join(dir, "src/config.js")).href)});console.log(JSON.stringify({desktop:config.desktopRequested,host:config.host,keyLength:config.authKey.length,autoApprove:config.autoApprove}));`;
      return JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", code], {
          env: { ...base, ...env },
          encoding: "utf8",
          timeout: 10000,
        }),
      );
    }
    assert.equal(
      inspect("PINCH_HOST=file-legacy\nQUASNOOZE_HOST=file-new\n").host,
      "file-new",
    );
    assert.equal(
      inspect("QUASNOOZE_HOST=file-new\n", { PINCH_HOST: "process-legacy" })
        .host,
      "process-legacy",
    );
    assert.equal(
      inspect("PINCH_HOST=file-old\n", { QUASNOOZE_HOST: "process-new" }).host,
      "process-new",
    );
    assert.equal(
      inspect("", { PINCH_HOST: "process-old", QUASNOOZE_HOST: "process-new" })
        .host,
      "process-new",
    );
    assert.equal(
      inspect("QUASNOOZE_KEY=file-key\n", {
        PINCH_KEY: "legacy",
        QUASNOOZE_KEY: "",
      }).keyLength,
      0,
    );
    const unsafe =
      "QUASNOOZE_DESKTOP=1\nPINCH_DESKTOP=1\nQUASNOOZE_KEY=\nQUASNOOZE_HOST=0.0.0.0\nQUASNOOZE_AUTO_APPROVE=true\n";
    assert.equal(inspect(unsafe).desktop, false);
    assert.deepEqual(inspect(unsafe, { QUASNOOZE_DESKTOP: "1" }), {
      desktop: true,
      host: "127.0.0.1",
      keyLength: 64,
      autoApprove: false,
    });
    assert.equal(
      inspect(unsafe, { PINCH_DESKTOP: "1", QUASNOOZE_DESKTOP: "" }).desktop,
      false,
    );
    assert.equal(inspect(unsafe, { QUASNOOZE_DESKTOP: "true" }).desktop, false);
    assert.equal(
      inspect(unsafe, { QUASNOOZE_DESKTOP: "1" }, "linux").desktop,
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("setup reads legacy config and emits preferred canonical values without duplicate old options", () => {
  const values = parseSetupEnv(
    "PINCH_KEY=old\nPINCH_HOST=127.0.0.1\nQUASNOOZE_KEY=new\nLLM_MODEL=local\n",
  );
  assert.equal(values.QUASNOOZE_KEY, "new");
  assert.equal(values.PINCH_KEY, "new");
  assert.equal(values.QUASNOOZE_HOST, "127.0.0.1");
  const out = renderSetupEnv("", values);
  assert.match(out, /QUASNOOZE_KEY=new/);
  assert.match(out, /QUASNOOZE_HOST=127.0.0.1/);
  assert.doesNotMatch(out, /^PINCH_/m);
  const template = "# kept comment\nQUASNOOZE_KEY=\nQUASNOOZE_HOST=\n";
  const rendered = renderSetupEnv(template, {
    ...values,
    QUASNOOZE_KEY: "edited",
  });
  assert.match(rendered, /QUASNOOZE_KEY=edited/);
  assert.match(rendered, /# kept comment/);
  assert.doesNotMatch(rendered, /^PINCH_/m);
});
test("canonical and legacy CLI launchers share help and version behavior", () => {
  for (const arg of ["help", "--version"]) {
    const run = (name) =>
      execFileSync(process.execPath, [join(root, "bin", name + ".js"), arg], {
        encoding: "utf8",
        timeout: 10000,
      });
    assert.equal(run("pinch"), run("quasnooze"));
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.bin.pinch, "./bin/pinch.js");
  assert.equal(pkg.bin.quasnooze, "./bin/quasnooze.js");
});

test("legacy server factory is an alias, not a separate or weaker server", async () => {
  const api = await import("../src/server.js");
  assert.equal(api.createPinchServer, api.createQuasnoozeServer);
});
