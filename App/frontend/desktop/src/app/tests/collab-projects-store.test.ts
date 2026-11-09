/** Project sharing store tests: the sidebar and the board read one cloud list and one open project. */
import { beforeEach, describe, expect, it } from "vitest";
import type { CollabClient, CollabProject } from "../../api/collab-client.js";
import {
  addCollabProject,
  addPendingApplication,
  consumeCreateProjectRequest,
  consumeTaskPickerRequest,
  getCollabProjectsSnapshot,
  loadCollabProjects,
  removeCollabProject,
  replaceCollabProject,
  requestCreateProject,
  requestTaskPicker,
  resetCollabProjectsStore,
  selectCollabProject,
  sharedProjectFor,
  subscribeCollabProjects
} from "../collab-projects-store.js";

function project(id: string, name = id, localProjectId: string | null = null): CollabProject {
  return { id, name, role: "owner", memberCount: 1, sessionCount: 0, createdAt: null, localProjectId };
}

function clientWith(
  list: () => Promise<CollabProject[]>,
  applications?: { projectId: string; projectName: string }[],
  decisions?: { projectId: string; projectName: string; status: "approved" | "rejected"; decidedAt: string | null }[]
): CollabClient {
  return {
    listProjects: async () => {
      const projects = await list();
      if (applications === undefined && decisions === undefined) return { projects };
      return {
        projects,
        ...(applications === undefined ? {} : { applications }),
        ...(decisions === undefined ? {} : { decisions })
      };
    },
    createProject: async (name) => ({ project: project("new", name) }),
    listSessions: async () => ({ project: project("x"), sessions: [], total: 0 }),
    listLocalSessions: async () => ({ sessions: [], refreshing: false }),
    getLinks: async () => ({ groups: [], sessions: [] }),
    saveLinks: async () => ({ uploaded: 0, removed: 0, failed: 0 }),
    removeSession: async () => undefined
  } as CollabClient;
}

beforeEach(() => {
  resetCollabProjectsStore();
});

describe("collab projects store", () => {
  it("loads the shared projects without picking one", async () => {
    await loadCollabProjects(clientWith(async () => [project("a"), project("b")]));

    expect(getCollabProjectsSnapshot().projects?.map((item) => item.id)).toEqual(["a", "b"]);
    // The board's subject is a local project, so loading the cloud list must not move it.
    expect(getCollabProjectsSnapshot().selectedId).toBeNull();
    expect(getCollabProjectsSnapshot().loading).toBe(false);
  });

  it("keeps the open project across reloads", async () => {
    await loadCollabProjects(clientWith(async () => [project("a", "a", "local-a")]));
    selectCollabProject("local-a");

    await loadCollabProjects(clientWith(async () => [project("a", "a", "local-a")]));

    expect(getCollabProjectsSnapshot().selectedId).toBe("local-a");
  });

  it("keeps the open project when sharing stops", async () => {
    await loadCollabProjects(clientWith(async () => [project("a", "a", "local-a")]));
    selectCollabProject("local-a");

    removeCollabProject("a");

    expect(getCollabProjectsSnapshot().projects).toEqual([]);
    // The project is still on this computer; only its cloud record went away.
    expect(getCollabProjectsSnapshot().selectedId).toBe("local-a");
  });

  it("keeps the unloaded list and the reason when the first load fails", async () => {
    await loadCollabProjects(clientWith(async () => {
      throw new Error("请先登录 Memmy 后使用项目");
    }));

    // 第一次还没读到云端时是 null，好让侧边栏区分「没加载」和「确实没有项目」。
    expect(getCollabProjectsSnapshot().projects).toBeNull();
    expect(getCollabProjectsSnapshot().error).toContain("请先登录");
    expect(getCollabProjectsSnapshot().selectedId).toBeNull();
  });

  it("puts a newly shared project first without moving the board", async () => {
    await loadCollabProjects(clientWith(async () => [project("a")]));

    addCollabProject(project("b"));

    expect(getCollabProjectsSnapshot().projects?.map((item) => item.id)).toEqual(["b", "a"]);
    expect(getCollabProjectsSnapshot().selectedId).toBeNull();
  });

  it("updates a project in place after the board reloads it", async () => {
    await loadCollabProjects(clientWith(async () => [project("a")]));

    replaceCollabProject(project("a", "更名为 A"));

    expect(getCollabProjectsSnapshot().projects?.[0]?.name).toBe("更名为 A");
  });

  it("finds the cloud record of a local project", () => {
    const projects = [project("a", "a", "local-a"), project("b", "b", null)];

    expect(sharedProjectFor(projects, "local-a")?.id).toBe("a");
    expect(sharedProjectFor(projects, "local-b")).toBeNull();
    expect(sharedProjectFor(null, "local-a")).toBeNull();
  });

  it("hands one create request to the frame, then clears it", () => {
    requestCreateProject();
    expect(getCollabProjectsSnapshot().createPending).toBe(true);

    consumeCreateProjectRequest();
    expect(getCollabProjectsSnapshot().createPending).toBe(false);
  });

  it("keeps a just-submitted application until the cloud lists it, then replaces the list", async () => {
    addPendingApplication({ projectId: "cloud-1", projectName: "Memmy 开发" });
    expect(getCollabProjectsSnapshot().applications).toEqual([{ projectId: "cloud-1", projectName: "Memmy 开发" }]);

    await loadCollabProjects(clientWith(async () => []));
    expect(getCollabProjectsSnapshot().applications).toEqual([{ projectId: "cloud-1", projectName: "Memmy 开发" }]);

    await loadCollabProjects(clientWith(async () => [project("cloud-1", "Memmy 开发")]));
    expect(getCollabProjectsSnapshot().applications).toEqual([]);

    addPendingApplication({ projectId: "cloud-1", projectName: "Memmy 开发" });
    await loadCollabProjects(clientWith(async () => [], []));
    expect(getCollabProjectsSnapshot().applications).toEqual([]);
  });

  it("asks the board for the session picker once, then clears it", () => {
    requestTaskPicker("local-a");
    expect(getCollabProjectsSnapshot().taskPickerFor).toBe("local-a");

    consumeTaskPickerRequest();
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();
  });

  it("keeps reviewed applications for the result toast, and holds them when the cloud is older", async () => {
    const decision = { projectId: "cloud-1", projectName: "Memmy 开发", status: "approved" as const, decidedAt: "2026-10-29T02:00:00.000Z" };
    await loadCollabProjects(clientWith(async () => [project("cloud-1")], [], [decision]));
    expect(getCollabProjectsSnapshot().decisions).toEqual([decision]);

    // 后台还没有这一列：保留上一次的结果，等前端提示完自己记下来。
    await loadCollabProjects(clientWith(async () => [project("cloud-1")]));
    expect(getCollabProjectsSnapshot().decisions).toEqual([decision]);

    // 云端给出空列表时就清空，不再一直挂着。
    await loadCollabProjects(clientWith(async () => [project("cloud-1")], [], []));
    expect(getCollabProjectsSnapshot().decisions).toEqual([]);
  });

  it("stays silent when a reload or a board refresh brings the same content", async () => {
    await loadCollabProjects(clientWith(async () => [project("a", "a", "local-a")]));
    let notifications = 0;
    const unsubscribe = subscribeCollabProjects(() => {
      notifications += 1;
    });

    // 切回窗口、看板轮询都会重读一遍：内容一样就不通知，侧栏与看板因此不必重画。
    await loadCollabProjects(clientWith(async () => [project("a", "a", "local-a")]));
    replaceCollabProject(project("a", "a", "local-a"));
    expect(notifications).toBe(0);

    // 真的变了照旧写回。
    replaceCollabProject(project("a", "更名为 A", "local-a"));
    expect(notifications).toBe(1);
    expect(getCollabProjectsSnapshot().projects?.[0]?.name).toBe("更名为 A");
    unsubscribe();
  });
});
