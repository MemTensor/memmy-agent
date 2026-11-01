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

  function submitButton(): HTMLElement {
    const buttons = Array.from(document.querySelectorAll<HTMLElement>("button"));
    const target = buttons.find((button) => button.textContent?.trim() === "创建");
    expect(target, "创建按钮应已渲染").toBeTruthy();
    return target!;
  }

  it("creates only the local project while sharing is off", async () => {
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
    expect(onCreated).toHaveBeenCalledWith("local-1");
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
    expect(onCreated).toHaveBeenCalledWith("local-1");
  });

  it("creates the cloud record once sharing is ticked", async () => {
    await act(async () => type(nameInput(), "demo"));
    await act(async () => {
      shareSwitch().click();
    });
    await act(async () => submitButton().click());
    await flush();

    expect(mocks.createProject).toHaveBeenCalledWith("demo", "/Users/me/.memmy/local-projects/demo");
    expect(mocks.bindLocalProject).toHaveBeenCalledWith("cloud-1", "local-1");
    // A brand-new project has no sessions yet, so nothing is asked and nothing pops up over the board.
    expect(getCollabProjectsSnapshot().taskPickerFor).toBeNull();
    expect(onCreated).toHaveBeenCalledWith("local-1");
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
    expect(document.body.textContent).toContain("协作项目数已达上限（5 个）");
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
    expect(onCreated).toHaveBeenCalledWith("local-1");
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
    expect(document.body.textContent).not.toContain("与成员共享");
    expect(document.body.textContent).not.toContain("加入项目");

    await act(async () => type(nameInput(), "demo"));
    await act(async () => submitButton().click());
    await flush();
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith("local-1");
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
    expect(onCreated).toHaveBeenCalledWith("local-1");
  });
});
