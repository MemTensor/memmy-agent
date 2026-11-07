/** 会话目录 → 协作项目：知识库检索靠它判断要不要带上项目关联的知识库。 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCollabService } from "../collab-service.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const project = {
  id: "p-1",
  name: "Memmy 开发",
  role: "OWNER",
  memberCount: 1,
  sessionCount: 0,
  createdAt: null,
  instructions: ""
};

function setup(
  account: { accountId: string; credential: string } | null = { accountId: "u-a", credential: "uuid-a" },
  sharedProjectsDir?: string
) {
  const root = mkdtempSync(join(tmpdir(), "memmy-collab-directory-"));
  roots.push(root);
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/api/collab/projects") {
      return new Response(JSON.stringify({ code: 0, message: "ok", data: { project } }));
    }
    if (method === "PUT" && path.endsWith("/binding")) {
      return new Response(JSON.stringify({ code: 0, message: "ok", data: { ok: true } }));
    }
    return new Response(JSON.stringify({ code: 404, message: "no route", data: null }), { status: 404 });
  }) as typeof fetch;
  const svc = createCollabService({
    cloudBaseUrl: "https://cloud.test.invalid",
    getAccount: () => account,
    localSessions: null,
    projectsDir: sharedProjectsDir ?? join(root, "projects"),
    agentSessionsDir: join(root, "sessions"),
    fetcher,
    now: () => new Date("2026-10-27T09:00:00.000Z")
  });
  return { svc, root };
}

describe("collab directory lookup", () => {
  it("finds the project whose tasks run in a folder", async () => {
    const { svc } = setup();
    const { localDirectory } = await svc.createProject(project.name);
    expect(await svc.cloudProjectForDirectory(localDirectory)).toBe("p-1");
    // 尾部斜杠来自编辑器或 shell 补全时，仍然是同一个目录。
    expect(await svc.cloudProjectForDirectory(`${localDirectory}/`)).toBe("p-1");
    expect(await svc.cloudProjectForDirectory(join(localDirectory, "sub"))).toBeNull();
    expect(await svc.cloudProjectForDirectory("")).toBeNull();
  });

  it("ignores links another account left on this computer", async () => {
    const owner = setup({ accountId: "u-a", credential: "uuid-a" });
    const { localDirectory } = await owner.svc.createProject(project.name);
    const projectsDir = join(owner.root, "projects");
    // 同一台机器上另一个账号也读这份 links 目录：他的会话不该用上别人的项目知识库。
    const other = setup({ accountId: "u-b", credential: "uuid-b" }, projectsDir);
    expect(await owner.svc.cloudProjectForDirectory(localDirectory)).toBe("p-1");
    expect(await other.svc.cloudProjectForDirectory(localDirectory)).toBeNull();
  });

  it("returns null when nobody is signed in", async () => {
    const { svc } = setup(null);
    expect(await svc.cloudProjectForDirectory("/tmp/whatever")).toBeNull();
  });
});
