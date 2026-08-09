// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetMemoryOutput, MemoryListItem, ProjectContextPackOutput } from "@memmy/local-api-contracts";
import type { MemoryRuntimeClient } from "../../api/memory-runtime-client.js";
import type { MessageKey } from "../../i18n/messages.js";
import { ProjectContextPackDialog } from "../project-context-pack-dialog.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ProjectContextPackDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("loads the selected project pack and copies its Markdown", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const getProjectContextPack = vi.fn(async () => contextPack());
    const getMemory = vi.fn(async () => memoryDetail());

    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-1"
          projectName="Memmy Agent"
          client={dialogClient({ getProjectContextPack, getMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });

    expect(getProjectContextPack).toHaveBeenCalledWith("project-1");
    expect(document.body.textContent).toContain("Memmy Agent");
    expect(document.body.textContent).toContain("Ship desktop context pack entry");

    const copyButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("home.contextPack.copy"));
    expect(copyButton).toBeDefined();
    await act(async () => copyButton?.click());
    expect(writeText).toHaveBeenCalledWith("# Project Memory Pack: project-1");
    expect(document.body.textContent).toContain("home.contextPack.copied");
  });

  it("reloads when the open dialog is pointed at another project", async () => {
    const getProjectContextPack = vi.fn(async (projectId: string) => contextPack(projectId));
    const getMemory = vi.fn(async () => memoryDetail());

    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-1"
          projectName="Project One"
          client={dialogClient({ getProjectContextPack, getMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });
    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-2"
          projectName="Project Two"
          client={dialogClient({ getProjectContextPack, getMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });

    expect(getProjectContextPack.mock.calls.map(([projectId]) => projectId)).toEqual(["project-1", "project-2"]);
    expect(document.body.textContent).toContain("Project Two");
  });

  it("loads a clicked memory by id and renders its complete detail contract", async () => {
    const getProjectContextPack = vi.fn(async () => contextPack());
    const getMemory = vi.fn(async () => memoryDetail());

    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-1"
          projectName="Memmy Agent"
          client={dialogClient({ getProjectContextPack, getMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });
    await act(async () => memoryButton().click());

    expect(getMemory).toHaveBeenCalledWith("memory-1", { signal: expect.any(AbortSignal) });
    expect(document.body.textContent).toContain("Complete memory body");
    expect(document.body.textContent).toContain("L2");
    expect(document.body.textContent).toContain("codex");
    expect(document.body.textContent).toContain("memory-evidence-1");
    expect(document.body.textContent).toContain("memory-old-1");
    expect(document.body.textContent).toContain("memory-new-1");
    expect(document.body.textContent).toContain("repo/memmy-agent");
  });

  it("opens the relation graph, selects a linked node, and jumps to its memory detail", async () => {
    const getProjectContextPack = vi.fn(async () => contextPack());
    const getMemory = vi.fn(async (id: string) => memoryDetail(id));

    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-1"
          projectName="Memmy Agent"
          client={dialogClient({ getProjectContextPack, getMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });
    await act(async () => memoryButton().click());
    await act(async () => buttonContaining("home.contextPack.detail.openGraph").click());

    expect(document.body.textContent).toContain("Related evidence memory");
    expect(document.body.textContent).toContain("home.contextPack.graph.locate");
    const linkedNode = document.querySelector<HTMLElement>('.react-flow__node[data-id="memory-evidence-1"]');
    expect(linkedNode).not.toBeNull();
    await act(async () => linkedNode?.click());
    expect(document.body.textContent).toContain("memory-evidence-1");

    await act(async () => buttonContaining("home.contextPack.graph.openMemory").click());
    expect(getMemory.mock.calls.map(([id]) => id)).toEqual(["memory-1", "memory-evidence-1"]);
    expect(document.body.textContent).toContain("Complete memory body: memory-evidence-1");
  });

  it("confirms a historical restore and reloads detail from its recorded source version", async () => {
    const getProjectContextPack = vi.fn(async () => contextPack());
    const getMemory = vi.fn(async (id: string) => memoryDetail(id));
    const restoreMemory = vi.fn(async (id: string, targetVersion: number) => ({
      ok: true as const,
      id,
      version: 4,
      restoredVersion: targetVersion,
      changeSeq: 4,
      auditId: "audit-restore-1",
      serverTime: "2026-08-08T13:00:00.000Z"
    }));

    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-1"
          projectName="Memmy Agent"
          client={dialogClient({ getProjectContextPack, getMemory, restoreMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });
    await act(async () => memoryButton().click());
    await act(async () => buttonContaining("home.contextPack.history.restore").click());
    expect(document.body.textContent).toContain("home.contextPack.history.confirm");

    await act(async () => buttonContaining("home.contextPack.history.confirmAction").click());

    expect(restoreMemory).toHaveBeenCalledWith("memory-1", 1, {
      version: 3,
      reason: "restored from desktop context pack"
    });
    expect(getMemory).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("home.contextPack.history.success");
    expect(document.body.textContent).toContain("v1");
  });

  it("shows detail loading and recovers from a failed request", async () => {
    const pending = deferred<GetMemoryOutput>();
    let callCount = 0;
    const getMemory = vi.fn((_id: string, _options?: { signal?: AbortSignal }): Promise<GetMemoryOutput> => {
      callCount += 1;
      return callCount === 1 ? pending.promise : Promise.resolve(memoryDetail());
    });

    await renderDialog({ getMemory });
    await act(async () => memoryButton().click());
    expect(document.body.textContent).toContain("home.contextPack.detail.loading");

    await act(async () => pending.reject(new Error("service unavailable")));
    expect(document.body.textContent).toContain("home.contextPack.detail.error");

    const retry = buttonContaining("common.retry");
    await act(async () => retry.click());
    expect(getMemory).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Complete memory body");
  });

  it("closes detail and aborts its old request when the project changes", async () => {
    const pending = deferred<GetMemoryOutput>();
    const historyPending = deferred<ReturnType<typeof memoryHistory>>();
    const getProjectContextPack = vi.fn(async (projectId: string) => contextPack(projectId));
    const getMemory = vi.fn((_id: string, _options?: { signal?: AbortSignal }) => pending.promise);
    const getMemoryHistory = vi.fn((_id: string, _options?: { signal?: AbortSignal }) => historyPending.promise);
    const client = dialogClient({ getProjectContextPack, getMemory, getMemoryHistory });

    await act(async () => {
      root.render(<ProjectContextPackDialog open projectId="project-1" projectName="One" client={client} t={translate} onClose={() => undefined} />);
    });
    await act(async () => memoryButton().click());
    const signal = getMemory.mock.calls[0]?.[1]?.signal;
    const historySignal = getMemoryHistory.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    expect(historySignal).toBe(signal);

    await act(async () => {
      root.render(<ProjectContextPackDialog open projectId="project-2" projectName="Two" client={client} t={translate} onClose={() => undefined} />);
    });

    expect(signal?.aborted).toBe(true);
    expect(historySignal?.aborted).toBe(true);
    expect(document.body.textContent).not.toContain("home.contextPack.detail.title");
    expect(document.body.textContent).toContain("Two");
  });

  it("keeps an invalid memory response inside the detail error state", async () => {
    const getMemory = vi.fn(async (_id: string, _options?: { signal?: AbortSignal }): Promise<GetMemoryOutput> => {
      throw new Error("Invalid input: memory detail contract mismatch");
    });
    await renderDialog({ getMemory });
    await act(async () => memoryButton().click());

    expect(document.body.textContent).toContain("home.contextPack.detail.error");
    expect(document.body.textContent).toContain("home.contextPack.detail.back");
    expect(document.body.textContent).not.toContain("Complete memory body");
  });

  async function renderDialog(input: {
    getMemory: (id: string, options?: { signal?: AbortSignal }) => Promise<GetMemoryOutput>;
  }) {
    await act(async () => {
      root.render(
        <ProjectContextPackDialog
          open
          projectId="project-1"
          projectName="Memmy Agent"
          client={dialogClient({ getProjectContextPack: vi.fn(async () => contextPack()), getMemory: input.getMemory })}
          t={translate}
          onClose={() => undefined}
        />
      );
    });
  }
});

function translate(key: MessageKey): string {
  return key;
}

function contextPack(projectId = "project-1"): ProjectContextPackOutput {
  return {
    namespace: { projectId },
    conventions: [memoryListItem()],
    commands: [],
    architectureFacts: [],
    recentTasks: [{ id: "episode-1", title: "Ship desktop context pack entry", updatedAt: "2026-08-08T12:00:00.000Z" }],
    userPreferences: [],
    graph: {
      nodes: [
        memoryListItem(),
        { ...memoryListItem("memory-evidence-1", "Related evidence memory"), external: true }
      ],
      edges: [
        { sourceId: "memory-evidence-1", targetId: "memory-1", relation: "source" },
        { sourceId: "memory-1", targetId: "memory-evidence-1", relation: "supersedes", reason: "New evidence" }
      ]
    },
    markdown: `# Project Memory Pack: ${projectId}`,
    generatedAt: "2026-08-08T12:00:00.000Z"
  };
}

function memoryListItem(id = "memory-1", title = "Use stable detail contracts"): MemoryListItem {
  return {
    id,
    kind: "policy",
    memoryLayer: "L2",
    status: "activated",
    title,
    summary: "Load complete memory content by id.",
    tags: ["architecture"],
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    version: 3
  };
}

function memoryDetail(id = "memory-1"): GetMemoryOutput {
  return {
    item: {
      ...memoryListItem(id, id === "memory-1" ? "Use stable detail contracts" : "Related evidence memory"),
      body: `Complete memory body: ${id}`,
      sourceMemoryIds: ["memory-source-1"],
      policy: { evidenceMemoryIds: ["memory-evidence-1"], confidence: 0.9 },
      provenance: {
        sourceAgent: "codex",
        repository: "repo/memmy-agent",
        branch: "main",
        commit: "abc123",
        sourceMemoryIds: ["memory-source-1"],
        capturedAt: "2026-08-07T10:00:00.000Z"
      },
      supersession: {
        supersedesMemoryIds: ["memory-old-1"],
        supersededByMemoryId: "memory-new-1",
        reason: "New evidence"
      },
      metadata: { source: "codex" }
    },
    version: 3,
    etag: "memory-1-v3"
  };
}

function memoryHistory(id: string) {
  return {
    id,
    currentVersion: 3,
    items: [
      {
        seq: 3,
        version: 3,
        changeType: "updated",
        source: "panel.edit",
        createdAt: "2026-08-08T12:00:00.000Z",
        after: { info: { title: "Use stable detail contracts" }, memoryValue: "Current body" }
      },
      {
        seq: 1,
        version: 1,
        changeType: "created",
        source: "turn_complete",
        createdAt: "2026-08-07T10:00:00.000Z",
        after: { info: { title: "Original contract" }, memoryValue: "Original body" }
      }
    ],
    serverTime: "2026-08-08T12:00:00.000Z"
  };
}

function dialogClient(
  overrides: Partial<Pick<MemoryRuntimeClient, "getProjectContextPack" | "getMemory" | "getMemoryHistory" | "restoreMemory">> = {}
) {
  return {
    getProjectContextPack: async () => contextPack(),
    getMemory: async (id: string) => memoryDetail(id),
    getMemoryHistory: async (id: string) => memoryHistory(id),
    restoreMemory: async (id: string, targetVersion: number) => ({
      ok: true as const,
      id,
      version: 4,
      restoredVersion: targetVersion,
      changeSeq: 4,
      auditId: "audit-restore",
      serverTime: "2026-08-08T13:00:00.000Z"
    }),
    ...overrides
  };
}

function memoryButton(): HTMLButtonElement {
  return buttonContaining("Use stable detail contracts");
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.textContent?.includes(text));
  if (!button) throw new Error(`Missing button containing: ${text}`);
  return button;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
