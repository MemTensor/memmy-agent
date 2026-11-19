/** Project sharing store tests: the sidebar and the board read one cloud list and one open project. */
import { beforeEach, describe, expect, it } from "vitest";
import type { CollabClient, CollabProject } from "../../api/collab-client.js";
import {
  addCollabProject,
  addPendingApplication,
  closeCreateProject,
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
  shouldDemoOnNewProject,
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

  it("keeps the open state until it is closed, for every mounted frame", () => {
    requestCreateProject();
    expect(getCollabProjectsSnapshot().createOpen).toBe(true);

    // 打开与关闭都在 store 里：任何一处关闭对所有挂着的外壳都生效，
    // 所以关掉之后切到另一个页面也不会再冒出一个弹窗。
    closeCreateProject();
    expect(getCollabProjectsSnapshot().createOpen).toBe(false);
    expect(getCollabProjectsSnapshot().createDemo).toBe(false);

    // 再关一次什么都不改，便于 onClose 与 onCreated 都调用它。
    closeCreateProject();
    expect(getCollabProjectsSnapshot().createOpen).toBe(false);
  });

  it("carries the walkthrough entry through the create request", () => {
    // 从新功能大卡点「新建项目」：弹窗要预填名称、提前打开共享，并让引导停在「创建项目」。
    requestCreateProject({ share: true, demo: true });
    expect(getCollabProjectsSnapshot()).toMatchObject({ createOpen: true, createShareDefault: true, createDemo: true });

    // 看完一次就清掉：之后从侧栏新建不会又带着体验。
    closeCreateProject();
    expect(getCollabProjectsSnapshot()).toMatchObject({ createOpen: false, createShareDefault: false, createDemo: false });

    // 侧栏、看板空态的普通新建不带这个标记。
    requestCreateProject();
    expect(getCollabProjectsSnapshot().createDemo).toBe(false);
    requestCreateProject({ share: true });
    expect(getCollabProjectsSnapshot().createDemo).toBe(false);
    closeCreateProject();
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

/** 只带项目列表与 `demoEligible` 的客户端：这两个字段正是路径 B 判断要用的。 */
function clientWithEligibility(projects: CollabProject[], demoEligible?: boolean): CollabClient {
  return {
    listProjects: async () => (demoEligible === undefined ? { projects } : { projects, demoEligible })
  } as CollabClient;
}

/** 只有本人名下的在线项目才算数：成员身份的项目不影响「第一次新建」。 */
function memberProject(id: string): CollabProject {
  return { id, name: id, role: "member", memberCount: 3, sessionCount: 2, createdAt: null, localProjectId: null };
}

describe("cloud walkthrough eligibility", () => {
  it("starts from false and stays false when the cloud has no such field", async () => {
    // 旧云端不返回这个字段：默认 false，不会因此进演示。
    expect(getCollabProjectsSnapshot().demoEligible).toBe(false);
    await loadCollabProjects(clientWithEligibility([]));
    expect(getCollabProjectsSnapshot().demoEligible).toBe(false);
  });

  it("stores the flag the cloud grants, and drops it when a later list omits it", async () => {
    await loadCollabProjects(clientWithEligibility([], true));
    expect(getCollabProjectsSnapshot().demoEligible).toBe(true);

    // 换回旧后端或云端改了口径：没有这个字段就是 false，不沿用上一次的 true。
    await loadCollabProjects(clientWithEligibility([]));
    expect(getCollabProjectsSnapshot().demoEligible).toBe(false);
  });
});

describe("whether the sidebar's new project opens the walkthrough", () => {
  it("takes it when the collaboration is on, nothing is owned and the cloud allows it", async () => {
    await loadCollabProjects(clientWithEligibility([], true));
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false })).toBe(true);
  });

  it("skips it in API Key mode", async () => {
    await loadCollabProjects(clientWithEligibility([], true));
    expect(shouldDemoOnNewProject({ collabEnabled: false, demoGuideActive: false })).toBe(false);
  });

  it("skips it while another walkthrough is running", async () => {
    await loadCollabProjects(clientWithEligibility([], true));
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: true })).toBe(false);
  });

  it("skips it once the person owns an online project", async () => {
    await loadCollabProjects(clientWithEligibility([project("mine")], true));
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false })).toBe(false);

    // 只加入过别人的项目不算：之后第一次自己创建仍然可以体验。
    await loadCollabProjects(clientWithEligibility([memberProject("theirs")], true));
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false })).toBe(true);
  });

  it("skips it once this machine has already left the walkthrough", async () => {
    await loadCollabProjects(clientWithEligibility([], true));
    // 建项目之前就退出过：云端还没有项目可记、只能说「可以体验」，本机标记必须更早生效。
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false, demoGuideDone: true })).toBe(false);
    // 标记还没写时照旧进演示。
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false, demoGuideDone: false })).toBe(true);
  });

  it("skips it when the cloud does not allow another walkthrough", async () => {
    await loadCollabProjects(clientWithEligibility([], false));
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false })).toBe(false);

    // 旧云端完全不带这个字段时也是 false。
    await loadCollabProjects(clientWithEligibility([]));
    expect(shouldDemoOnNewProject({ collabEnabled: true, demoGuideActive: false })).toBe(false);
  });
});
