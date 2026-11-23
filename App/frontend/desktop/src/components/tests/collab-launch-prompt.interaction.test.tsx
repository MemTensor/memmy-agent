// @vitest-environment happy-dom
/**
 * The one-time project-collaboration announcement.
 *
 * The card only opens the new-project dialog with sharing already on. It authorizes nothing: the only thing that needs
 * the "use shared projects in other agents" authorization is linking sessions, and the walkthrough asks for it at that
 * very step, so the card keeps one button and no explanation of an install it no longer starts.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimCollabLaunchPrompt,
  COLLAB_LAUNCH_PROMPT_STORAGE_KEY,
  hasCollabLaunchPromptClaimedThisRun,
  markCollabLaunchPromptSeen,
  resetCollabLaunchPromptRuntime,
  setCollabLaunchPromptOpen
} from "../../app/collab-launch-prompt-state.js";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabLaunchDialog } from "../collab-launch-dialog.js";
import { COLLAB_LAUNCH_CAPTIONS } from "../collab-launch-motion.js";
import { CollabLaunchPromptHost } from "../collab-launch-prompt-host.js";
import { GithubStarPromptHost } from "../github-star-prompt-host.js";

const mocks = vi.hoisted(() => ({
  guidanceDone: true,
  state: {
    startup: { status: "ready" },
    navigation: { currentPath: "/main", windowVisible: true },
    bootstrap: {
      app: { userMode: "account" as "account" | "byok" | "unset" },
      onboarding: { completed: true }
    },
    account: { userId: "user-1" as string | null },
    agent: { lastTaskCompletion: { at: 7 } as { at: number } | null }
  }
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: vi.fn() })
}));

vi.mock("../../app/use-guidance-progress.js", () => ({
  useGuidanceDone: () => mocks.guidanceDone
}));

// The quiet window itself is covered in collab-launch-prompt-guidance.wait.test.tsx; here the existing guidance is
// either over (and the workspace already settled) or still running.
vi.mock("../../app/use-onboarding-quiet.js", () => ({
  ONBOARDING_QUIET_MS: 4_000,
  useOnboardingQuiet: () => ({
    complete: mocks.guidanceDone,
    stepQueued: !mocks.guidanceDone,
    quiet: mocks.guidanceDone
  })
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();

  get length() {
    return this.data.size;
  }

  clear() {
    this.data.clear();
  }

  getItem(key: string) {
    return this.data.get(key) ?? null;
  }

  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.data.delete(key);
  }

  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

function resetStorage(name: "localStorage" | "sessionStorage"): void {
  const current = window[name];
  if (typeof current?.clear === "function") {
    current.clear();
    return;
  }
  Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
}

/** The new-project dialog is mounted by AppFrame, so the store flag is what this host hands over. */
function createProjectRequested(): { createOpen: boolean; createShareDefault: boolean } {
  const snapshot = getCollabProjectsSnapshot();
  return { createOpen: snapshot.createOpen, createShareDefault: snapshot.createShareDefault };
}

describe("collab launch prompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStorage("localStorage");
    resetStorage("sessionStorage");
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    mocks.guidanceDone = true;
    mocks.state.startup.status = "ready";
    mocks.state.navigation.currentPath = "/main";
    mocks.state.navigation.windowVisible = true;
    mocks.state.bootstrap.app.userMode = "account";
    mocks.state.bootstrap.onboarding.completed = true;
    mocks.state.account.userId = "user-1";
    mocks.state.agent.lastTaskCompletion = { at: 7 };
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    setCollabLaunchPromptOpen(false);
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    document.body.replaceChildren();
  });

  const renderHost = async (node = <CollabLaunchPromptHost />, language = "zh-CN") => act(async () => {
    root.render(<I18nProvider language={language}>{node}</I18nProvider>);
  });

  const dialog = () => document.querySelector<HTMLElement>(".collab-launch-dialog");
  const title = () => document.querySelector("#collab-launch-title")?.textContent?.trim();
  const stage = () => document.querySelector<HTMLElement>(".collab-launch-stage");
  const caption = () => document.querySelector(".collab-launch-caption__main")?.textContent?.trim();
  const captionSub = () => document.querySelector(".collab-launch-caption__sub")?.textContent?.trim();
  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const click = async (element: Element | null) => act(async () => {
    (element as HTMLElement).click();
  });

  it("opens on the first workspace visit and records it right away", async () => {
    await renderHost();

    expect(dialog()).not.toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("shows one page with the moving stage and the first caption", async () => {
    await renderHost();

    // 标题只剩读屏用的一份，卡面上直接是画面。
    expect(title()).toBe("项目协作");
    expect(stage()).not.toBeNull();
    // 画面本身对辅助技术隐藏：舞台里只有画面，进度条是例外。
    expect(stage()?.querySelector(".collab-launch-world")?.getAttribute("aria-hidden")).toBe("true");
    expect(caption()).toBe("人与各自的 Agent，组成独当一面的超级个体");
    expect(captionSub()).toBe("思考与执行的完整脉络，都沉淀在各自的原始会话里");
    // 只有一页：没有翻页、进度点，也没有旧版右侧示例。
    expect(document.querySelector(".collab-launch-count")).toBeNull();
    expect(document.querySelector(".collab-launch-dots")).toBeNull();
    expect(document.querySelector(".collab-launch-prev")).toBeNull();
    expect(document.querySelector(".collab-launch-visual")).toBeNull();
    // 原型里用来对照文案的切换条不进产品。
    expect(document.querySelector(".copy-switch")).toBeNull();
    expect(document.querySelector("[data-copy-switch]")).toBeNull();
    // 卡面不再有授权结果、重试、错误行与脚注。
    expect(document.querySelector("#collab-launch-footnote")).toBeNull();
    expect(document.querySelector(".collab-launch-status")).toBeNull();
  });

  it("keeps the picture hidden while the four progress pieces stay reachable", async () => {
    await renderHost();

    const progress = document.querySelector<HTMLElement>(".collab-launch-progress");
    expect(progress).not.toBeNull();
    expect(document.querySelectorAll(".collab-launch-progress__segment")).toHaveLength(4);
    // 四段可点，所以不在舞台的 aria-hidden 里；画面本身仍然不报给辅助技术。
    expect(progress?.closest("[aria-hidden='true']")).toBeNull();
    expect(progress?.querySelectorAll("button")).toHaveLength(4);
  });

  it("says which language the card is written in, for the browser's own text layout", async () => {
    await renderHost();
    expect(dialog()?.getAttribute("lang")).toBe("zh-CN");
  });

  it("uses the English copy in English", async () => {
    await renderHost(<CollabLaunchPromptHost />, "en-US");

    expect(title()).toBe("Shared projects");
    expect(primary()?.textContent?.trim()).toBe("New project");
    expect(caption()).toBe("A person and their own agents make a super individual");
    expect(captionSub())
      .toBe("The full trail of thought and execution stays in each person's own sessions");
  });

  it("opens the new-project dialog with sharing on, and authorizes nothing on the way", async () => {
    await renderHost();

    expect(primary()?.textContent?.trim()).toBe("新建项目");

    await click(primary());

    expect(dialog()).toBeNull();
    expect(createProjectRequested()).toEqual({ createOpen: true, createShareDefault: true });
    // The run's one announcement is spent, so the other large prompts wait for the next launch.
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(true);
  });

  it("closes on Escape without opening the new-project dialog", async () => {
    await renderHost();
    expect(dialog()).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(dialog()).toBeNull();
    expect(createProjectRequested().createOpen).toBe(false);
  });

  it("closes when the backdrop is clicked", async () => {
    await renderHost();

    await click(document.querySelector(".collab-launch-backdrop"));
    expect(dialog()).toBeNull();
  });

  it("stays away on the next launch once this computer saw it", async () => {
    markCollabLaunchPromptSeen(window.localStorage);
    await renderHost();

    expect(dialog()).toBeNull();
    expect(hasCollabLaunchPromptClaimedThisRun()).toBe(false);
  });

  it("shows up again after closing once the record is gone", async () => {
    await renderHost();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(dialog()).toBeNull();

    window.localStorage.removeItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY);
    await act(async () => root.unmount());
    root = createRoot(container);
    await renderHost();

    expect(dialog()).not.toBeNull();
  });

  it("does not offer it in API Key mode, and records nothing", async () => {
    mocks.state.bootstrap.app.userMode = "byok";
    await renderHost();

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("waits for a signed-in account", async () => {
    mocks.state.account.userId = null;
    await renderHost();

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("waits until the new-user guidance is done", async () => {
    mocks.guidanceDone = false;
    await renderHost();

    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("waits for a workspace route", async () => {
    mocks.state.navigation.currentPath = "/welcome";
    await renderHost();

    expect(dialog()).toBeNull();
  });

  it("holds the GitHub star card back while this run's announcement is claimed", async () => {
    claimCollabLaunchPrompt();
    await renderHost(<GithubStarPromptHost />);

    expect(document.querySelector(".github-star-prompt")).toBeNull();
  });

  it("leaves the GitHub star card alone on a run that never claimed the slot", async () => {
    await renderHost(<GithubStarPromptHost />);

    expect(document.querySelector(".github-star-prompt")).not.toBeNull();
  });
});

describe("collab launch card", () => {
  let container: HTMLDivElement;
  let root: Root;
  const close = vi.fn();
  const createProject = vi.fn();

  beforeEach(() => {
    close.mockClear();
    createProject.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const render = async (language = "zh-CN") => act(async () => {
    root.render(
      <I18nProvider language={language}>
        <CollabLaunchDialog onClose={close} onCreateProject={createProject} />
      </I18nProvider>
    );
  });

  const flush = async () => {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    }
  };

  const dialog = () => document.querySelector<HTMLElement>(".collab-launch-dialog");
  const caption = () => document.querySelector(".collab-launch-caption__main")?.textContent?.trim();
  const captionSub = () => document.querySelector(".collab-launch-caption__sub")?.textContent?.trim();
  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const click = async (element: Element | null) => {
    await act(async () => {
      (element as HTMLElement).click();
    });
    await flush();
  };
  const escape = async () => {
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
  };

  it("marks the card with the language it is written in, so Chinese can justify and English can break words", async () => {
    await render("en-US");
    await flush();
    expect(dialog()?.getAttribute("lang")).toBe("en");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await flush();
    expect(dialog()?.getAttribute("lang")).toBe("zh-CN");
  });

  it("offers a single button and nothing that authorizes", async () => {
    await render();
    await flush();

    // 授权只在引导的「关联会话」那一站发生：大卡上不再有问号，也没有任何后台授权。
    expect(primary()?.textContent?.trim()).toBe("新建项目");
    expect(document.querySelector(".collab-launch-help")).toBeNull();
    expect(document.querySelector(".collab-launch-popover")).toBeNull();

    await click(primary());
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it("plays one act again from its progress piece, without closing the card", async () => {
    await render();
    await flush();

    // 卡面上不再有「重播」按钮，重看靠左下角的四段进度。
    expect(document.querySelector(".collab-launch-replay")).toBeNull();
    const pieces = Array.from(document.querySelectorAll<HTMLButtonElement>(".collab-launch-progress__segment"));
    expect(pieces).toHaveLength(4);
    expect(pieces[0]?.getAttribute("aria-label")).toBe("从第 1 段重新播放：人与各自的 Agent，组成独当一面的超级个体");
    expect(pieces[3]?.getAttribute("aria-label")).toBe("从第 4 段重新播放：Agent 时代超级个体的协作方式");

    // 第四段是收尾一幕。
    await click(pieces[3] ?? null);

    // 跳到最后一幕的第一帧，字幕跟着换。
    expect(caption()).toBe("Agent 时代超级个体的协作方式");
    expect(captionSub()).toBe("协作不止于人的沟通，而是记忆在 Agent 之间直接流转");
    expect(dialog()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("drops the second line on the scene that has no subcaption", async () => {
    // 第三段只有主句。
    expect(COLLAB_LAUNCH_CAPTIONS[2]).toEqual({ main: "collabLaunch.scene3Main", sub: null });

    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => undefined);
    try {
      await render();
      await flush();
      expect(caption()).toBe("人与各自的 Agent，组成独当一面的超级个体");

      // 每帧最多推进 0.1 秒，走一百帧落在第三段。
      const start = performance.now();
      for (let index = 0; index < 100; index += 1) {
        const callback = frames.shift();
        await act(async () => {
          callback?.(start + index * 1000);
        });
      }

      expect(caption()).toBe("即使换用公共 Agent，前序过程仍要靠人手动搬运");
      expect(captionSub()).toBeUndefined();
      expect(document.querySelector(".collab-launch-caption__sub")).toBeNull();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
});
