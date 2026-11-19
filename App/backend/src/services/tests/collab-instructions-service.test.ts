/** 协作项目指令的本机缓存：按云端项目 id 存，范围按各 Agent 自己的会话单位记。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_COLLAB_INSTRUCTIONS_CHARS,
  emptyCollabInstructionsFile
} from "@memmy/local-api-contracts";
import {
  collabInstructionsFilePath,
  createCollabInstructionsService,
  migrateLegacyCollabInstructions,
  type CollabInstructionsService
} from "../collab-instructions-service.js";
import { instructionScopesFrom } from "../collab-instruction-scopes.js";

const DIRECTORY = "/Users/me/.memmy/local-projects/Memmy";

describe("CollabInstructionsService", () => {
  let root: string;
  let service: CollabInstructionsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memmy-collab-instructions-service-"));
    service = createCollabInstructionsService({
      memmyConfigPath: join(root, "config.yaml"),
      now: () => new Date("2026-10-28T12:00:00Z")
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a project's instructions with the agent units they cover", async () => {
    await expect(service.read("p-1")).resolves.toBeNull();

    await service.remember({
      projectId: "p-1",
      scopes: [
        { sourceId: "memmy", groupId: `${DIRECTORY}/` },
        { sourceId: "claude_code", groupId: "/Users/me/code/memmy" }
      ],
      text: "  本项目负责桌面端研发。  "
    });
    await expect(service.read("p-1")).resolves.toEqual({
      scopes: [
        { sourceId: "memmy", groupId: DIRECTORY, roots: [DIRECTORY] },
        { sourceId: "claude_code", groupId: "/Users/me/code/memmy", roots: ["/Users/me/code/memmy"] }
      ],
      text: "本项目负责桌面端研发。",
      updatedAt: "2026-10-28T12:00:00.000Z"
    });

    const file = JSON.parse(await readFile(collabInstructionsFilePath(join(root, "config.yaml")), "utf8"));
    expect(file.projects["p-1"].text).toBe("本项目负责桌面端研发。");
  });

  it("matches each agent by its own unit: folder, workspace, Codex project, and a single session", async () => {
    await service.remember({
      projectId: "p-1",
      scopes: [
        { sourceId: "claude_code", groupId: "/Users/me/code/memmy" },
        { sourceId: "cursor", groupId: "/Users/me/work/MemOS.code-workspace", roots: ["/Users/me/work/a", "/Users/me/work/b"] },
        { sourceId: "codex", groupId: "project-1", roots: ["/Users/me/src/api"] },
        { sourceId: "claude_code", groupId: "session-xyz" }
      ],
      text: "团队约定"
    });

    // Claude Code：目录及其子目录。
    await expect(service.forQuery({ sourceId: "claude_code", directory: "/Users/me/code/memmy/packages/app" }))
      .resolves.toEqual({ projectId: "p-1", text: "团队约定" });
    // Cursor：workspace 文件本身拿不到，但它的两个根覆盖到就命中。
    await expect(service.forQuery({ sourceId: "cursor", directory: "/Users/me/work/b/src" }))
      .resolves.toEqual({ projectId: "p-1", text: "团队约定" });
    // Codex：项目 id 命中，或项目登记的根命中。
    await expect(service.forQuery({ sourceId: "codex", groupId: "project-1", directory: "/Users/me/src/api" }))
      .resolves.toEqual({ projectId: "p-1", text: "团队约定" });
    // 单独关联的会话。
    await expect(service.forQuery({ sourceId: "claude_code", conversationId: "session-xyz", directory: "/elsewhere" }))
      .resolves.toEqual({ projectId: "p-1", text: "团队约定" });
    // 换了来源、或目录不在范围内，都不算命中。
    await expect(service.forQuery({ sourceId: "cursor", directory: "/Users/me/code/memmy" })).resolves.toBeNull();
    await expect(service.forQuery({ sourceId: "claude_code", directory: "/Users/me/other" })).resolves.toBeNull();
  });

  it("prefers an exact unit over a folder covered by a wider one", async () => {
    await service.remember({
      projectId: "outer",
      scopes: [{ sourceId: "claude_code", groupId: "/Users/me" }],
      text: "外层"
    });
    await service.remember({
      projectId: "inner",
      scopes: [{ sourceId: "claude_code", groupId: "/Users/me/code/memmy" }],
      text: "内层"
    });
    await expect(service.forQuery({ sourceId: "claude_code", directory: "/Users/me/code/memmy/app" }))
      .resolves.toEqual({ projectId: "inner", text: "内层" });
    await expect(service.forQuery({ sourceId: "claude_code", directory: "/Users/me/other" }))
      .resolves.toEqual({ projectId: "outer", text: "外层" });
  });

  it("keeps the entry and empties the text when the cloud clears it, and rejects text over the limit", async () => {
    const scopes = [{ sourceId: "claude_code", groupId: "/Users/me/code/memmy" }];
    await service.remember({ projectId: "p-1", scopes, text: "先写指令" });
    await service.remember({ projectId: "p-1", scopes, text: "   " });
    // 条目还在：这个目录仍然属于这个协作项目，只是没约定。
    await expect(service.read("p-1")).resolves.toMatchObject({ text: "" });
    expect(Object.keys((await service.snapshot()).projects)).toEqual(["p-1"]);

    await expect(service.remember({
      projectId: "p-1",
      scopes,
      text: "字".repeat(MAX_COLLAB_INSTRUCTIONS_CHARS + 1)
    })).rejects.toThrow(`不超过 ${MAX_COLLAB_INSTRUCTIONS_CHARS} 字`);
  });

  it("keeps the known scopes when a later save carries none, and never invents one", async () => {
    await service.remember({
      projectId: "p-1",
      scopes: [{ sourceId: "claude_code", groupId: "/Users/me/code/memmy" }],
      text: "旧指令"
    });
    await service.remember({ projectId: "p-1", scopes: [], text: "新指令" });
    await expect(service.read("p-1")).resolves.toMatchObject({ text: "新指令" });
    // 从来没有范围就没有可生效的地方：这时不能凭空造一个。
    await service.remember({ projectId: "p-2", scopes: [], text: "没有范围" });
    await expect(service.read("p-2")).resolves.toBeNull();
  });

  it("creates an entry from scopes alone, then fills in the project name and members", async () => {
    const scopes = [{ sourceId: "memmy", groupId: "/Users/me/.memmy/local-projects/MemOS" }];
    // 关联发生了但还没同步到项目名：条目也要先建出来。
    await service.updateScopes("p-1", scopes);
    await expect(service.read("p-1")).resolves.toMatchObject({ text: "" });
    expect((await service.read("p-1"))?.name).toBeUndefined();
    await expect(service.forQuery({ sourceId: "memmy", directory: "/Users/me/.memmy/local-projects/MemOS/sub" }))
      .resolves.toBeNull();

    await service.remember({
      projectId: "p-1",
      scopes,
      text: "",
      name: "  MemOS\n 实验室 ",
      members: ["孙起", " 张三 ", "孙起"]
    });
    await expect(service.read("p-1")).resolves.toMatchObject({
      name: "MemOS 实验室",
      members: ["孙起", "张三"],
      text: ""
    });
  });

  it("refreshes the project name and members without touching the rules", async () => {
    await service.remember({
      projectId: "p-1",
      scopes: [{ sourceId: "claude_code", groupId: "/a" }],
      text: "团队约定",
      name: "旧名字"
    });
    await service.updateProjectInfo("p-1", { name: "新名字", members: ["孙起"] });
    await expect(service.read("p-1")).resolves.toMatchObject({ name: "新名字", members: ["孙起"], text: "团队约定" });
    // 没传的字段保留上一次的值。
    await service.updateProjectInfo("p-1", { name: "更新的名字" });
    await expect(service.read("p-1")).resolves.toMatchObject({ name: "更新的名字", members: ["孙起"] });
    // 没有条目就不建：条目代表本机关联了这个项目。
    await service.updateProjectInfo("p-2", { name: "不认识的项目" });
    await expect(service.read("p-2")).resolves.toBeNull();
  });

  it("does not rewrite the file when nothing changed", async () => {
    const scopes = [{ sourceId: "claude_code", groupId: "/Users/me/code/memmy" }];
    const save = () => service.remember({ projectId: "p-1", scopes, text: "团队约定", name: "MemOS", members: ["孙起"] });
    await save();
    const first = (await service.read("p-1"))?.updatedAt;
    // 时间推进后再写一次同样的内容：内容没变就不落盘，updatedAt 也不动。
    await new Promise((resolve) => setTimeout(resolve, 5));
    await save();
    await service.updateScopes("p-1", scopes);
    await service.updateProjectInfo("p-1", { name: "MemOS", members: ["孙起"] });
    await expect(service.read("p-1")).resolves.toMatchObject({ updatedAt: first, name: "MemOS", members: ["孙起"] });
  });

  it("updates the scopes when associations change, without touching the text", async () => {
    await service.remember({
      projectId: "p-1",
      scopes: [{ sourceId: "claude_code", groupId: "/Users/me/code/memmy" }],
      text: "团队约定"
    });
    await service.updateScopes("p-1", [
      { sourceId: "claude_code", groupId: "/Users/me/code/memmy" },
      { sourceId: "codex", groupId: "project-2", roots: ["/Users/me/src/api"] }
    ]);
    await expect(service.read("p-1")).resolves.toMatchObject({ text: "团队约定" });
    await expect(service.forQuery({ sourceId: "codex", directory: "/Users/me/src/api/packages/x" }))
      .resolves.toEqual({ projectId: "p-1", text: "团队约定" });
  });

  it("forgets a project entirely", async () => {
    await service.remember({ projectId: "p-1", scopes: [{ sourceId: "claude_code", groupId: "/a" }], text: "要走人的项目" });
    await service.remember({ projectId: "p-2", scopes: [{ sourceId: "claude_code", groupId: "/b" }], text: "还在的项目" });
    // 没有背景与规范的条目也一并清掉。
    await service.updateScopes("p-3", [{ sourceId: "claude_code", groupId: "/c" }]);
    await service.forget("p-1");
    await expect(service.read("p-1")).resolves.toBeNull();
    await expect(service.read("p-2")).resolves.toMatchObject({ text: "还在的项目" });
    await service.forget("p-3");
    await expect(service.read("p-3")).resolves.toBeNull();
  });

  it("serializes concurrent writes instead of merging halves", async () => {
    await Promise.all([
      service.remember({ projectId: "p-1", scopes: [{ sourceId: "claude_code", groupId: "/a" }], text: "第一条" }),
      service.remember({ projectId: "p-2", scopes: [{ sourceId: "claude_code", groupId: "/b" }], text: "第二个项目" })
    ]);
    const file = await service.snapshot();
    expect(Object.keys(file.projects).sort()).toEqual(["p-1", "p-2"]);
  });

  it("treats a corrupt file as no instructions instead of failing the task", async () => {
    const path = collabInstructionsFilePath(join(root, "config.yaml"));
    await writeFile(path, "{ not json", "utf8");
    await expect(service.read("p-1")).resolves.toBeNull();
    await service.remember({ projectId: "p-1", scopes: [{ sourceId: "claude_code", groupId: "/a" }], text: "重建后的指令" });
    expect((await service.snapshot()).projects["p-1"]?.text).toBe("重建后的指令");
  });
});

describe("instructionScopesFrom", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memmy-instruction-scopes-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the agent's own unit and adds the folders it covers", async () => {
    const workspace = join(root, "MemOS.code-workspace");
    await writeFile(workspace, JSON.stringify({ folders: [{ path: "a" }, { path: "/abs/b" }] }), "utf8");

    const scopes = instructionScopesFrom({
      workingDirectory: "/Users/me/.memmy/local-projects/MemOS",
      groups: [
        { sourceId: "claude_code", groupId: "/Users/me/code/memmy" },
        { sourceId: "cursor", groupId: workspace },
        { sourceId: "codex", groupId: "01a17657-0cd5-7be0-a611-3fdcd387e8ae" }
      ],
      sessions: [{ sourceId: "claude_code", conversationId: "session-1" }]
    }, { codexHome: join(root, "codex-missing") });

    // Memmy 自己的项目目录。
    expect(scopes[0]).toEqual({ sourceId: "memmy", groupId: "/Users/me/.memmy/local-projects/MemOS", roots: ["/Users/me/.memmy/local-projects/MemOS"] });
    // Claude Code 的目录单位。
    expect(scopes[1]).toEqual({ sourceId: "claude_code", groupId: "/Users/me/code/memmy", roots: ["/Users/me/code/memmy"] });
    // Cursor 的 workspace：单位保留文件，根目录展开出来。
    expect(scopes[2].sourceId).toBe("cursor");
    expect(scopes[2].groupId).toBe(workspace);
    expect(scopes[2].roots).toEqual([join(root, "a"), "/abs/b"]);
    // Codex 的项目：找不到状态库时保留项目 id，没有根可兜底。
    expect(scopes[3]).toEqual({ sourceId: "codex", groupId: "01a17657-0cd5-7be0-a611-3fdcd387e8ae" });
    // 单独关联的会话。
    expect(scopes[4]).toEqual({ sourceId: "claude_code", groupId: "session-1" });
  });
});

describe("migrateLegacyCollabInstructions", () => {
  let root: string;
  let service: CollabInstructionsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memmy-collab-instructions-migrate-"));
    service = createCollabInstructionsService({ filePath: join(root, "collab-project-instructions.json") });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("moves cloud entries out of the local file and clears the old copies", async () => {
    const forgotten: string[] = [];
    const moved = await migrateLegacyCollabInstructions({
      collabInstructions: service,
      legacyEntries: [
        { directory: DIRECTORY, text: "老版本镜像的指令", cloudProjectId: "p-1" },
        { directory: "/Users/me/code/no-project", text: "没有云端 id 的条目", cloudProjectId: null }
      ],
      forgetLegacy: async (directory) => {
        forgotten.push(directory);
      }
    });

    expect(moved).toBe(1);
    // 老数据只有目录：Memmy 的会话与该目录里的其他 Agent 都能命中。
    await expect(service.forQuery({ sourceId: "memmy", directory: DIRECTORY }))
      .resolves.toEqual({ projectId: "p-1", text: "老版本镜像的指令" });
    await expect(service.forQuery({ sourceId: "claude_code", directory: `${DIRECTORY}/sub` }))
      .resolves.toEqual({ projectId: "p-1", text: "老版本镜像的指令" });
    expect(forgotten).toEqual([DIRECTORY]);
  });

  it("does not overwrite a project the member already synced", async () => {
    await service.remember({ projectId: "p-1", scopes: [{ sourceId: "claude_code", groupId: "/new" }], text: "成员已同步的新指令" });
    const forgotten: string[] = [];
    const moved = await migrateLegacyCollabInstructions({
      collabInstructions: service,
      legacyEntries: [{ directory: DIRECTORY, text: "老版本的旧指令", cloudProjectId: "p-1" }],
      forgetLegacy: async (directory) => {
        forgotten.push(directory);
      }
    });

    expect(moved).toBe(0);
    await expect(service.read("p-1")).resolves.toMatchObject({ text: "成员已同步的新指令" });
    expect(forgotten).toEqual([DIRECTORY]);
  });

  it("keeps the file empty when there is nothing to migrate", async () => {
    await expect(migrateLegacyCollabInstructions({
      collabInstructions: service,
      legacyEntries: [],
      forgetLegacy: async () => undefined
    })).resolves.toBe(0);
    expect(await service.snapshot()).toEqual(emptyCollabInstructionsFile());
  });
});
