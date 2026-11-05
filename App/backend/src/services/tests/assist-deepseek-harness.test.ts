import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  deepSeekHarnessLaunch,
  readDefaultModel,
  resolveDeepSeekHarness
} from "../assist/deepseek-harness.js";
import { ASSIST_COMMAND_ENV } from "../assist/recipes.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-dsh-"));
  roots.push(root);
  return root;
}

/** 一个假的桌面版：只要 Contents/MacOS 里的可执行文件与 Contents/Resources/app.asar 在，就算桌面版存在。 */
function fakeAppBundle(root: string): string {
  const bundle = join(root, "Applications", "DeepSeek Harness.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  const executable = join(bundle, "Contents", "MacOS", "DeepSeek Harness");
  writeFileSync(executable, "#!/bin/sh\n");
  chmodSync(executable, 0o755);
  writeFileSync(join(bundle, "Contents", "Resources", "app.asar"), "fake asar");
  return bundle;
}

/** 一个只放 dsh 的 PATH 目录，dsh 的 --version 输出给定版本。 */
function fakeDsh(root: string, version: string): string {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const file = join(bin, "dsh");
  writeFileSync(file, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(file, 0o755);
  return bin;
}

/** 桌面版的补丁层：一条默认模型，外加一条 acp profile 里不存在的插件（应当被忽略）。 */
function writeDesktopPatch(dshHome: string, options: { model?: boolean } = {}): string {
  const directory = join(dshHome, "profiles", "desktop");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "cordis.patch.yml");
  const entries: unknown[] = [{ id: "ui-chat", config: { transcriptView: "standard" } }];
  if (options.model !== false) {
    entries.push({
      id: "agent-default-model",
      name: "@deepseek-ai/dsh-agent-default-model",
      config: { provider: "memtensor-api", model: "deepseek-v4.1-flash-1017", reasoningEffort: "medium" }
    });
  }
  writeFileSync(file, `# 桌面版的补丁层\n${stringifyYaml(entries)}`);
  return file;
}

describe("resolveDeepSeekHarness", () => {
  it("prefers the desktop app and runs its bundled dsh through the app itself", () => {
    const root = tempRoot();
    const bundle = fakeAppBundle(root);
    const resolution = resolveDeepSeekHarness({
      env: {},
      appDirs: [bundle],
      dshHome: join(root, "dsh")
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.via).toBe("desktop");
    // 桌面版自带完整的 dsh，但只有它自己的 Node 能读 asar：用应用本身当 Node 跑包内入口。
    expect(resolution.command).toBe(join(bundle, "Contents", "MacOS", "DeepSeek Harness"));
    expect(resolution.args).toEqual([
      join(bundle, "Contents", "Resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
    ]);
    expect(resolution.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("does not use a command line dsh that has no acp profile", () => {
    const root = tempRoot();
    const bin = fakeDsh(root, "0.1.0-rc.6");
    const resolution = resolveDeepSeekHarness({ env: { PATH: bin }, appDirs: [], dshHome: join(root, "dsh") });

    // 0.1.x 执行 --profile acp 会直接报 profile 不存在：当作不能运行，而不是让它失败在界面上。
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.reason).toContain("0.2.0");
  });

  it("uses a command line dsh that supports acp", () => {
    const root = tempRoot();
    const bin = fakeDsh(root, "0.2.1-rc.5");
    const resolution = resolveDeepSeekHarness({ env: { PATH: bin }, appDirs: [], dshHome: join(root, "dsh") });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.via).toBe("cli");
    expect(resolution.command).toBe(join(bin, "dsh"));
    expect(resolution.args).toEqual([]);
    expect(resolution.env).toEqual({});
  });

  it("treats a dsh whose version cannot be read as unsupported", () => {
    const root = tempRoot();
    const bin = join(root, "bin");
    mkdirSync(bin);
    const file = join(bin, "dsh");
    // 读版本失败（脚本报错，或它依赖的 node 不在 PATH 上）：不猜，按不支持处理。
    writeFileSync(file, "#!/bin/sh\nexit 1\n");
    chmodSync(file, 0o755);

    const resolution = resolveDeepSeekHarness({ env: { PATH: bin }, appDirs: [], dshHome: join(root, "dsh") });
    expect(resolution.ok).toBe(false);
  });

  it("keeps the command override in front of everything", () => {
    const root = tempRoot();
    const bundle = fakeAppBundle(root);
    const resolution = resolveDeepSeekHarness({
      env: { [ASSIST_COMMAND_ENV("deepseek_harness")]: "/custom/dsh --profile acp --patch /custom.yml" },
      appDirs: [bundle],
      dshHome: join(root, "dsh")
    });

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.via).toBe("override");
    expect(resolution.command).toBe("/custom/dsh");
    expect(resolution.args).toEqual(["--profile", "acp", "--patch", "/custom.yml"]);
  });
});

describe("deepSeekHarnessLaunch", () => {
  it("stacks the desktop patch layer and a generated acp model patch", () => {
    const root = tempRoot();
    const bundle = fakeAppBundle(root);
    const dshHome = join(root, "dsh");
    const desktopPatch = writeDesktopPatch(dshHome);
    const home = join(root, "memmy");

    const launch = deepSeekHarnessLaunch({ env: {}, appDirs: [bundle], dshHome, home });
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;

    const generated = join(home, "assist", "dsh-acp.patch.yml");
    expect(launch.args).toEqual([
      join(bundle, "Contents", "Resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      "--profile", "acp",
      "--patch", desktopPatch,
      "--patch", generated
    ]);
    // acp profile 自带官方模型、读不到桌面版的默认模型：生成一小段补丁把模型换成桌面版在用的那个。
    expect(parseYaml(readFileSync(generated, "utf8"))).toEqual([
      {
        id: "acp",
        name: "@deepseek-ai/dsh-acp",
        config: { provider: "memtensor-api", model: "deepseek-v4.1-flash-1017" }
      }
    ]);
  });

  it("only stacks the desktop patch layer when no default model is configured", () => {
    const root = tempRoot();
    const bundle = fakeAppBundle(root);
    const dshHome = join(root, "dsh");
    const desktopPatch = writeDesktopPatch(dshHome, { model: false });
    const home = join(root, "memmy");

    const launch = deepSeekHarnessLaunch({ env: {}, appDirs: [bundle], dshHome, home });
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;

    expect(launch.args.filter((arg) => arg === "--patch")).toHaveLength(1);
    expect(launch.args[launch.args.indexOf("--patch") + 1]).toBe(desktopPatch);
  });

  it("adds no patch at all when the machine has no desktop patch layer", () => {
    const root = tempRoot();
    const bin = fakeDsh(root, "0.2.1-rc.5");
    const launch = deepSeekHarnessLaunch({
      env: { PATH: bin },
      appDirs: [],
      dshHome: join(root, "dsh"),
      home: join(root, "memmy")
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.args).toEqual(["--profile", "acp"]);
  });

  it("leaves the override alone instead of adding profile arguments", () => {
    const root = tempRoot();
    const launch = deepSeekHarnessLaunch({
      env: { [ASSIST_COMMAND_ENV("deepseek_harness")]: "/custom/dsh acp" },
      appDirs: [fakeAppBundle(root)],
      dshHome: join(root, "dsh"),
      home: join(root, "memmy")
    });

    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.args).toEqual(["acp"]);
  });
});

describe("readDefaultModel", () => {
  it("reads the provider and model the person uses in the desktop app", () => {
    const root = tempRoot();
    expect(readDefaultModel(writeDesktopPatch(root))).toEqual({
      provider: "memtensor-api",
      model: "deepseek-v4.1-flash-1017"
    });
  });

  it("does not crash on js expressions the desktop patch allows", () => {
    const root = tempRoot();
    const file = join(root, "cordis.patch.yml");
    writeFileSync(file, [
      "- id: agent-default-model",
      "  config:",
      "    provider: !!js process.env.MEMMY_TEST_PROVIDER",
      "    model: deepseek-v4.1-flash-1017",
      ""
    ].join("\n"));
    // `!!js` 不求值，只当作字符串：读不到就用字符串本身，不够干净时退回 null。
    expect(readDefaultModel(file)).toEqual({ provider: "process.env.MEMMY_TEST_PROVIDER", model: "deepseek-v4.1-flash-1017" });
  });

  it("returns null for a missing or malformed file", () => {
    const root = tempRoot();
    expect(readDefaultModel(join(root, "missing.yml"))).toBeNull();
    const file = join(root, "broken.yml");
    writeFileSync(file, "- id: [\n");
    expect(readDefaultModel(file)).toBeNull();
  });
});
