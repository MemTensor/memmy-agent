// @vitest-environment happy-dom
/**
 * The one-time project-collaboration announcement.
 *
 * The card only opens the new-project dialog with sharing already on. A computer that has not authorized yet gets one
 * extra thing: a question mark beside the button explaining what that click authorizes. Nothing about the installs is
 * shown here — the authorization runs in the background and the board reports what did not finish.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabAgentAccessView, CollabAgentInstallResult, CollabClient } from "../../api/collab-client.js";
import {
  claimCollabLaunchPrompt,
  COLLAB_LAUNCH_PROMPT_STORAGE_KEY,
  hasCollabLaunchPromptClaimedThisRun,
  markCollabLaunchPromptSeen,
  resetCollabLaunchPromptRuntime,
  setCollabLaunchPromptOpen
} from "../../app/collab-launch-prompt-state.js";
import {
  getLaunchAuthorizationState,
  resetLaunchAuthorizationRuntime
} from "../../app/collab-launch-authorization.js";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabLaunchDialog } from "../collab-launch-dialog.js";
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
function createProjectRequested(): { createPending: boolean; createShareDefault: boolean } {
  const snapshot = getCollabProjectsSnapshot();
  return { createPending: snapshot.createPending, createShareDefault: snapshot.createShareDefault };
}

const AGENTS: CollabAgentAccessView["agents"] = [
  { sourceId: "claude_code", name: "Claude Code", available: true, enabled: true, installed: false, added: false },
  { sourceId: "codex", name: "Codex", available: true, enabled: true, installed: false, added: false }
];

function installResults(ok: (sourceId: string) => boolean = () => true): CollabAgentInstallResult[] {
  return AGENTS.map((agent) => ({ sourceId: agent.sourceId, name: agent.name, ok: ok(agent.sourceId) }));
}

/** A client that only answers the calls this card makes. */
function fakeCollab(options: {
  granted?: boolean;
  access?: () => Promise<CollabAgentAccessView>;
  grant?: () => Promise<{ view: CollabAgentAccessView; results: CollabAgentInstallResult[] }>;
} = {}): CollabClient {
  const view: CollabAgentAccessView = { granted: options.granted ?? false, askedInProject: false, agents: AGENTS };
  return {
    getAgentAccess: async () => options.access?.() ?? view,
    setAgentAccess: async () => options.grant?.() ?? { view: { ...view, granted: true }, results: installResults() },
    installAgentAccess: async () => ({ view: { ...view, granted: true }, results: installResults() })
  } as unknown as CollabClient;
}

describe("collab launch prompt", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetStorage("localStorage");
    resetStorage("sessionStorage");
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    resetLaunchAuthorizationRuntime();
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
    resetLaunchAuthorizationRuntime();
    document.body.replaceChildren();
  });

  const renderHost = async (node = <CollabLaunchPromptHost />, language = "zh-CN") => act(async () => {
    root.render(<I18nProvider language={language}>{node}</I18nProvider>);
  });

  const dialog = () => document.querySelector<HTMLElement>(".collab-launch-dialog");
  const title = () => document.querySelector("#collab-launch-title")?.textContent?.trim();
  const subtitle = () => document.querySelector(".collab-launch-copy h3")?.textContent?.trim();
  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const click = async (element: Element | null) => act(async () => {
    (element as HTMLElement).click();
  });

  it("opens on the first workspace visit and records it right away", async () => {
    await renderHost();

    expect(dialog()).not.toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("shows one page with the example and no paging controls", async () => {
    await renderHost();

    expect(title()).toBe("项目协作");
    expect(subtitle()).toBe("把团队工作放进同一个项目");
    expect(document.querySelector(".collab-launch-count")).toBeNull();
    expect(document.querySelector(".collab-launch-dots")).toBeNull();
    expect(document.querySelector(".collab-launch-prev")).toBeNull();
    expect(document.querySelector(".collab-launch-chat__user")?.textContent?.trim()).toBe("这个项目最近大家做到哪了？");
    expect(document.querySelector(".collab-launch-chat__lead")?.textContent?.trim()).toBe("本周项目里新增 5 个任务：");
    expect(document.querySelectorAll(".collab-launch-chat__agent li")).toHaveLength(3);
    expect(document.querySelector(".collab-launch-visual__caption")?.textContent?.trim())
      .toBe("团队做了什么，你的 Agent 都知道");
    // 卡面不再有授权结果、重试、错误行与脚注。
    expect(document.querySelector("#collab-launch-footnote")).toBeNull();
    expect(document.querySelector(".collab-launch-status")).toBeNull();
  });

  it("says which language the card is written in, for the browser's own text layout", async () => {
    await renderHost();
    expect(dialog()?.getAttribute("lang")).toBe("zh-CN");
  });

  it("uses the English copy in English", async () => {
    await renderHost(<CollabLaunchPromptHost />, "en-US");

    expect(title()).toBe("Shared projects");
    expect(subtitle()).toBe("Put the team's work in one project");
    expect(primary()?.textContent?.trim()).toBe("New project");
    expect(document.querySelector(".collab-launch-visual__caption")?.textContent?.trim())
      .toBe("What the team has done, your agent already knows");
  });

  it("only offers the project when no client is available, and opens the new-project dialog with sharing on", async () => {
    await renderHost();

    // No providers in this environment: the card cannot authorize, so it goes straight to the project.
    expect(primary()?.textContent?.trim()).toBe("新建项目");

    await click(primary());

    expect(dialog()).toBeNull();
    expect(createProjectRequested()).toEqual({ createPending: true, createShareDefault: true });
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
    expect(createProjectRequested().createPending).toBe(false);
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
    resetLaunchAuthorizationRuntime();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    resetLaunchAuthorizationRuntime();
    document.body.replaceChildren();
  });

  const render = async (collab: CollabClient | null, language = "zh-CN") => act(async () => {
    root.render(
      <I18nProvider language={language}>
        <CollabLaunchDialog collab={collab} onClose={close} onCreateProject={createProject} />
      </I18nProvider>
    );
  });

  const flush = async () => {
    for (let index = 0; index < 4; index += 1) {
      await act(async () => new Promise((resolve) => window.setTimeout(resolve, 0)));
    }
  };

  const dialog = () => document.querySelector<HTMLElement>(".collab-launch-dialog");
  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const help = () => document.querySelector<HTMLButtonElement>(".collab-launch-help");
  const popover = () => document.querySelector<HTMLElement>(".collab-launch-popover");
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
    await render(fakeCollab(), "en-US");
    await flush();
    expect(dialog()?.getAttribute("lang")).toBe("en");

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(fakeCollab());
    await flush();
    expect(dialog()?.getAttribute("lang")).toBe("zh-CN");
  });

  it("offers one button and a question mark on a computer that has not authorized yet", async () => {
    await render(fakeCollab());
    await flush();

    expect(primary()?.textContent?.trim()).toBe("新建项目");
    expect(help()).not.toBeNull();
    expect(help()?.getAttribute("aria-label")).toBe("授权说明");
    expect(help()?.getAttribute("aria-expanded")).toBe("false");
    expect(popover()).toBeNull();
  });

  it("keeps the question mark while the authorization cannot be read", async () => {
    await render(fakeCollab({ access: () => Promise.reject(new Error("offline")) }));
    await flush();

    expect(help()).not.toBeNull();
  });

  it("explains the authorization in a popover that one Escape closes before the card", async () => {
    await render(fakeCollab());
    await flush();

    await click(help());

    expect(popover()).not.toBeNull();
    expect(help()?.getAttribute("aria-expanded")).toBe("true");
    expect(popover()?.textContent).toContain("点「新建项目」即授权 Memmy：");
    expect(popover()?.textContent).toContain("读取本机 Agent 的任务记录");
    expect(popover()?.textContent).toContain("在这些 Agent 中安装协作组件");
    expect(popover()?.textContent).toContain("只有加入项目的任务会共享给成员，可在设置中撤销。");

    await escape();
    expect(popover()).toBeNull();
    expect(help()?.getAttribute("aria-expanded")).toBe("false");
    // 浮层先关，大卡还在。
    expect(dialog()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();

    await escape();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("toggles the popover from the question mark and keeps it open while it is used", async () => {
    await render(fakeCollab());
    await flush();

    await click(help());
    expect(popover()).not.toBeNull();

    await click(popover());
    expect(popover()).not.toBeNull();

    await click(help());
    expect(popover()).toBeNull();
  });

  it("closes the popover on a click outside it", async () => {
    await render(fakeCollab());
    await flush();

    await click(help());
    expect(popover()).not.toBeNull();

    await click(dialog()?.querySelector("h2") ?? null);
    expect(popover()).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(close).not.toHaveBeenCalled();
  });

  it("uses the English help copy in English", async () => {
    await render(fakeCollab(), "en-US");
    await flush();

    expect(help()?.getAttribute("aria-label")).toBe("About authorization");
    await click(help());
    expect(popover()?.textContent).toContain("New project lets Memmy:");
    expect(popover()?.textContent).toContain("Read tasks from agents on this computer");
    expect(popover()?.textContent).toContain("Only tasks added to a project are shared. Revoke in Settings.");
  });

  it("leaves the question mark out once this computer authorized", async () => {
    await render(fakeCollab({ granted: true }));
    await flush();

    expect(help()).toBeNull();
    expect(primary()?.textContent?.trim()).toBe("新建项目");
  });

  it("opens the new-project dialog and authorizes in the background in one click", async () => {
    const setAgentAccess = vi.fn(async () => ({
      view: { granted: true, askedInProject: false, agents: AGENTS },
      results: installResults()
    }));
    await render({ ...fakeCollab(), setAgentAccess } as unknown as CollabClient);
    await flush();

    await click(primary());

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(setAgentAccess).toHaveBeenCalledTimes(1);
    expect(setAgentAccess).toHaveBeenCalledWith(true);
    // 大卡关掉之后这次授权还在继续，结果交给看板。
    expect(getLaunchAuthorizationState()).toEqual({ inFlight: false, granted: true, failure: null });
  });

  it("does not authorize again on a computer that already did, nor without a client", async () => {
    const setAgentAccess = vi.fn();
    await render({ ...fakeCollab({ granted: true }), setAgentAccess } as unknown as CollabClient);
    await flush();

    await click(primary());
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(setAgentAccess).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    root = createRoot(container);
    createProject.mockClear();
    await render(null);
    await click(primary());
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it("closes without authorizing on Escape, the backdrop and the close button", async () => {
    const setAgentAccess = vi.fn();
    const collab = { ...fakeCollab(), setAgentAccess } as unknown as CollabClient;

    await render(collab);
    await escape();
    expect(close).toHaveBeenCalledTimes(1);
    expect(setAgentAccess).not.toHaveBeenCalled();
    expect(getLaunchAuthorizationState().inFlight).toBe(false);
  });
});
