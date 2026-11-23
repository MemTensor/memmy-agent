// @vitest-environment happy-dom

/**
 * 新建项目时是否带上演示标记：只有本人还没有任何在线项目、并且这次要共享时才带。
 * 带上也不代表一定演示——云端会再判断开关、名单与是否已经体验过，返回 `demo.active` 才真的开始。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCollabProject, loadCollabProjects, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { clearDemoGuideDone, markDemoGuideDone } from "../../app/collab-demo-guide-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CreateProjectModal } from "../collab-create-project-dialog.js";

const mocks = vi.hoisted(() => ({
  mutateProject: vi.fn(),
  prepareDirectory: vi.fn(),
  createProject: vi.fn(),
  bindLocalProject: vi.fn()
}));

vi.mock("../../app/agent-runtime-bridge.js", () => ({
  useOptionalAgentRuntimeBridge: () => ({ taskStateCoordinator: { mutateProject: mocks.mutateProject } })
}));

vi.mock("../../app/providers.js", () => ({
  useOptionalApiClients: () => ({ clients: { runtimeConfig: { baseUrl: "http://127.0.0.1:1" } } })
}));

vi.mock("../../api/projects-client.js", () => ({
  prepareProjectDirectory: mocks.prepareDirectory
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

/**
 * 把云端「这个人现在能不能体验」写成给定值。
 *
 * 项目列表响应里的 `demoEligible` 就是云端 `eligible()` 的结果，弹窗靠它决定要不要走六屏。
 */
async function setDemoEligible(eligible: boolean): Promise<void> {
  await loadCollabProjects({
    listProjects: async () => ({ projects: [], demoEligible: eligible })
  } as never);
}

describe("new project dialog and the demo flag", () => {
  let container: HTMLDivElement;
  let root: Root;

  function nameInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>(".modal-body input:not([type='checkbox'])");
    expect(input).toBeTruthy();
    return input!;
  }

  function type(input: HTMLInputElement, value: string) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function submitButton(): HTMLElement {
    const target = Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((button) => button.textContent?.trim() === "创建项目");
    expect(target).toBeTruthy();
    return target!;
  }

  /** 用体验入口的样子打开一次弹窗：名称与协作开关都由引导替人填好。 */
  async function renderDemoDialog(overrides?: { shareAvailable?: boolean; onJoinProject?: boolean }): Promise<void> {
    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            defaultShare
            demo
            shareAvailable={overrides?.shareAvailable}
            onJoinProject={overrides?.onJoinProject === false ? undefined : vi.fn()}
            collab={{ createProject: mocks.createProject, bindLocalProject: mocks.bindLocalProject } as never}
            onClose={vi.fn()}
            onCreated={vi.fn()}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await flush();
  }

  /** 弹窗上所有的引导锚点。 */
  function anchors(): string[] {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-demo-guide]"))
      .map((element) => element.getAttribute("data-demo-guide") ?? "");
  }

  async function createNamed(name: string): Promise<void> {
    await act(async () => type(nameInput(), name));
    await act(async () => submitButton().click());
    await flush();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    // 本机「已退出过引导」的标记与用例无关，每个用例从干净状态开始。
    clearDemoGuideDone();
    // 默认云端说这个人还能体验：六屏是否真的走由它决定，不能演示的用例自己改成 false。
    await setDemoEligible(true);
    mocks.prepareDirectory.mockResolvedValue("/Users/me/.memmy/local-projects/demo");
    mocks.mutateProject.mockResolvedValue({ status: "committed", project: { id: "local-1" } });
    mocks.createProject.mockResolvedValue({
      project: {
        id: "cloud-1",
        name: "demo",
        role: "owner",
        memberCount: 2,
        sessionCount: 0,
        createdAt: null,
        localProjectId: null,
        demo: { active: true, memberUserId: "9001", memberName: "小饭团", step: "1" }
      }
    });
    mocks.bindLocalProject.mockResolvedValue(undefined);

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            // 大卡与侧栏第一次新建都会把共享默认打开，演示只在这条路径上出现。
            defaultShare
            collab={{ createProject: mocks.createProject, bindLocalProject: mocks.bindLocalProject } as never}
            onClose={vi.fn()}
            onCreated={vi.fn()}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={vi.fn()}
          />
        </I18nProvider>
      );
    });
    await flush();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
    clearDemoGuideDone();
  });

  it("opens the walkthrough entrance with the name and sharing already set", async () => {
    await renderDemoDialog();

    // 名字替人填好，用户不用输任何东西。
    expect(nameInput().value).toBe("项目协作体验");
    const shareSwitch = document.querySelector<HTMLElement>("[role='switch']");
    expect(shareSwitch?.getAttribute("aria-checked")).toBe("true");
    // 「创建项目」是引导唯一的亮区：锚点就在这个按钮上。
    expect(submitButton().getAttribute("data-demo-guide")).toBe("create-project-submit");
    // 弹窗自己的暗底让给蒙版，否则会叠两层灰。
    expect(document.querySelector(".modal-backdrop")?.className).toContain("backdropYield");
    // 名称框不抢光标：这一步要点的是「创建项目」。
    expect(document.activeElement).not.toBe(nameInput());
  });

  it("marks every control the walkthrough steps through", async () => {
    await renderDemoDialog();

    // 六屏各一个亮区：整个弹窗、名称、文件夹、协作开关、左下「加入项目」与底部「创建项目」。
    expect(anchors().sort()).toEqual([
      "create-collab",
      "create-dialog",
      "create-folder",
      "create-join",
      "create-name",
      "create-project-submit"
    ]);
    // 亮区之间是嵌套关系：外层框住整个弹窗，里面的四块各框一项。
    const dialog = document.querySelector("[data-demo-guide='create-dialog']");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    for (const inner of ["create-name", "create-folder", "create-collab"]) {
      expect(dialog?.querySelector(`[data-demo-guide='${inner}']`)).toBeTruthy();
    }
  });

  it("skips the join anchor when there is no join button", async () => {
    // API Key 模式没有云端账号可加入：弹窗里整块共享入口都不出现。
    await renderDemoDialog({ shareAvailable: false });
    expect(anchors()).toEqual([]);

    // 协作可用但这次没给「加入项目」的入口：其余锚点都在，唯独没有 create-join，
    // 状态机据此跳过那一步，不会把气泡指向不存在的元素。
    await renderDemoDialog({ onJoinProject: false });
    expect(anchors()).not.toContain("create-join");
    expect(anchors()).toContain("create-project-submit");
  });

  it("asks the cloud for the demo on the first shared project", async () => {
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });

  it("leaves an ordinary new project empty and without the anchor", async () => {
    // 侧栏的普通新建：名称留空等人输入，按钮上没有引导锚点，其他地方也一个都不挂。
    expect(nameInput().value).toBe("");
    expect(submitButton().getAttribute("data-demo-guide")).toBeNull();
    expect(anchors()).toEqual([]);
  });

  it("never asks for the demo once an online project exists", async () => {
    await act(async () => {
      addCollabProject({
        id: "p-existing",
        name: "旧的协作项目",
        role: "owner",
        memberCount: 2,
        sessionCount: 1,
        createdAt: null,
        localProjectId: "local-9"
      });
    });
    await createNamed("第二个项目");
    expect(mocks.createProject).toHaveBeenCalledWith("第二个项目", "/Users/me/.memmy/local-projects/demo", { demo: false, localProjectId: "local-1" });
  });

  it("still asks for the demo from the launch card when the person already has one", async () => {
    // 大卡入口已经明确要体验：名下已有协作项目也照旧带标记，由云端按名单与是否体验过决定。
    await act(async () => {
      addCollabProject({
        id: "p-existing",
        name: "旧的协作项目",
        role: "owner",
        memberCount: 2,
        sessionCount: 1,
        createdAt: null,
        localProjectId: "local-9"
      });
    });
    await renderDemoDialog();
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });
  /**
   * 云端说这个人这次不能演示（已体验过、开关关掉、不在名单）：六屏就不该开。
   *
   * 只看本机「退出过引导」时，云端已经记过体验的机器（重装、换过应用数据）会照旧走完六屏，
   * 点「创建项目」后云端不启动演示，引导就在进看板的那一刻无声消失。
   */
  it("opens an ordinary dialog when the cloud cannot demo this person", async () => {
    await act(async () => {
      await setDemoEligible(false);
    });
    await renderDemoDialog();

    // 名字不再替人预填，六个亮区一个都不挂：这就是一次普通新建。
    expect(nameInput().value).toBe("");
    expect(anchors()).toEqual([]);
    // 分享仍按大卡的意图默认打开，请求标记照旧交给云端判断，界面不自己编结果。
    expect(document.querySelector<HTMLElement>("[role='switch']")?.getAttribute("aria-checked")).toBe("true");
    await createNamed("普通项目");
    expect(mocks.createProject).toHaveBeenCalledWith("普通项目", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });

  it("never asks for the demo once this machine has left the walkthrough", async () => {
    // 用户点过「退出引导」：本机标记已写，之后第一次创建共享项目也不再请求演示。
    markDemoGuideDone();
    await createNamed("我的第一个项目");
    expect(mocks.createProject).toHaveBeenCalledWith("我的第一个项目", "/Users/me/.memmy/local-projects/demo", { demo: false, localProjectId: "local-1" });

    // 大卡入口同样不带：本机已经退出过，就不再带人走一遍。
    await renderDemoDialog();
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenLastCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: false, localProjectId: "local-1" });
  });

  it("still asks for the demo when the person has only joined others' projects", async () => {
    await act(async () => {
      addCollabProject({
        id: "p-joined",
        name: "同事的项目",
        role: "member",
        memberCount: 3,
        sessionCount: 4,
        createdAt: null,
        localProjectId: "local-8"
      });
    });
    await createNamed("我的第一个项目");
    expect(mocks.createProject).toHaveBeenCalledWith("我的第一个项目", "/Users/me/.memmy/local-projects/demo", { demo: true, localProjectId: "local-1" });
  });
});
