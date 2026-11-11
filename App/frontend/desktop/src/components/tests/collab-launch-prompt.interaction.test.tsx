// @vitest-environment happy-dom
/**
 * The 1.2.7 project-collaboration announcement: it appears once per computer on the first workspace visit, pages
 * left and right, and its last page opens the new-project dialog with sharing already on.
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
  const count = () => document.querySelector(".collab-launch-count")?.textContent?.trim();
  const title = () => document.querySelector("#collab-launch-title")?.textContent?.trim();
  const visualSource = () => document.querySelector<HTMLImageElement>(".collab-launch-visual img")?.getAttribute("src") ?? "";
  const previous = () => document.querySelector<HTMLButtonElement>(".collab-launch-prev");
  const primary = () => document.querySelector<HTMLButtonElement>(".collab-launch-primary");
  const click = async (element: Element | null) => act(async () => {
    (element as HTMLElement).click();
  });
  const nextPage = async () => click(primary());

  it("opens on the first workspace visit and records it right away", async () => {
    await renderHost();

    expect(dialog()).not.toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("starts on page 1 with the back button disabled", async () => {
    await renderHost();

    expect(count()).toBe("1 / 4");
    expect(previous()?.disabled).toBe(true);
  });

  it("shows the first page's illustration and swaps it when paging", async () => {
    await renderHost();

    expect(visualSource()).toContain("collab-launch-visual-1");
    expect(visualSource()).not.toContain(".en");

    await nextPage();
    expect(visualSource()).toContain("collab-launch-visual-2");
    expect(visualSource()).not.toContain(".en");
  });

  it("uses the English copy and illustration in English", async () => {
    await renderHost(<CollabLaunchPromptHost />, "en-US");

    expect(title()).toBe("Your team's tasks in one project");
    expect(visualSource()).toContain("collab-launch-visual-1.en");
  });

  it("pages forward and back", async () => {
    await renderHost();
    await nextPage();

    expect(count()).toBe("2 / 4");
    expect(previous()?.disabled).toBe(false);

    await click(previous());
    expect(count()).toBe("1 / 4");
    expect(previous()?.disabled).toBe(true);
  });

  it("ends on the create button, which opens the new-project dialog with sharing on", async () => {
    await renderHost();
    for (let step = 0; step < 3; step += 1) await nextPage();

    expect(count()).toBe("4 / 4");
    expect(primary()?.textContent?.trim()).toBe("新建协作项目");

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
