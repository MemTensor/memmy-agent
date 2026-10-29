/** 协作项目的项目指令：云端是权威，本机缓存到协作侧自己的文件，与本机项目指令不共享任何数据。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabService } from "../collab-service.js";
import { createCollabInstructionsService } from "../collab-instructions-service.js";
import { createProjectInstructionsService } from "../project-instructions-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

const project = {
  id: "p-1",
  name: "Memmy 开发",
  role: "ADMIN",
  memberCount: 2,
  sessionCount: 0,
  createdAt: null,
  instructions: "本项目负责 Memmy 桌面端的研发。"
};

/** Answers cloud requests from a route table keyed by "METHOD /path", and records each call. */
function cloud(routes: Record<string, (call: Call) => unknown>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      path: new URL(String(input)).pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    if (!handler) return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
    return new Response(JSON.stringify({ code: 0, message: "ok", data: await handler(call) }), { status: 200 });
  }) as typeof fetch;
  return { fetcher, calls };
}

function setup(routes: Record<string, (call: Call) => unknown>) {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-instructions-"));
  roots.push(root);
  const { fetcher, calls } = cloud(routes);
  const projectsDir = join(root, "projects");
  const collabInstructions = createCollabInstructionsService({ filePath: join(root, "collab-project-instructions.json") });
  const projectInstructions = createProjectInstructionsService({ filePath: join(root, "project-instructions.json") });
  const svc = createCollabService({
    cloudBaseUrl: "https://cloud.test.invalid",
    getAccount: () => ({ accountId: "u-a", credential: "uuid-a" }),
    localSessions: null,
    projectsDir,
    agentSessionsDir: join(root, "sessions"),
    collabInstructions,
    fetcher,
    now: () => new Date("2026-10-24T12:00:00.000Z")
  });
  return { svc, calls, collabInstructions, projectInstructions, root };
}

/** The directory this computer's tasks for the project run in, as createProject records it. */
async function boundProject(svc: ReturnType<typeof setup>["svc"], projectId: string) {
  const created = await svc.createProject(project.name);
  await svc.bindLocalProject(projectId, "local-1");
  return created.localDirectory;
}

describe("collab project instructions", () => {
  it("carries the instructions in the project view", async () => {
    const { svc } = setup({
      "GET /api/collab/projects": () => ({ projects: [project] })
    });
    const listed = await svc.listProjects();
    expect(listed.projects[0]).toMatchObject({ id: "p-1", instructions: "本项目负责 Memmy 桌面端的研发。" });
  });

  it("caches the cloud instructions in the collab store, leaving the local project file untouched", async () => {
    const { svc, collabInstructions, root } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "GET /api/collab/projects": () => ({ projects: [project] })
    });
    const directory = await boundProject(svc, "p-1");
    // 每次启动都会读项目列表：成员就是这样拿到所有者改过的指令的。
    await svc.listProjects();
    const entry = await collabInstructions.read("p-1");
    expect(entry?.text).toBe("本项目负责 Memmy 桌面端的研发。");
    // 范围先记录项目自己的目录：Memmy 的任务跑在这里；关联别的 Agent 后范围会跟着扩。
    expect(entry?.scopes).toContainEqual({ sourceId: "memmy", groupId: directory, roots: [directory] });
    // 两套存储互不写入：本机项目指令文件里不该出现这条协作指令。
    expect(existsSync(join(root, "project-instructions.json"))).toBe(false);
    expect(readFileSync(join(root, "collab-project-instructions.json"), "utf8")).toContain("Memmy 桌面端的研发");
  });

  it("saves through the cloud and keeps the cache in step, clearing it when the text is emptied", async () => {
    const next = { ...project, instructions: "前端代码遵循《前端代码规范》。" };
    const { svc, calls, collabInstructions } = setup({
      "POST /api/collab/projects": () => ({ project: { ...project, instructions: "" } }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "PATCH /api/collab/projects/p-1": () => ({ project: next, instructions: next.instructions })
    });
    await boundProject(svc, "p-1");

    const saved = await svc.updateInstructions("p-1", "  前端代码遵循《前端代码规范》。  ");
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { instructions: "前端代码遵循《前端代码规范》。" } });
    expect(saved.project.instructions).toBe("前端代码遵循《前端代码规范》。");
    await expect(collabInstructions.read("p-1")).resolves.toMatchObject({ text: "前端代码遵循《前端代码规范》。" });

    // 清空指令：云端与缓存都清掉，任务不再带上已经删掉的内容。
    const cleared = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "PATCH /api/collab/projects/p-1": () => ({ project: { ...project, instructions: "" }, instructions: "" })
    });
    await boundProject(cleared.svc, "p-1");
    await cleared.collabInstructions.remember({
      projectId: "p-1",
      scopes: [{ sourceId: "memmy", groupId: "/tmp/whatever" }],
      text: "旧指令"
    });
    await cleared.svc.updateInstructions("p-1", " ");
    await expect(cleared.collabInstructions.read("p-1")).resolves.toBeNull();
  });

  it("rejects instructions over the limit before calling the cloud", async () => {
    const { svc, calls } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true })
    });
    await boundProject(svc, "p-1");
    await expect(svc.updateInstructions("p-1", "字".repeat(10_001)))
      .rejects.toThrow("不超过 10000 字");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("drops the cache when the cloud project is deleted", async () => {
    const { svc, collabInstructions } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "DELETE /api/collab/projects/p-1": () => ({ ok: true })
    });
    await boundProject(svc, "p-1");
    await collabInstructions.remember({
      projectId: "p-1",
      scopes: [{ sourceId: "memmy", groupId: "/tmp/project" }],
      text: project.instructions
    });

    await svc.deleteProject("p-1");
    // 指令属于云端项目，项目没了就跟着消失；不写回本机项目指令。
    await expect(collabInstructions.read("p-1")).resolves.toBeNull();
  });

  it("drops the cache when the person leaves someone else's project", async () => {
    const { svc, collabInstructions } = setup({
      "POST /api/collab/projects": () => ({ project }),
      "PUT /api/collab/projects/p-1/binding": () => ({ ok: true }),
      "POST /api/collab/projects/p-1/leave": () => ({ ok: true })
    });
    await boundProject(svc, "p-1");
    await collabInstructions.remember({
      projectId: "p-1",
      scopes: [{ sourceId: "memmy", groupId: "/tmp/project" }],
      text: project.instructions
    });

    await svc.leaveProject("p-1");
    await expect(collabInstructions.read("p-1")).resolves.toBeNull();
  });
});
