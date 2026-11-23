// Regression: injected failures and user saves at commit boundaries. All fixtures are temporary.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { syncBuiltinESMExports } from "node:module";
const mode = process.argv[2];
const sandbox = await fs.mkdtemp(join(os.tmpdir(), "pr769-independent-"));
os.homedir = () => sandbox;
syncBuiltinESMExports();
const original = { rename: fs.rename, rm: fs.rm, readFile: fs.readFile };
const factories = [
  ["Backend", "App/backend/src/adapters/outbound/skill-writer/codex/target.ts"],
  ["Memory", "Memory/src/agent-source/integration/codex/target.ts"]
];
let failures = 0;
try {
  for (const [side, relative] of factories) {
    const { createCodexSkillTarget } = await import(pathToFileURL(join(process.cwd(), relative)));
    const root = join(sandbox, side);
    await fs.mkdir(join(root, "skills", "memmy-memory"), { recursive: true });
    const skill = join(root, "skills", "memmy-memory", "SKILL.md");
    const agents = join(root, "AGENTS.md");
    const config = join(root, "hooks", "memmy-memory-config.json");
    await fs.writeFile(skill, "previous skill");
    await fs.writeFile(agents, "personal before\n");
    let injected = false, configWritten = false, failure;
    fs.rename = async (from, to) => {
      await original.rename(from, to);
      if (to === config) configWritten = true;
      if (mode === "record-edit" && to === agents && !injected) {
        injected = true;
        await fs.appendFile(agents, "personal saved after install write\n");
      }
    };
    fs.readFile = async (path, ...args) => {
      if ((mode === "record-failure" || mode === "persistent-read-failure") && path === config && configWritten && (!injected || mode === "persistent-read-failure")) {
        injected = true;
        throw Object.assign(new Error("one-shot snapshot read EIO"), { code: "EIO" });
      }
      if (mode === "stage-failure" && String(path).includes(".memmy-memory-config.json.") && !injected) {
        injected = true;
        throw Object.assign(new Error("staged snapshot EIO"), { code: "EIO" });
      }
      return original.readFile(path, ...args);
    };
    fs.rm = async (path, ...args) => {
      if (mode === "cleanup-failure" && String(path).includes(".memmy-memory.old.")
          && !injected && await fs.stat(path).then(() => true, () => false)) {
        injected = true;
        throw Object.assign(new Error("one-shot old directory cleanup EBUSY"), { code: "EBUSY" });
      }
      return original.rm(path, ...args);
    };
    syncBuiltinESMExports();
    try {
      await createCodexSkillTarget({ rootDirectory: root, memmyConfigPath: join(root, "fixture.yaml"),
        trustHooks: async () => { throw new Error("controlled trust failure"); }
      }).installPlugin("codex");
    } catch (error) { failure = error; }
    Object.assign(fs, original); syncBuiltinESMExports();
    const outcome = {
      mode, side, injected, error: failure?.message,
      configRemains: await fs.stat(config).then(() => true, () => false),
      skillRestored: await fs.readFile(skill, "utf8") === "previous skill",
      personalEditPreserved: (await fs.readFile(agents, "utf8")).includes("personal saved after install write")
    };
    console.log(JSON.stringify(outcome));
    try {
      assert.ok(failure, "install must fail");
      if (mode === "persistent-read-failure") {
        assert.equal(outcome.configRemains, true, "unreadable committed path must be preserved");
        assert.match(failure.message, /rollback/);
      }
      if (mode === "stage-failure") assert.equal(outcome.configRemains, false, "failed staging must never publish a file");
      if (mode === "record-failure") assert.equal(outcome.configRemains, false, "failed install must remove newly written config even when record fails");
      if (mode === "cleanup-failure") assert.equal(outcome.skillRestored, true, "must restore old skill after post-replacement cleanup fails");
      if (mode === "record-edit") assert.equal(outcome.personalEditPreserved, true, "must not adopt the user edit between write and record");
    } catch (error) { failures++; console.error(error.message); }
  }
} finally {
  Object.assign(fs, original); syncBuiltinESMExports();
  await fs.rm(sandbox, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
