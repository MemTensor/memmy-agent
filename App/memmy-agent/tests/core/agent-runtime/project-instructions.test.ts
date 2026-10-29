/** 项目指令注入：项目目录里的 Memmy 任务带上该项目的指令，其他目录不受影响。 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import {
  createProjectInstructionsHook,
  createProjectInstructionsSource,
  renderProjectInstructionsSection
} from "../../../src/project-instructions/index.js";

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-project-instructions-"));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeInstructions(root: string, projects: Record<string, unknown>): string {
  const file = path.join(root, "project-instructions.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, projects }), "utf8");
  return file;
}

function entry(text: string, origin: "local" | "cloud" = "local") {
  return { text, origin, cloudProjectId: null, updatedAt: "2026-10-24T12:00:00.000Z" };
}

describe("project instructions", () => {
  it("reads the instructions of the workspace and ignores other folders", () => {
    const root = tempRoot();
    const project = path.join(root, "memmy");
    fs.mkdirSync(project);
    const file = writeInstructions(root, {
      [project]: entry("前端代码遵循《前端代码规范》。"),
      [path.join(root, "other")]: entry("另一个项目的指令")
    });

    const source = createProjectInstructionsSource({ filePath: file });
    expect(source.textFor(project)).toBe("前端代码遵循《前端代码规范》。");
    // 尾巴上的分隔符不影响匹配：路径来自不同进程，写法可能不同。
    expect(source.textFor(`${project}/`)).toBe("前端代码遵循《前端代码规范》。");
    expect(source.textFor(path.join(root, "other"))).toBe("另一个项目的指令");
    expect(source.textFor(path.join(root, "none"))).toBe("");
    expect(source.textFor(null)).toBe("");
  });

  it("treats a missing or corrupt file as no instructions", () => {
    const root = tempRoot();
    const file = path.join(root, "project-instructions.json");
    const source = createProjectInstructionsSource({ filePath: file });
    expect(source.textFor(root)).toBe("");

    fs.writeFileSync(file, "{ not json", "utf8");
    expect(source.textFor(root)).toBe("");
  });

  it("picks up an edit without restarting, because the file is re-read when it changes", () => {
    const root = tempRoot();
    const file = writeInstructions(root, { [root]: entry("第一条") });
    const source = createProjectInstructionsSource({ filePath: file });
    expect(source.textFor(root)).toBe("第一条");

    // 保存后对此后开始的会话生效：新的一段提示词会读到新内容。
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: { [root]: entry("第二条") } }), "utf8");
    expect(source.textFor(root)).toBe("第二条");
  });

  it("adds the section to the system prompt after the project's own bootstrap files", () => {
    const root = tempRoot();
    const project = path.join(root, "memmy");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# 项目规则\n\n先看 README。", "utf8");
    const file = writeInstructions(root, { [project]: entry("前端代码遵循《前端代码规范》。") });

    const builder = new ContextBuilder({ workspace: project });
    const prompt = builder.buildSystemPrompt(
      null,
      null,
      null,
      createProjectInstructionsHook(createProjectInstructionsSource({ filePath: file })),
      null,
      "webui:session-1",
      false,
      project
    );
    expect(prompt).toContain("<project_instructions>\n前端代码遵循《前端代码规范》。\n</project_instructions>");
    expect(prompt.indexOf("AGENTS.md")).toBeLessThan(prompt.indexOf("# 项目指令"));
  });

  it("leaves a session outside any project alone", () => {
    const root = tempRoot();
    const project = path.join(root, "memmy");
    fs.mkdirSync(project);
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(standalone);
    const file = writeInstructions(root, { [project]: entry("前端代码遵循《前端代码规范》。") });

    const prompt = new ContextBuilder({ workspace: standalone }).buildSystemPrompt(
      null,
      null,
      null,
      createProjectInstructionsHook(createProjectInstructionsSource({ filePath: file })),
      null,
      "webui:session-2",
      false,
      standalone
    );
    expect(prompt).not.toContain("project_instructions");
    expect(prompt).not.toContain("前端代码规范");
  });

  it("keeps a cleared project out of the prompt", () => {
    const root = tempRoot();
    const file = writeInstructions(root, {});
    const prompt = new ContextBuilder({ workspace: root }).buildSystemPrompt(
      null,
      null,
      null,
      createProjectInstructionsHook(createProjectInstructionsSource({ filePath: file })),
      null,
      "webui:session-3",
      false,
      root
    );
    expect(prompt).not.toContain("project_instructions");
    expect(renderProjectInstructionsSection("指令")).toContain("<project_instructions>\n指令\n</project_instructions>");
  });

  it("reaches the system prompt of a real task in the project, and only there", () => {
    const root = tempRoot();
    const project = path.join(root, "memmy");
    fs.mkdirSync(project);
    const standalone = path.join(root, "standalone");
    fs.mkdirSync(standalone);
    fs.writeFileSync(path.join(root, "project-instructions.json"), JSON.stringify({
      version: 1,
      projects: { [project]: entry("前端代码遵循《前端代码规范》。", "cloud") }
    }), "utf8");
    // 指令文件与 Memmy 配置同目录：任务运行时按配置文件的位置找它。
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

    expect(promptOf(project)).toContain("<project_instructions>\n前端代码遵循《前端代码规范》。\n</project_instructions>");
    expect(promptOf(standalone)).not.toContain("project_instructions");
  });
});
