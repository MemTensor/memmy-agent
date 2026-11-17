// @vitest-environment happy-dom
/**
 * The collaboration announcement queues behind Memmy's own new-user guidance.
 *
 * A fresh account walks through the scan permission, the improvement program, the product tour and the nickname step.
 * The announcement must not open while any of those is queued or on screen, and even after the last one is answered the
 * workspace has to stay quiet for a few seconds — a deferred step can land right after "onboarding completed", which is
 * how the card used to end up stacked under the improvement dialog.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDeferredGuidanceStep,
  writeDeferredGuidanceStep,
  writeGuidanceCompleted
} from "../../app/routes.js";
import {
  COLLAB_LAUNCH_PROMPT_STORAGE_KEY,
  resetCollabLaunchPromptRuntime,
  setCollabLaunchPromptOpen
} from "../../app/collab-launch-prompt-state.js";
import { getCollabProjectsSnapshot, resetCollabProjectsStore } from "../../app/collab-projects-store.js";
import { reportOnboardingPromptOpen, resetOnboardingPromptActivity } from "../../app/onboarding-activity.js";
import { ONBOARDING_QUIET_MS } from "../../app/use-onboarding-quiet.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CollabLaunchPromptHost } from "../collab-launch-prompt-host.js";

const mocks = vi.hoisted(() => ({
  state: {
    startup: { status: "ready" },
    navigation: { currentPath: "/main", windowVisible: true },
    bootstrap: {
      app: { userMode: "account" as "account" | "byok" | "unset" },
      onboarding: { completed: true }
    },
    account: { userId: "user-1" as string | null },
    agent: { lastTaskCompletion: null as { at: number } | null }
  }
}));

vi.mock("../../state/app-state.js", () => ({
  useAppState: () => ({ state: mocks.state, dispatch: vi.fn() })
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
  Object.defineProperty(window, name, { configurable: true, value: new MemoryStorage() });
}

describe("collab launch waits for the existing guidance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStorage("localStorage");
    resetStorage("sessionStorage");
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    resetOnboardingPromptActivity();
    mocks.state.startup.status = "ready";
    mocks.state.navigation.currentPath = "/main";
    mocks.state.navigation.windowVisible = true;
    mocks.state.bootstrap.app.userMode = "account";
    mocks.state.bootstrap.onboarding.completed = true;
    mocks.state.account.userId = "user-1";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    setCollabLaunchPromptOpen(false);
    resetCollabLaunchPromptRuntime();
    resetCollabProjectsStore();
    resetOnboardingPromptActivity();
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const renderHost = async () => act(async () => {
    root.render(
      <I18nProvider language="zh-CN">
        <CollabLaunchPromptHost />
      </I18nProvider>
    );
  });

  const advance = async (ms: number) => act(async () => {
    vi.advanceTimersByTime(ms);
  });

  const dialog = () => document.querySelector(".collab-launch-dialog");

  it("opens only after the workspace has stayed quiet for a few seconds", async () => {
    await renderHost();

    expect(dialog()).toBeNull();
    await advance(ONBOARDING_QUIET_MS - 1);
    expect(dialog()).toBeNull();

    await advance(1);
    expect(dialog()).not.toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
  });

  it("stays away while the improvement dialog or a later step is still queued", async () => {
    await act(async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "improvement");
    });
    await renderHost();

    await advance(ONBOARDING_QUIET_MS * 3);
    expect(dialog()).toBeNull();
    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBeNull();
  });

  it("starts over when a deferred step lands right after onboarding completes", async () => {
    await renderHost();
    // The account just finished onboarding; the next step is written a moment later.
    await advance(ONBOARDING_QUIET_MS / 2);
    await act(async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "improvement");
    });

    await advance(ONBOARDING_QUIET_MS * 2);
    expect(dialog()).toBeNull();

    // The person answers the improvement program, takes the tour and sets a nickname.
    await act(async () => {
      clearDeferredGuidanceStep(window.sessionStorage);
      writeGuidanceCompleted(window.localStorage);
    });
    await advance(ONBOARDING_QUIET_MS);
    expect(dialog()).not.toBeNull();
  });

  it("restarts the wait when another first-run prompt appears in the quiet window", async () => {
    await renderHost();
    await advance(ONBOARDING_QUIET_MS - 500);

    await act(async () => {
      reportOnboardingPromptOpen("history-launch", true);
    });
    await advance(ONBOARDING_QUIET_MS * 2);
    expect(dialog()).toBeNull();

    await act(async () => {
      reportOnboardingPromptOpen("history-launch", false);
    });
    await advance(ONBOARDING_QUIET_MS - 1);
    expect(dialog()).toBeNull();
    await advance(1);
    expect(dialog()).not.toBeNull();
  });

  it("does not offer the walkthrough demo while a step is still queued", async () => {
    await act(async () => {
      writeDeferredGuidanceStep(window.sessionStorage, "armed");
    });
    // `armed` has no UI of its own, so the card may still open; the demo has to wait for the next launch.
    await renderHost();
    await advance(ONBOARDING_QUIET_MS);

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".collab-launch-primary")?.click();
    });

    expect(window.localStorage.getItem(COLLAB_LAUNCH_PROMPT_STORAGE_KEY)).toBe("1");
    expect(getCollabProjectsSnapshot()).toMatchObject({
      createPending: true,
      createShareDefault: true,
      createDemo: false
    });
  });

  it("brings the walkthrough demo along once nothing is queued", async () => {
    await renderHost();
    await advance(ONBOARDING_QUIET_MS);

    await act(async () => {
      document.querySelector<HTMLButtonElement>(".collab-launch-primary")?.click();
    });

    const snapshot = getCollabProjectsSnapshot();
    expect(snapshot.createPending).toBe(true);
    expect(snapshot.createDemo).toBe(true);
  });
});
