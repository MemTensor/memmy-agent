// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { UserMemoriesSubPage } from "../user-memories-sub-page.js";
import { createMemoryRuntimeClientStub, panelItemsOutput } from "./fixtures.js";

describe("UserMemoriesSubPage interaction", () => {
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
  });

  it("loads the UserMemory layer and deletes the selected record", async () => {
    const item = {
      id: "user_memory_1",
      kind: "user_memory" as const,
      memoryLayer: "UserMemory" as const,
      status: "activated" as const,
      title: "我最喜欢的水果是苹果",
      summary: "我最喜欢的水果是苹果",
      tags: ["User Preference"],
      metadata: {
        memoryTypes: ["User Preference"],
        sourceTurnId: "turn-1",
        sourceTurnRefs: ["turn-1"]
      },
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      version: 1
    };
    const listPanelItems = vi.fn(async () => panelItemsOutput([item]));
    const deleteMemory = vi.fn(async () => ({
      ok: true as const,
      id: item.id,
      kind: item.kind,
      status: "deleted" as const,
      changeSeq: 1,
      syncCursor: "cursor-1",
      serverTime: "2026-08-17T00:00:00.000Z"
    }));
    const client = createMemoryRuntimeClientStub({ listPanelItems, deleteMemory });

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <UserMemoriesSubPage client={client} />
        </I18nProvider>
      );
    });

    expect(listPanelItems).toHaveBeenCalledWith({ layer: "UserMemory", page: 1 });
    act(() => container.querySelector<HTMLButtonElement>(".memory-card")?.click());
    const deleteButton = container.querySelector<HTMLButtonElement>(".memory-delete-button");
    act(() => deleteButton?.click());
    await act(async () => deleteButton?.click());

    expect(deleteMemory).toHaveBeenCalledWith(item.id);
  });

  it("uses the memory ID as the detail heading, avoids duplicate content, and closes from the backdrop", async () => {
    const active = {
      id: "user_memory_active",
      kind: "user_memory" as const,
      memoryLayer: "UserMemory" as const,
      status: "activated" as const,
      title: "我喜欢苹果",
      summary: "我喜欢苹果",
      tags: ["User Preference"],
      metadata: { memoryTypes: ["User Preference"], sourceTurnRefs: ["turn-1", "turn-2"] },
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      version: 1
    };
    const archived = {
      ...active,
      id: "user_memory_archived",
      status: "archived" as const,
      title: "我曾经喜欢梨",
      summary: "我曾经喜欢梨"
    };
    const client = createMemoryRuntimeClientStub({
      listPanelItems: vi.fn(async () => panelItemsOutput([active, archived]))
    });

    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <UserMemoriesSubPage client={client} />
        </I18nProvider>
      );
    });

    expect(container.querySelector(".memory-pill--user-memory-active")?.textContent).toBe("有效");
    expect(container.querySelector(".memory-pill--user-memory-archived")?.textContent).toBe("已归档");

    act(() => container.querySelector<HTMLButtonElement>(".memory-card")?.click());
    const drawer = container.querySelector(".memory-drawer--entry");
    expect(drawer).not.toBeNull();
    expect(drawer?.querySelector(".memory-drawer__eyebrow")?.textContent).toBe(active.id);
    expect(drawer?.querySelector(".memory-drawer__title")).toBeNull();
    expect(drawer?.textContent?.split(active.summary).length).toBe(2);
    expect(drawer?.textContent).toContain("表达次数2");
    act(() => container.querySelector<HTMLButtonElement>(".memory-drawer-backdrop__close")?.click());
    expect(container.querySelector(".memory-drawer")).toBeNull();
  });
});
