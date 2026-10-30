/** 协作项目指令注入：按云端项目 id 存、按工作目录覆盖匹配，与本机项目指令各占一段。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import {
  createCollabInstructionsHook,
  createCollabInstructionsSource,
  renderCollabInstructionsSection
} from "../../../src/collab-instructions/index.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-collab-instructions-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeCollab(root: string, projects: Record<string, unknown>): string {
  const file = path.join(root, "collab-project-instructions.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects }), "utf8");
  return file;
}

function writeLocal(root: string, projects: Record<string, unknown>): string {
  const file = path.join(root, "project-instructions.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects }), "utf8");
  return file;
}

/** 协作项目的指令条目：范围记的是 Agent 自己的单位，Memmy 任务的单位就是项目的工作目录。 */
function collabEntry(directory: string, text: string, sourceId = "memmy") {
  return { scopes: [{ sourceId, groupId: directory, roots: [directory] }], text, updatedAt: "2026-10-28T12:00:00.000Z" };
}

function localEntry(text: string) {
  return { text, origin: "local", cloudProjectId: null, updatedAt: "2026-10-28T12:00:00.000Z" };
}

describe("collab project instructions", () => {
  it("reads the instructions of the project the workspace belongs to, including its subdirectories", () => {
    const root = tempRoot();
    const project = path.join(root, "MemOS");
    const file = writeCollab(root, {
      "p-1": collabEntry(project, "团队约定：先看 PRD。"),
      "p-2": collabEntry(path.join(root, "other"), "另一个协作项目的指令")
    });

    const source = createCollabInstructionsSource({ filePath: file });
    expect(source.forDirectory(project)).toEqual({ projectId: "p-1", text: "团队约定：先看 PRD。" });
    // 协作项目的任务可能跑在子目录里：目录覆盖判断，而不是精确相等。
    expect(source.forDirectory(path.join(project, "packages", "app"))).toEqual({ projectId: "p-1", text: "团队约定：先看 PRD。" });
    expect(source.forDirectory(path.join(root, "other"))).toEqual({ projectId: "p-2", text: "另一个协作项目的指令" });
    expect(source.forDirectory(path.join(root, "none"))).toBeNull();
    expect(source.forDirectory(null)).toBeNull();
  });

  it("never matches a folder that merely shares a name prefix", () => {
    const root = tempRoot();
    const file = writeCollab(root, { "p-1": collabEntry(path.join(root, "MemOS"), "团队约定") });
    const source = createCollabInstructionsSource({ filePath: file });
    expect(source.forDirectory(path.join(root, "MemOS-other"))).toBeNull();
  });

  it("treats a missing or corrupt file as no instructions", () => {
    const root = tempRoot();
    const file = path.join(root, "collab-project-instructions.json");
    expect(createCollabInstructionsSource({ filePath: file }).forDirectory(root)).toBeNull();

    fs.writeFileSync(file, "{ not json", "utf8");
    expect(createCollabInstructionsSource({ filePath: file }).forDirectory(root)).toBeNull();
  });

  it("picks up an edit without restarting", () => {
    const root = tempRoot();
    const file = writeCollab(root, { "p-1": collabEntry(root, "第一条") });
    const source = createCollabInstructionsSource({ filePath: file });
    expect(source.forDirectory(root)?.text).toBe("第一条");

    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { "p-1": collabEntry(root, "第二条") } }), "utf8");
    expect(source.forDirectory(root)?.text).toBe("第二条");
  });

  it("renders its own section with the project id", () => {
    const section = renderCollabInstructionsSection({ projectId: "p-1", text: "团队约定" });
    expect(section).toContain("# 协作项目指令");
    expect(section).toContain('<collab_project_instructions project="p-1">\n团队约定\n</collab_project_instructions>');
  });

  it("does not leak the collab instructions into a folder outside the project", () => {
    const root = tempRoot();
    const project = path.join(root, "MemOS");
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(project);
    fs.mkdirSync(standalone);
    const collab = writeCollab(root, { "p-1": collabEntry(project, "团队约定：先看 PRD。") });

    const prompt = new ContextBuilder({ workspace: standalone }).buildSystemPrompt(
      null,
      null,
      null,
      createCollabInstructionsHook(createCollabInstructionsSource({ filePath: collab })),
      null,
      "webui:session-2",
      false,
      standalone
    );
    expect(prompt).not.toContain("collab_project_instructions");
    expect(prompt).not.toContain("团队约定");
  });

  it("keeps both sections in a real task's prompt, the local rules first and the collab rules after them", () => {
    const root = tempRoot();
    const project = path.join(root, "MemOS");
    const subdirectory = path.join(project, "packages", "app");
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(subdirectory, { recursive: true });
    fs.mkdirSync(standalone);
    writeLocal(root, { [project]: localEntry("本机约定：提交信息用英文。") });
    writeCollab(root, { "p-1": collabEntry(project, "团队约定：先看 PRD。") });
    // 两个钩子都按 Memmy 配置文件的位置找各自的文件：任务运行时就是这么定位的。
    vi.stubEnv("MEMMY_CONFIG", path.join(root, "config.yaml"));

    const loop = new AgentLoop({
      config: new Config({ fileMemory: { enabled: false } }),
      provider: { generation: {}, getDefaultModel: () => "test-model" },
      workspace: root,
      model: "test-model"
    });
    const promptOf = (sessionWorkspace: string) => loop.context.buildMessages({
      currentMessage: "处理一下分享弹窗",
      channel: "websocket",
      sessionKey: "webui:session-1",
      sessionWorkspace,
      hook: loop.lifecycleHook()
    })[0]?.content as string;

    const inProject = promptOf(subdirectory);
    // 本机指令按文件夹精确匹配，跑在子目录的任务拿不到；协作指令按目录覆盖匹配，拿得到。
    expect(inProject).toContain('<collab_project_instructions project="p-1">\n团队约定：先看 PRD。\n</collab_project_instructions>');
    expect(inProject).not.toContain("本机约定");

    const atRoot = promptOf(project);
    expect(atRoot).toContain("<project_instructions>\n本机约定：提交信息用英文。\n</project_instructions>");
    expect(atRoot).toContain("<collab_project_instructions");
    // 两段并存：本机约定在前，团队约定在后，谁也不覆盖谁。
    expect(atRoot.indexOf("# 项目指令")).toBeLessThan(atRoot.indexOf("# 协作项目指令"));

    expect(promptOf(standalone)).not.toContain("团队约定");
  });
});
