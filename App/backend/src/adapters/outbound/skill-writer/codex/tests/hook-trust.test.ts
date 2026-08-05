/** Codex hook trust tests. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { trustMemmyCodexHooks } from "../hook-trust.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("Codex hook trust", () => {
  it("persists and verifies trust for only the two Memmy user hooks", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-codex-hook-trust-"));

    await expect(trustMemmyCodexHooks({
      codexHomeDirectory: tempDir,
      hooksFilePath: join(tempDir, "hooks.json"),
      hookCommand: `node '${join(tempDir, "hooks", "memmy-resume-hook.mjs")}'`,
      codexExecutable: process.execPath,
      appServerArguments: ["-e", FAKE_CODEX_APP_SERVER]
    })).resolves.toBeUndefined();
  });

  it("rejects success when Codex does not discover both Memmy hooks", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-codex-hook-trust-missing-"));

    await expect(trustMemmyCodexHooks({
      codexHomeDirectory: tempDir,
      hooksFilePath: join(tempDir, "hooks.json"),
      hookCommand: `node '${join(tempDir, "hooks", "memmy-resume-hook.mjs")}'`,
      codexExecutable: process.execPath,
      appServerArguments: ["-e", FAKE_CODEX_APP_SERVER, "missing-stop"]
    })).rejects.toThrow("Codex did not discover both installed Memmy hooks");
  });
});

const FAKE_CODEX_APP_SERVER = String.raw`
const readline = require("node:readline");
const path = require("node:path");
const home = process.env.CODEX_HOME;
const sourcePath = path.join(home, "hooks.json");
const scriptPath = path.join(home, "hooks", "memmy-resume-hook.mjs");
const missingStop = process.argv.includes("missing-stop");
let trusted = false;
const hook = (key, eventName, hash, command = "node '" + scriptPath + "'") => ({
  key,
  eventName,
  handlerType: "command",
  command,
  source: "user",
  sourcePath,
  currentHash: hash,
  trustStatus: trusted ? "trusted" : "untrusted",
  enabled: trusted,
  isManaged: false
});
const hooks = () => [
  hook(sourcePath + ":user_prompt_submit:0:0", "userPromptSubmit", "sha256:prompt"),
  ...(missingStop ? [] : [hook(sourcePath + ":stop:0:0", "stop", "sha256:stop")]),
  hook(sourcePath + ":pre_tool_use:0:0", "preToolUse", "sha256:unrelated", "node '/tmp/unrelated.mjs'")
];
const respond = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { userAgent: "fake" });
    return;
  }
  if (message.method === "hooks/list") {
    respond(message.id, { data: [{ cwd: home, hooks: hooks(), warnings: [], errors: [] }] });
    return;
  }
  if (message.method === "config/batchWrite") {
    const edit = message.params.edits[0];
    const keys = Object.keys(edit.value).sort();
    const expected = [sourcePath + ":stop:0:0", sourcePath + ":user_prompt_submit:0:0"].sort();
    const valid = edit.keyPath === "hooks.state" &&
      edit.mergeStrategy === "upsert" &&
      message.params.reloadUserConfig === true &&
      JSON.stringify(keys) === JSON.stringify(expected) &&
      edit.value[expected[0]].enabled === true &&
      edit.value[expected[1]].enabled === true &&
      new Set(keys.map((key) => edit.value[key].trusted_hash)).size === 2;
    if (!valid) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { message: "invalid trust write" } }) + "\n");
      return;
    }
    trusted = true;
    respond(message.id, {});
  }
});
`;
