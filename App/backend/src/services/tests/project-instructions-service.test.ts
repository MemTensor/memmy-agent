/** 本机项目的项目指令：按文件夹存、清空即删除。协作项目走自己的存储，不在这里。 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PROJECT_INSTRUCTIONS_CHARS } from "@memmy/local-api-contracts";
import {
  createProjectInstructionsService,
  projectInstructionsFilePath,
  type ProjectInstructionsService
} from "../project-instructions-service.js";

const DIRECTORY = "/Users/me/code/memmy";

describe("ProjectInstructionsService", () => {
  let root: string;
  let service: ProjectInstructionsService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "memmy-project-instructions-"));
    service = createProjectInstructionsService({
      memmyConfigPath: join(root, "config.yaml"),
      now: () => new Date("2026-10-24T12:00:00Z")
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps a local project's instructions, keyed by its folder", async () => {
    await expect(service.read(DIRECTORY)).resolves.toMatchObject({ text: "", origin: null });

    const saved = await service.saveLocal(DIRECTORY, "  前端代码遵循《前端代码规范》。  ");
    expect(saved).toEqual({
      text: "前端代码遵循《前端代码规范》。",
      origin: "local",
      cloudProjectId: null,
      updatedAt: "2026-10-24T12:00:00.000Z"
    });
    // 结尾分隔符不影响匹配：看板、Memmy 任务与其他 Agent 传进来的路径写法可能不同。
    await expect(service.read(`${DIRECTORY}/`)).resolves.toMatchObject({ text: "前端代码遵循《前端代码规范》。", origin: "local" });

    const file = JSON.parse(await readFile(projectInstructionsFilePath(join(root, "config.yaml")), "utf8"));
    expect(file).toEqual({
      version: 1,
      projects: {
        [DIRECTORY]: {
          text: "前端代码遵循《前端代码规范》。",
          origin: "local",
          cloudProjectId: null,
          updatedAt: "2026-10-24T12:00:00.000Z"
        }
      }
    });
  });

  it("removes the entry when the instructions are cleared, and rejects text over the limit", async () => {
    await service.saveLocal(DIRECTORY, "先写指令");
    await expect(service.saveLocal(DIRECTORY, "   ")).resolves.toMatchObject({ text: "", origin: null });
    await expect(service.read(DIRECTORY)).resolves.toMatchObject({ text: "" });
    expect((await service.snapshot()).projects).toEqual({});

    await expect(service.saveLocal(DIRECTORY, "字".repeat(MAX_PROJECT_INSTRUCTIONS_CHARS + 1)))
      .rejects.toThrow(`不超过 ${MAX_PROJECT_INSTRUCTIONS_CHARS} 字`);
  });

  it("serializes concurrent saves so the last one wins instead of merging halves", async () => {
    await Promise.all([
      service.saveLocal(DIRECTORY, "第一条"),
      service.saveLocal("/Users/me/code/other", "第二个项目的指令")
    ]);
    const file = await service.snapshot();
    expect(Object.keys(file.projects).sort()).toEqual([DIRECTORY, "/Users/me/code/other"].sort());
  });

  it("treats a corrupt file as no instructions instead of failing the task", async () => {
    const path = projectInstructionsFilePath(join(root, "config.yaml"));
    await writeFile(path, "{ not json", "utf8");
    await expect(service.read(DIRECTORY)).resolves.toMatchObject({ text: "" });
    // 下一次写入会重建文件。
    await service.saveLocal(DIRECTORY, "重建后的指令");
    expect((await service.snapshot()).projects[DIRECTORY]?.text).toBe("重建后的指令");
  });
});
