/**
 * 项目钩子运行时的读取逻辑：本机项目指令、协作授权文件与项目知识库。
 * 与 `tests/collab-instructions-scope.test.ts` 一起覆盖从记忆桥接里搬出来的这几项。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readProjectHookAccess,
  readProjectInstructions,
  recallProjectKnowledge,
  renderProjectKnowledge
} from "./runtime.js";

describe("project hook runtime", () => {
  let root: string;
  let memmyHome: string;
  let configUrl: URL;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memmy-project-runtime-"));
    memmyHome = join(root, "memmy");
    mkdirSync(memmyHome, { recursive: true });
    writeFileSync(join(memmyHome, "config.yaml"), "", "utf8");
    configUrl = pathToFileURL(join(memmyHome, "memmy-project-config.json"));
    writeFileSync(configUrl, JSON.stringify({ memmy_config_path: join(memmyHome, "config.yaml") }), "utf8");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the local instructions of the working directory", async () => {
    writeFileSync(join(memmyHome, "project-instructions.json"), JSON.stringify({
      version: 1,
      projects: {
        [root]: { text: "本项目约定：提交信息用英文。", origin: "local", cloudProjectId: null, updatedAt: "2026-10-24T12:00:00.000Z" }
      }
    }), "utf8");

    await expect(readProjectInstructions({ configUrl, directory: root })).resolves.toBe("本项目约定：提交信息用英文。");
    await expect(readProjectInstructions({ configUrl, directory: join(root, "other") })).resolves.toBe("");
    await expect(readProjectInstructions({ configUrl, directory: null })).resolves.toBe("");
  });

  it("treats a missing or broken instructions file as no instructions", async () => {
    await expect(readProjectInstructions({ configUrl, directory: root })).resolves.toBe("");
    writeFileSync(join(memmyHome, "project-instructions.json"), "not-json", "utf8");
    await expect(readProjectInstructions({ configUrl, directory: root })).resolves.toBe("");
  });

  it("reads the collab authorization next to the Memmy config", async () => {
    await expect(readProjectHookAccess({ configUrl })).resolves.toEqual({ granted: false, disabledAgents: [] });

    writeFileSync(join(memmyHome, "collab-agent-access.json"), JSON.stringify({
      granted: true,
      askedInProject: true,
      disabledAgents: ["cursor", 3, ""]
    }), "utf8");
    await expect(readProjectHookAccess({ configUrl })).resolves.toEqual({
      granted: true,
      disabledAgents: ["cursor"]
    });

    // 读坏了按未授权处理，不因为坏文件把协作内容放开。
    writeFileSync(join(memmyHome, "collab-agent-access.json"), "{", "utf8");
    await expect(readProjectHookAccess({ configUrl })).resolves.toEqual({ granted: false, disabledAgents: [] });
  });

  it("falls back to MEMMY_HOME when its own config does not point at a config file", async () => {
    const previous = process.env.MEMMY_HOME;
    process.env.MEMMY_HOME = memmyHome;
    try {
      writeFileSync(join(memmyHome, "collab-agent-access.json"), JSON.stringify({ granted: true }), "utf8");
      await expect(readProjectHookAccess({ configUrl: pathToFileURL(join(root, "missing.json")) })).resolves.toEqual({
        granted: true,
        disabledAgents: []
      });
    } finally {
      if (previous === undefined) delete process.env.MEMMY_HOME;
      else process.env.MEMMY_HOME = previous;
    }
  });

  it("recalls the project knowledge from the local backend and skips unreachable hosts", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      requests.push(await requestBody(request));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        enabled: true,
        evidence: [{ id: "source-1", title: "差旅制度", content: "住宿上限 500 元" }]
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      writeFileSync(join(memmyHome, "runtime.json"), JSON.stringify({ baseUrl: endpoint, localToken: "local-token" }), "utf8");

      const context = await recallProjectKnowledge({ configUrl, query: "出差住宿标准是多少", workspace: root });
      expect(context).toContain("memmy_knowledge_context");
      expect(context).toContain("住宿上限 500 元");
      expect(requests).toEqual([{ query: "出差住宿标准是多少", workspace: root }]);

      // 没有工作目录或没有提问就不查。
      await expect(recallProjectKnowledge({ configUrl, query: "", workspace: root })).resolves.toBe("");
      await expect(recallProjectKnowledge({ configUrl, query: "问题", workspace: null })).resolves.toBe("");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("renders nothing when the backend says the project has no knowledge", () => {
    expect(renderProjectKnowledge({ enabled: false, evidence: [] })).toBe("");
    expect(renderProjectKnowledge({ enabled: true, evidence: [] })).toBe("");
    expect(renderProjectKnowledge({ enabled: true, evidence: [{ id: "a", title: "标题", content: "内容" }] }))
      .toContain('"title":"标题"');
  });
});

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.method === "GET") return {};
  let value = "";
  for await (const chunk of request) value += chunk;
  return value ? JSON.parse(value) as Record<string, unknown> : {};
}
