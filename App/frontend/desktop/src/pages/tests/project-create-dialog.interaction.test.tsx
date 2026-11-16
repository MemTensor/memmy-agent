// @vitest-environment happy-dom

/**
 * The new-project dialog. A project stays on this computer unless the sharing box is ticked, so the unshared path
 * must not touch the cloud at all; ticking it creates the cloud record and asks which sessions to sync.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCollabProjectsSnapshot,
  loadCollabProjects,
  resetCollabProjectsStore
} from "../../app/collab-projects-store.js";
import { ApiRequestError } from "../../api/http.js";
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

describe("new project dialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onCreated = vi.fn();
  const onShareFailed = vi.fn();
  const onShareLimitReached = vi.fn();
  const onClose = vi.fn();
  const onJoinProject = vi.fn();

  function collab() {
    return {
      createProject: mocks.createProject,
      bindLocalProject: mocks.bindLocalProject
    } as never;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
    mocks.prepareDirectory.mockResolvedValue("/Users/me/.memmy/local-projects/demo");
    mocks.mutateProject.mockResolvedValue({ status: "committed", project: { id: "local-1" } });
    mocks.createProject.mockResolvedValue({
      project: { id: "cloud-1", name: "demo", role: "owner", memberCount: 1, sessionCount: 0, createdAt: null, localProjectId: null }
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
            collab={collab()}
            onClose={onClose}
            onCreated={onCreated}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={onShareFailed}
            onShareLimitReached={onShareLimitReached}
            onJoinProject={onJoinProject}
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
  });

  // The dialog mounts on the body through a portal, so the page container is not where it lives.
  function nameInput(): HTMLInputElement {
    const input = document.querySelector<HTMLInputElement>(".modal-body input:not([type='checkbox'])");
    expect(input, "名称输入框应已渲染").toBeTruthy();
    return input!;
  }

  /** React owns the input's value, so the native setter has to run before the change event is dispatched. */
  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function shareSwitch(): HTMLElement {
    const control = document.querySelector<HTMLElement>(".modal-body [role='switch']");
    expect(control, "共享开关应已渲染").toBeTruthy();
    return control!;
  }

  function buttonByText(label: string): HTMLElement | undefined {
    return Array.from(document.querySelectorAll<HTMLElement>("button"))
      .find((button) => button.textContent?.trim() === label);
  }

  /** 小问号：只有点开才出现说明，按可访问名找到它。 */
  function hintButton(label: string): HTMLElement {
    const target = document.querySelector<HTMLElement>(`button[aria-label='${label}']`);
    expect(target, `${label}小问号应已渲染`).toBeTruthy();
    return target!;
  }

  function popover(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".modal-body [role='note']");
  }

  function submitButton(): HTMLElement {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button"));
    const target = buttons.find((button) => button.textContent?.trim() === "创建项目");
    expect(target, "创建项目按钮应已渲染").toBeTruthy();
    return target!;
  }

  it("creates only the local project while sharing is off", async () => {
    // 顶部不再有「新建项目 | 加入协作项目」标签：加入项目是页脚左侧的一个次要按钮。
    expect(document.querySelector("[role='tablist']")).toBeNull();
    expect(document.querySelector(".modal-subtitle")).toBeNull();
    expect(buttonByText("加入项目")).toBeTruthy();
    expect(shareSwitch().getAttribute("aria-checked")).toBe("false");
    await act(async () => type(nameInput(), "demo"));
    await act(async () => submitButton().click());
    await flush();

    // Nothing reaches the cloud: the project is only on this computer.
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.bindLocalProject).not.toHaveBeenCalled();
    expect(mocks.prepareDirectory).toHaveBeenCalledWith(expect.anything(), "demo");
    expect(mocks.mutateProject).toHaveBeenCalledWith({
      kind: "create",
      input: {
        mode: "blank",
        path: "/Users/me/.memmy/local-projects/demo",
        name: "demo",
        allowShared: true
      }
    });
    // 没开共享的项目只落本机：调用方据此直接进入它的新会话。
    expect(onCreated).toHaveBeenCalledWith("local-1", { shareRequested: false });
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();
  });

  /** Enter on the name field; `composing` is what a Chinese IME reports while a candidate is being chosen. */
  async function pressEnter(input: HTMLInputElement, composing: boolean) {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: composing }));
    });
    await flush();
  }

  it("ignores the Enter that confirms an IME candidate, so a half-typed pinyin never becomes the name", async () => {
    // 中文输入法打字时，回车上屏候选词，不是提交：这时候不能建项目。
    await act(async () => type(nameInput(), "wo'shi"));
    await pressEnter(nameInput(), true);

    expect(mocks.mutateProject).not.toHaveBeenCalled();
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("still creates the project on a plain Enter", async () => {
    await act(async () => type(nameInput(), "demo"));
    await pressEnter(nameInput(), false);

    expect(mocks.mutateProject).toHaveBeenCalledWith(expect.objectContaining({ kind: "create" }));
    expect(onCreated).toHaveBeenCalledWith("local-1", { shareRequested: false });
  });

  it("creates the cloud record once sharing is ticked", async () => {
    await act(async () => type(nameInput(), "demo"));
    await act(async () => {
      shareSwitch().click();
    });
    await act(async () => submitButton().click());
    await flush();

    // 本机还没有任何在线项目：这一次新建带上演示标记，云端再决定是否真的演示。
    expect(mocks.createProject).toHaveBeenCalledWith("demo", "/Users/me/.memmy/local-projects/demo", { demo: true });
    expect(mocks.bindLocalProject).toHaveBeenCalledWith("cloud-1", "local-1");
    // A brand-new project has no sessions yet, so nothing is asked and nothing pops up over the board.
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();
    // 试过共享：即使失败也回看板，提示都挂在那里。
    expect(onCreated).toHaveBeenCalledWith("local-1", { shareRequested: true });
  });

  /** 本机已经拥有 `count` 个协作项目，云端给出的上限是 `limit`。 */
  async function seedOwnedProjects(count: number, limit: number): Promise<void> {
    const projects = Array.from({ length: count }, (_, index) => ({
      id: `cloud-${index}`,
      name: `demo ${index}`,
      role: "owner",
      memberCount: 1,
      sessionCount: 0,
      createdAt: null,
      localProjectId: `local-${index}`
    }));
    await act(async () => {
      await loadCollabProjects({
        listProjects: async () => ({ projects, applications: [], decisions: [], maxOwnedProjects: limit })
      } as never);
    });
  }

  it("says up front that this project stays on this computer once the account is at its limit", async () => {
    await seedOwnedProjects(5, 5);
    await act(async () => {
      shareSwitch().click();
    });
    await flush();

    // 上限由云端给出（这里是 5），弹窗不写死数字，只在开启共享时就说明这次只会建在本机。
    expect(document.body.textContent).toContain("协作项目已达上限（5 个），本次仅创建在本机");
  });

  it("keeps the project local and reports the limit instead of a service outage", async () => {
    await seedOwnedProjects(5, 5);
    mocks.createProject.mockRejectedValueOnce(
      new ApiRequestError("每人最多创建 5 个在线项目，停止共享后可再创建", 409, "collab_quota_exceeded")
    );
    await act(async () => type(nameInput(), "第六个"));
    await act(async () => {
      shareSwitch().click();
    });
    await act(async () => submitButton().click());
    await flush();

    // 本机项目照建；失败原因是额度，不该走「服务暂时不可用」那条提示。
    expect(onCreated).toHaveBeenCalledWith("local-1", { shareRequested: true });
    expect(onShareLimitReached).toHaveBeenCalledWith(5);
    expect(onShareFailed).not.toHaveBeenCalled();
  });

  it("hides both cloud entries in API Key mode", async () => {
    // 另起一个根：默认弹窗已经挂在原来的根上，同一个根不能先卸再画。
    await act(async () => root.unmount());
    const bareRoot = createRoot(container);
    await act(async () => {
      bareRoot.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            // API Key 模式没有云端账号：共享开关与「加入项目」都不出现，只建本机项目。
            shareAvailable={false}
            collab={collab()}
            onClose={vi.fn()}
            onCreated={onCreated}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={onShareFailed}
            onShareLimitReached={onShareLimitReached}
          />
        </I18nProvider>
      );
    });
    await flush();

    expect(document.querySelector(".modal-body [role='switch']")).toBeNull();
    expect(document.body.textContent).not.toContain("开启项目协作");
    expect(document.body.textContent).not.toContain("加入项目");
    // 没有云端账号就没有「加入项目」，页脚左侧只剩占位，不在弹窗里留一个走不通的按钮。
    expect(document.querySelector("[role='tablist']")).toBeNull();
    // 极简版不再有副标题：说明只放在小问号里。
    expect(document.querySelector(".modal-subtitle")).toBeNull();

    await act(async () => type(nameInput(), "demo"));
    await act(async () => submitButton().click());
    await flush();
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith("local-1", { shareRequested: false });
    await act(async () => bareRoot.unmount());
  });

  it("leaves other sharing failures to the generic notice", async () => {
    mocks.createProject.mockRejectedValueOnce(new ApiRequestError("暂时无法连接 Memmy 云端，请稍后重试。", 503));
    await act(async () => type(nameInput(), "demo"));
    await act(async () => {
      shareSwitch().click();
    });
    await act(async () => submitButton().click());
    await flush();

    expect(onShareFailed).toHaveBeenCalledWith("暂时无法连接 Memmy 云端，请稍后重试。");
    expect(onShareLimitReached).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith("local-1", { shareRequested: true });
  });

  it("starts with sharing off unless the opener asks for it", async () => {
    expect(shareSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("starts with sharing on when the announcement's last page asks for it", async () => {
    // 另起一个根：默认弹窗已经挂在原来的根上，同一个根不能先卸再画。
    await act(async () => root.unmount());
    const sharedRoot = createRoot(container);
    await act(async () => {
      sharedRoot.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            defaultShare
            collab={collab()}
            onClose={vi.fn()}
            onCreated={onCreated}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={onShareFailed}
            onShareLimitReached={onShareLimitReached}
          />
        </I18nProvider>
      );
    });
    await flush();

    expect(shareSwitch().getAttribute("aria-checked")).toBe("true");
    // 默认开启也只是一次预选：真正提交时才连云端。
    expect(mocks.createProject).not.toHaveBeenCalled();
    await act(async () => sharedRoot.unmount());
  });

  it("leaves the sharing row out when sharing is unavailable, even if the opener asked for it", async () => {
    await act(async () => root.unmount());
    const bareRoot = createRoot(container);
    await act(async () => {
      bareRoot.render(
        <I18nProvider language="zh-CN">
          <CreateProjectModal
            open
            shareAvailable={false}
            defaultShare
            collab={collab()}
            onClose={vi.fn()}
            onCreated={onCreated}
            onShared={vi.fn()}
            onBound={vi.fn()}
            onBindFailed={vi.fn()}
            onShareFailed={onShareFailed}
            onShareLimitReached={onShareLimitReached}
          />
        </I18nProvider>
      );
    });
    await flush();

    // API Key 模式没有云端账号：默认共享不成立，那一行整行不出现。
    expect(document.querySelector(".modal-body [role='switch']")).toBeNull();
    await act(async () => bareRoot.unmount());
  });

  it("keeps the explanation inside a question mark and closes it on Escape without closing the dialog", async () => {
    // 说明常驻会撑开版面：点开小问号才出现，Escape 只收这一层。
    expect(popover()).toBeNull();
    expect(document.body.textContent).not.toContain("成员可以查看和引用项目中的任务");

    await act(async () => hintButton("协作说明").click());
    expect(hintButton("协作说明").getAttribute("aria-expanded")).toBe("true");
    expect(popover()?.textContent).toContain("成员可以查看和引用项目中的任务，本机文件不会上传。");

    // 焦点在问号上按 Escape：只关说明，整个弹窗留着。
    await act(async () => {
      hintButton("协作说明").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // 再点一次也能收起。
    await act(async () => hintButton("协作说明").click());
    expect(popover()).not.toBeNull();
    await act(async () => hintButton("协作说明").click());
    expect(popover()).toBeNull();
  });

  it("closes the explanation when pressing outside it", async () => {
    await act(async () => hintButton("协作说明").click());
    expect(popover()).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(popover()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("toggles sharing from anywhere in the share field except its question mark", async () => {
    // 共享是一个整框：点文字与点开关一样切换，点问号只看说明。
    const label = Array.from(document.querySelectorAll<HTMLElement>(".modal-body span"))
      .find((node) => node.textContent === "开启项目协作");
    expect(label, "协作字段应显示「开启项目协作」").toBeTruthy();
    expect(shareSwitch().getAttribute("aria-label")).toBe("开启项目协作");

    await act(async () => label!.click());
    expect(shareSwitch().getAttribute("aria-checked")).toBe("true");

    await act(async () => shareSwitch().click());
    expect(shareSwitch().getAttribute("aria-checked")).toBe("false");

    await act(async () => hintButton("协作说明").click());
    expect(popover()).not.toBeNull();
    expect(shareSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("only mentions the name limit once the name is too long", async () => {
    // 平时不显示字数说明，超了才在输入框下面出现一行。
    expect(document.body.textContent).not.toContain("项目名称最多 20 个字");
    await act(async () => type(nameInput(), "这是一个超过二十个字的项目名称示例文本内容"));
    expect(document.body.textContent).toContain("项目名称最多 20 个字");
    expect(submitButton().hasAttribute("disabled")).toBe(true);
  });

  it("picks one folder, shows its last segment and removes it again", async () => {
    const selectProjectDirectory = vi.fn(async () => ({ canceled: false, path: "/Users/me/Documents/设计稿" }));
    (window as unknown as { memmy?: unknown }).memmy = { selectProjectDirectory };

    // 没选目录时是一个大框加「添加」，不占整行说明。
    expect(buttonByText("在此电脑上添加文件夹")).toBeFalsy();
    expect(document.body.textContent).toContain("在此电脑上添加文件夹");
    await act(async () => buttonByText("添加")!.click());
    expect(selectProjectDirectory).toHaveBeenCalled();

    // 选好以后只留一行：末级名称 + 移除，完整路径放在悬停提示里。
    const row = document.querySelector<HTMLElement>(`button[aria-label='更换文件夹']`);
    expect(row).toBeTruthy();
    expect(row?.textContent?.trim()).toBe("设计稿");
    expect(row?.getAttribute("title")).toBe("/Users/me/Documents/设计稿");
    expect(document.body.textContent).not.toContain("在此电脑上添加文件夹");

    await act(async () => document.querySelector<HTMLElement>(`button[aria-label='移除文件夹']`)!.click());
    expect(document.querySelector(`button[aria-label='更换文件夹']`)).toBeNull();
    expect(document.body.textContent).toContain("在此电脑上添加文件夹");
    delete (window as unknown as { memmy?: unknown }).memmy;
  });

  it("creates the project inside the picked folder instead of a managed one", async () => {
    const selectProjectDirectory = vi.fn(async () => ({ canceled: false, path: "/Users/me/Documents/设计稿" }));
    (window as unknown as { memmy?: unknown }).memmy = { selectProjectDirectory };

    await act(async () => buttonByText("添加")!.click());
    await act(async () => type(nameInput(), "demo"));
    await act(async () => submitButton().click());
    await flush();

    expect(mocks.prepareDirectory).not.toHaveBeenCalled();
    expect(mocks.mutateProject).toHaveBeenCalledWith({
      kind: "create",
      input: {
        mode: "existing",
        path: "/Users/me/Documents/设计稿",
        name: "demo",
        allowShared: true
      }
    });
    delete (window as unknown as { memmy?: unknown }).memmy;
  });

  it("switches to the join dialog from the footer button", async () => {
    await act(async () => buttonByText("加入项目")!.click());
    expect(onJoinProject).toHaveBeenCalledTimes(1);
  });
});
