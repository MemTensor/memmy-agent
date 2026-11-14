// @vitest-environment happy-dom

/**
 * 新建项目时是否带上演示标记：只有本人还没有任何在线项目、并且这次要共享时才带。
 * 带上也不代表一定演示——云端会再判断开关、名单与是否已经体验过，返回 `demo.active` 才真的开始。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCollabProject, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
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

  async function createNamed(name: string): Promise<void> {
    await act(async () => type(nameInput(), name));
    await act(async () => submitButton().click());
    await flush();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    resetCollabProjectsStore();
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
  });

  it("asks the cloud for the demo on the first shared project", async () => {
    await createNamed("项目协作体验");
    expect(mocks.createProject).toHaveBeenCalledWith("项目协作体验", "/Users/me/.memmy/local-projects/demo", { demo: true });
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
    expect(mocks.createProject).toHaveBeenCalledWith("第二个项目", "/Users/me/.memmy/local-projects/demo", { demo: false });
  });
});
