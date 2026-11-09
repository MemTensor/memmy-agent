import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCursorSkillTarget } from "../cursor/index.js";
import { createClaudeCodeSkillTarget } from "../claude-code/index.js";
import { createCodexSkillTarget } from "../codex/index.js";
import { createOpencodeSkillTarget } from "../opencode/index.js";
import { createOpenclawSkillTarget } from "../openclaw/index.js";
import { createHermesSkillTarget } from "../hermes/index.js";
import { createDeepseekHarnessSkillTarget } from "../deepseek-harness/index.js";
import { createWorkbuddySkillTarget } from "../workbuddy/index.js";
import { createPiSkillTarget } from "../pi/index.js";
import { createQwenworkSkillTarget } from "../qwenwork/index.js";
import { readSkillInstallationState } from "../skill-directory.js";
import { renderMemmyDefaultSkillManifest } from "../templates/memmy-default.js";
import type { SkillTarget } from "../types.js";

const isolated = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await vi.importActual<typeof import("node:os")>("node:os");
  const path = await import("node:path");
  return { home: fs.mkdtempSync(path.join(os.tmpdir(), "pr780-target-marker-home-")) };
});
vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => isolated.home
}));

const factories = {
  cursor: createCursorSkillTarget,
  claude_code: createClaudeCodeSkillTarget,
  codex: createCodexSkillTarget,
  opencode: createOpencodeSkillTarget,
  openclaw: createOpenclawSkillTarget,
  hermes: createHermesSkillTarget,
  deepseek_harness: createDeepseekHarnessSkillTarget,
  workbuddy: createWorkbuddySkillTarget,
  pi: createPiSkillTarget,
  qwenwork: createQwenworkSkillTarget
};
type TargetId = keyof typeof factories;
let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "pr780-target-marker-matrix-"));
  vi.stubEnv("MEMMY_HOME", join(isolated.home, ".memmy"));
  expect(homedir()).toBe(isolated.home);
});
afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(isolated.home, { recursive: true, force: true }));

function fixture(sourceId: TargetId) {
  const rootDirectory = join(fixtureRoot, sourceId);
  mkdirSync(rootDirectory, { recursive: true });
  const memmyConfigPath = join(fixtureRoot, "memmy-config.yaml");
  writeFileSync(memmyConfigPath, "{}");
  const deps = {
    rootDirectory,
    memmyConfigPath,
    workspaceDirectory: join(rootDirectory, "workspace"),
    configPath: join(rootDirectory, "openclaw.json"),
    trustHooks: async () => {}
  };
  const target: SkillTarget = factories[sourceId](deps);
  const nativeFile = sourceId === "hermes" ? "config.yaml"
    : sourceId === "claude_code" ? "settings.json"
    : sourceId === "codex" || sourceId === "cursor" ? "hooks.json"
    : sourceId === "openclaw" ? "openclaw.json" : "opencode.json";
  const nativeConfigPath = join(rootDirectory, nativeFile);
  writeFileSync(nativeConfigPath, JSON.stringify({ unrelated: { retained: true } }));
  const otherSkill = join(rootDirectory, "skills", "other-skill", "SKILL.md");
  mkdirSync(join(otherSkill, ".."), { recursive: true });
  writeFileSync(otherSkill, "Other Skill remains.\n");
  return { rootDirectory, target, nativeConfigPath, otherSkill };
}

function assertUnrelatedFiles(h: ReturnType<typeof fixture>) {
  expect(YAML.parse(readFileSync(h.nativeConfigPath, "utf8"))).toMatchObject({ unrelated: { retained: true } });
  expect(readFileSync(h.otherSkill, "utf8")).toBe("Other Skill remains.\n");
}

const markdownFiles = [
  ["codex", "AGENTS.md"],
  ["claude_code", "CLAUDE.md"],
  ["claude_code", "claude.md"],
  ["opencode", "AGENTS.md"],
  ["openclaw", "workspace/AGENTS.md"],
  ["hermes", "SOUL.md"],
  ["hermes", "AGENTS.md"]
] as const;
const markers = [
  ["current", "<!-- memmy:start v=1 -->", "<!-- memmy:end v=1 -->"],
  ["legacy", "<!-- memmy-memory cli : start -->", "<!-- memmy-memory cli : end -->"]
] as const;

describe("recognized Markdown instruction removal matrix", () => {
  for (const kind of ["skill", "plugin"] as const) {
    for (const newline of ["\n", "\r\n"]) {
      for (const [format, start, end] of markers) {
        it.each(markdownFiles)(`removes duplicate ${format} ${newline === "\n" ? "LF" : "CRLF"} blocks from %s %s through ${kind}`, async (sourceId, fileName) => {
          const h = fixture(sourceId);
          const filePath = join(h.rootDirectory, fileName);
          mkdirSync(join(filePath, ".."), { recursive: true });
          const block = `${start}${newline}Memmy managed instructions.${newline}${end}${newline}`;
          const outside = `User prefix.${newline}User suffix.${newline}`;
          writeFileSync(filePath, `User prefix.${newline}${block}${block}User suffix.${newline}`);
          const before = await readSkillInstallationState(h.target, sourceId);
          expect(before.skillInstalled).toBe(true);
          const remove = () => kind === "plugin" ? h.target.uninstallPlugin!(sourceId) : h.target.uninstall(sourceId);
          await remove();
          expect(readFileSync(filePath, "utf8")).toBe(outside);
          expect((await readSkillInstallationState(h.target, sourceId)).skillInstalled).toBe(false);
          await remove();
          expect(readFileSync(filePath, "utf8")).toBe(outside);
          assertUnrelatedFiles(h);
        });
      }
    }
  }
});

describe("Claude and Codex plugin migration clears legacy CLI instructions", () => {
  for (const kind of ["skill", "plugin"] as const) {
    for (const newline of ["\n", "\r\n"]) {
      it.each(markdownFiles.slice(0, 3))(`upgrades %s %s duplicate legacy blocks through ${kind} with ${newline === "\n" ? "LF" : "CRLF"}`, async (sourceId, fileName) => {
        const h = fixture(sourceId);
        const filePath = join(h.rootDirectory, fileName);
        const old = `<!-- memmy-memory cli : start -->${newline}Old CLI instructions.${newline}<!-- memmy-memory cli : end -->${newline}`;
        writeFileSync(filePath, `User prefix.${newline}${old}${old}User suffix.${newline}`);
        if (kind === "plugin") await h.target.installPlugin!(sourceId);
        else await h.target.install(renderMemmyDefaultSkillManifest(sourceId));
        const currentPath = join(h.rootDirectory, sourceId === "claude_code" ? "CLAUDE.md" : "AGENTS.md");
        expect(readFileSync(currentPath, "utf8")).not.toContain("<!-- memmy-memory cli : start -->");
        expect(readFileSync(filePath, "utf8")).not.toContain("<!-- memmy-memory cli : start -->");
        expect((await readSkillInstallationState(h.target, sourceId)).skillInstalled).toBe(true);
        if (kind === "plugin") await h.target.uninstallPlugin!(sourceId);
        else await h.target.uninstall(sourceId);
        expect(readFileSync(filePath, "utf8")).toBe(`User prefix.${newline}User suffix.${newline}`);
        assertUnrelatedFiles(h);
      });
    }
  }
});

describe("directory-backed Skill removal covers every official target", () => {
  it.each(Object.keys(factories) as TargetId[])("removes %s Skill directories while retaining other files", async (sourceId) => {
    const h = fixture(sourceId);
    await h.target.install(renderMemmyDefaultSkillManifest(sourceId));
    expect((await readSkillInstallationState(h.target, sourceId)).skillInstalled).toBe(true);
    await h.target.uninstall(sourceId);
    expect((await readSkillInstallationState(h.target, sourceId)).skillInstalled).toBe(false);
    expect(existsSync(join(h.rootDirectory, "skills", "memmy-memory"))).toBe(false);
    await h.target.uninstall(sourceId);
    assertUnrelatedFiles(h);
  });
});

describe("native plugin removal preserves unrelated configuration", () => {
  it.each(["cursor", "claude_code", "codex", "opencode", "openclaw", "hermes", "deepseek_harness"] as const)("removes recognized %s native plugin files and bindings", async (sourceId) => {
    const h = fixture(sourceId);
    if (sourceId === "cursor" || sourceId === "codex" || sourceId === "claude_code") {
      const directory = join(h.rootDirectory, "hooks");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "memmy-resume-hook.mjs"), "current managed hook");
      writeFileSync(join(directory, "memmy-memory-resume-hook.mjs"), "legacy managed hook");
      const managed = { type: "command", command: "node memmy-memory-resume-hook.mjs" };
      const other = { type: "command", command: "echo keep-other-hook" };
      const entries = sourceId === "cursor" ? [managed, other] : [{ hooks: [managed, other] }];
      const event = sourceId === "cursor" ? "sessionStart" : "SessionStart";
      writeFileSync(h.nativeConfigPath, JSON.stringify({ unrelated: { retained: true }, hooks: { [event]: entries } }));
    } else if (sourceId === "opencode") {
      mkdirSync(join(h.rootDirectory, "plugins"), { recursive: true });
      writeFileSync(join(h.rootDirectory, "plugins", "memmy-memory.js"), "legacy plugin");
    } else if (sourceId === "openclaw") {
      mkdirSync(join(h.rootDirectory, "extensions", "memmy-memory"), { recursive: true });
      writeFileSync(join(h.rootDirectory, "extensions", "memmy-memory", "index.mjs"), "legacy plugin");
      writeFileSync(h.nativeConfigPath, JSON.stringify({ unrelated: { retained: true }, plugins: {
        entries: { "memmy-memory": { enabled: true }, "other-plugin": { enabled: true } },
        installs: { "memmy-memory": { source: "path" }, "other-plugin": { source: "registry" } }
      } }));
    } else if (sourceId === "hermes") {
      for (const name of ["memmy-memory", "memmy-resume", "memmy-memory-command"]) {
        mkdirSync(join(h.rootDirectory, "plugins", name), { recursive: true });
        writeFileSync(join(h.rootDirectory, "plugins", name, "plugin.yaml"), "old plugin");
      }
      writeFileSync(h.nativeConfigPath, JSON.stringify({ unrelated: { retained: true }, memory: { provider: "memmy-memory" },
        plugins: { enabled: ["memmy-memory", "memmy-resume", "memmy-memory-command", "other-plugin"] } }));
    } else {
      const directory = join(h.rootDirectory, "profiles", "node_modules", "@memmy", "memmy-memory");
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "index.mjs"), "old plugin");
      const block = "# memmy-memory plugin:start\n- insert:\n    - name: '@memmy/memmy-memory'\n# memmy-memory plugin:end\n";
      writeFileSync(join(h.rootDirectory, "cordis.patch.yml"), `- insert:\n    - name: other-plugin\n${block}${block.replaceAll("\n", "\r\n")}`);
    }
    expect(await h.target.isPluginInstalled!()).toBe(true);
    await h.target.uninstallPlugin!(sourceId);
    expect(await h.target.isPluginInstalled!()).toBe(false);
    await h.target.uninstallPlugin!(sourceId);
    assertUnrelatedFiles(h);
    if (sourceId === "cursor" || sourceId === "codex" || sourceId === "claude_code") {
      expect(readFileSync(h.nativeConfigPath, "utf8")).toContain("keep-other-hook");
    } else if (sourceId === "openclaw" || sourceId === "hermes") {
      expect(readFileSync(h.nativeConfigPath, "utf8")).toContain("other-plugin");
    } else if (sourceId === "deepseek_harness") {
      expect(readFileSync(join(h.rootDirectory, "cordis.patch.yml"), "utf8")).toContain("name: other-plugin");
    }
  });
});
