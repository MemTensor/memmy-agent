// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemmyAgentClient, WorkspaceEnvironmentSnapshot } from "../../api/memmy-agent-client.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { AgentEnvironmentPanel } from "../agent-environment-panel.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const snapshot: WorkspaceEnvironmentSnapshot = {
  scope_kind: "session",
  scope_key: "websocket:chat-1",
  cwd: "/workspace/memmy-agent",
  status: "ready",
  revision: "rev-1",
  captured_at: "2026-08-11T08:00:00.000Z",
  repository: {
    display_name: "memmy-agent",
    root: "/workspace/memmy-agent",
    head_sha: "84d10f8f00",
    branch: "zy_git_v1.0.7",
    detached: false,
    upstream: "origin/zy_git_v1.0.7",
    ahead: 1,
    behind: 0,
    worktree: "dirty",
  },
  changes: { file_count: 1, additions: 8, deletions: 1, conflicts: 0, staged: 0, unstaged: 1, untracked: 0 },
  goal: {
    goal_id: "8f59f58a-7295-4c34-8e03-55e7035a5a8d",
    base_head: "1111111111",
    base_branch: "main",
    goal_files: 1,
    preexisting_files: 0,
    uncertain_files: 0,
    verification: "not_run",
    completion_audit: "pending",
    baseline_status: "captured",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("AgentEnvironmentPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders repository and Goal evidence and loads a selected diff", async () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn(async () => undefined);
    const files = [{
      path: "src/panel.tsx",
      status: ".M",
      staged: false,
      unstaged: true,
      untracked: false,
      conflict: false,
      additions: 8,
      deletions: 1,
      attribution: "goal" as const,
    }];
    const client = {
      readWorkspaceEnvironmentDiff: vi.fn(async () => ({
        path: "src/panel.tsx",
        diff: "+export function Panel() {}",
        truncated: false,
        unavailable_reason: null,
      })),
    } as unknown as MemmyAgentClient;

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentEnvironmentPanel
            client={client}
            scope="session"
            scopeKey="websocket:chat-1"
            environment={{ snapshot, files, branches: ["zy_git_v1.0.7", "main"] }}
            loading={false}
            error={null}
            onRefresh={onRefresh}
            onClose={onClose}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("zy_git_v1.0.7");
    expect(container.textContent).toContain("Goal 证据");
    expect(container.textContent).toContain("src/panel.tsx");
    expect(container.querySelector('[role="dialog"]')?.getAttribute("aria-modal")).toBe("false");

    const fileButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("src/panel.tsx"));
    expect(fileButton).toBeTruthy();
    await act(async () => fileButton!.click());

    expect(client.readWorkspaceEnvironmentDiff).toHaveBeenCalledWith(
      { kind: "session", key: "websocket:chat-1" },
      "src/panel.tsx",
    );
    expect(container.textContent).toContain("export function Panel() {}");
    expect(container.querySelector('[data-kind="addition"]')).toBeTruthy();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside pointer but ignores its environment toggle", async () => {
    const onClose = vi.fn();
    const toggle = document.createElement("button");
    toggle.dataset.agentEnvironmentToggle = "";
    document.body.append(toggle);

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentEnvironmentPanel
            client={null}
            scope="session"
            scopeKey="websocket:chat-1"
            environment={{ snapshot, files: [], branches: ["zy_git_v1.0.7"] }}
            loading={false}
            error={null}
            onRefresh={vi.fn(async () => undefined)}
            onClose={onClose}
          />
        </I18nProvider>
      );
    });

    act(() => toggle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();

    act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(onClose).toHaveBeenCalledTimes(1);
    toggle.remove();
  });

  it("loads project environment before a Session exists", async () => {
    const projectSnapshot = { ...snapshot, scope_kind: "project" as const, scope_key: "project-1", goal: null };
    const client = {} as MemmyAgentClient;

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentEnvironmentPanel
            client={client}
            scope="project"
            scopeKey="project-1"
            environment={{ snapshot: projectSnapshot, files: [], branches: ["zy_git_v1.0.7", "main"] }}
            loading={false}
            error={null}
            onRefresh={vi.fn(async () => undefined)}
            onClose={vi.fn()}
          />
        </I18nProvider>
      );
    });

    expect(container.textContent).toContain("zy_git_v1.0.7");
    expect(container.textContent).not.toContain("Goal 证据");
  });

  it("ignores an older diff response after another file is selected", async () => {
    const first = deferred<{
      path: string;
      diff: string;
      truncated: boolean;
      unavailable_reason: null;
    }>();
    const second = deferred<{
      path: string;
      diff: string;
      truncated: boolean;
      unavailable_reason: null;
    }>();
    const client = {
      readWorkspaceEnvironmentDiff: vi.fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise),
    } as unknown as MemmyAgentClient;
    const files = ["src/a.ts", "src/b.ts"].map((path) => ({
      path,
      status: ".M",
      staged: false,
      unstaged: true,
      untracked: false,
      conflict: false,
      additions: 1,
      deletions: 0,
      attribution: "goal" as const,
    }));

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentEnvironmentPanel
            client={client}
            scope="session"
            scopeKey="websocket:chat-1"
            environment={{ snapshot, files, branches: ["zy_git_v1.0.7", "main"] }}
            loading={false}
            error={null}
            onRefresh={vi.fn(async () => undefined)}
            onClose={vi.fn()}
          />
        </I18nProvider>
      );
    });

    const buttons = [...container.querySelectorAll("button")];
    const firstButton = buttons.find((button) => button.textContent?.includes("src/a.ts"));
    const secondButton = buttons.find((button) => button.textContent?.includes("src/b.ts"));
    await act(async () => firstButton!.click());
    expect(container.textContent).toContain("正在加载 Diff…");
    await act(async () => secondButton!.click());
    await act(async () => second.resolve({ path: "src/b.ts", diff: "+new-b", truncated: false, unavailable_reason: null }));
    expect(container.textContent).toContain("new-b");

    await act(async () => first.resolve({ path: "src/a.ts", diff: "+stale-a", truncated: false, unavailable_reason: null }));
    expect(container.textContent).toContain("new-b");
    expect(container.textContent).not.toContain("stale-a");
  });
});
