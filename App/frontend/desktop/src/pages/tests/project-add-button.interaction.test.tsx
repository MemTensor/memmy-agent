// @vitest-environment happy-dom

/**
 * 侧栏「项目」分组旁的加号直接打开新建项目弹窗：不再先弹出项目选择菜单。
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppClients } from "../../api/client-types.js";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { ApiClientsContext } from "../../app/providers.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TaskBusProvider } from "../../lib/task-bus.js";
import { appActions } from "../../state/app-actions.js";
import { AppStateProvider, useAppState } from "../../state/app-state.js";
import { AppFrame } from "../app-frame.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只需要一个可用的云地址：这一层验证的是点击路径，不发起请求。 */
const clients = {
  runtimeConfig: { baseUrl: "http://127.0.0.1:1", localToken: "token" },
  memmyAgent: null
} as unknown as AppClients;

function Shell() {
  const { dispatch } = useAppState();
  useEffect(() => {
    dispatch(appActions.bootstrapLoaded(mockBootstrap, "/main"));
  }, [dispatch]);
  return (
    <AppFrame title="项目">
      <div>工作区</div>
    </AppFrame>
  );
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
  }
}

describe("sidebar new-project button", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetCollabProjectsStore();
    Object.defineProperty(window, "memmy", {
      configurable: true,
      value: { platform: "darwin", getLogLevel: () => Promise.resolve("info") }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetCollabProjectsStore();
  });

  async function renderFrame(language: "zh-CN" | "en-US"): Promise<void> {
    await act(async () => {
      root.render(
        <AppStateProvider>
          <ApiClientsContext.Provider value={{ clients, setClients: () => undefined }}>
            <TaskBusProvider>
              <I18nProvider language={language}>
                <Shell />
              </I18nProvider>
            </TaskBusProvider>
          </ApiClientsContext.Provider>
        </AppStateProvider>
      );
    });
    await flush();
  }

  it.each([
    ["zh-CN", "新建项目", "创建项目"],
    ["en-US", "New project", "Create project"]
  ] as const)("opens the create dialog in one click (%s)", async (language, label, dialogTitle) => {
    await renderFrame(language);
    const button = container.querySelector<HTMLButtonElement>("button.app-frame-workspace-add");
    expect(button, "项目分组旁的加号按钮应该存在").toBeTruthy();
    expect(button!.getAttribute("aria-label")).toBe(label);
    expect(button!.getAttribute("title")).toBe(label);
    expect(button!.disabled).toBe(false);

    await act(async () => button!.click());
    await flush();

    // 不再有中间的项目选择菜单。
    expect(container.querySelector(".app-frame-workspace-picker-menu")).toBeNull();
    expect(container.querySelector(".home-project-picker__menu")).toBeNull();
    expect(container.querySelector(".home-project-picker__search")).toBeNull();
    // 新建项目弹窗直接打开，请求已被消费。
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog, "点一次就应该出现新建项目弹窗").toBeTruthy();
    expect(dialog!.textContent).toContain(dialogTitle);
    expect(getCollabProjectsSnapshot().createPending).toBe(false);
  });
});
