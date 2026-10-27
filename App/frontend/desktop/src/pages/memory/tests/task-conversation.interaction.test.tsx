// @vitest-environment happy-dom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelTaskDetailOutput } from "@memmy/local-api-contracts";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { TaskConversation } from "../task-conversation.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const turn = (id: string, text: string) => ({
  rawTurnId: id,
  turnId: id,
  episodeId: "task",
  createdAt: "2026-10-27T00:00:00Z",
  userText: text,
  moreFields: [] as const,
  toolCallCount: 0,
  toolResultCount: 0
});
function detail(id = "task"): PanelTaskDetailOutput {
  return {
    task: {
      id,
      episode: {},
      memoryIds: [],
      updatedAt: "2026-10-27T00:00:00Z",
      firstUserText: "",
      firstAssistantText: "",
      toolCallCount: 0
    },
    turns: [{ ...turn("recent", "recent message"), moreFields: ["userText"] }],
    nextCursor: "older",
    hasNewer: false,
    serverTime: "2026-10-27T00:00:00Z"
  };
}
describe("task conversation interaction", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(text))!;
  it("prepends distinct turns, anchors the scroll and exposes newer messages without replacing current content", async () => {
    const initial = detail();
    const earlier = {
      ...initial,
      turns: [
        { ...turn("old", "old message"), moreFields: [] },
        { ...turn("recent", "recent message"), moreFields: [] }
      ],
      nextCursor: undefined,
      hasNewer: true
    };
    const client = createMemoryRuntimeClientStub({ getPanelTaskDetail: vi.fn(async () => earlier) });
    await act(async () =>
      root.render(
        <I18nProvider language="en-US">
          <div className="memory-drawer__body">
            <TaskConversation client={client} initial={initial} />
          </div>
        </I18nProvider>
      )
    );
    const recent = container.querySelector('[data-turn-id="recent"]')!;
    vi.spyOn(recent, "getBoundingClientRect")
      .mockReturnValueOnce({ top: 100 } as DOMRect)
      .mockReturnValue({ top: 200 } as DOMRect);
    await act(async () => button("earlier").click());
    expect(container.querySelectorAll("[data-turn-id]")).toHaveLength(2);
    expect(container.textContent).toContain("old message");
    expect(container.textContent).toContain("recent message");
    expect(container.querySelector(".memory-drawer__body")!.scrollTop).toBe(100);
    expect(container.textContent?.toLowerCase()).toContain("new message");
  });
  it("loads full content in explicit chunks and clears expanded content on refresh", async () => {
    const field = vi
      .fn()
      .mockResolvedValueOnce({ text: "part one", revision: "r", nextOffset: 8, serverTime: "2026-10-27T00:00:00Z" })
      .mockResolvedValueOnce({ text: " part two", revision: "r", serverTime: "2026-10-27T00:00:00Z" });
    const fresh = detail();
    fresh.turns[0]!.userText = "changed preview";
    const client = createMemoryRuntimeClientStub({
      getPanelTaskField: field,
      getPanelTaskDetail: vi.fn(async () => fresh)
    });
    await act(async () =>
      root.render(
        <I18nProvider language="en-US">
          <TaskConversation client={client} initial={detail()} />
        </I18nProvider>
      )
    );
    await act(async () => button("Continue").click());
    await act(async () => button("Continue").click());
    expect(container.textContent).toContain("part one part two");
    expect(field.mock.calls[1]?.[2]).toMatchObject({ offset: 8, revision: "r" });
    await act(async () => button("Refresh").click());
    expect(container.textContent).not.toContain("part one");
    expect(container.textContent).toContain("changed preview");
  });
  it("ignores delayed older turns after switching task and supports retry", async () => {
    let finish!: (value: PanelTaskDetailOutput) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      )
      .mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(detail("B"));
    const client = createMemoryRuntimeClientStub({ getPanelTaskDetail: read });
    const render = (id: string) =>
      root.render(
        <I18nProvider language="en-US">
          <TaskConversation key={id} client={client} initial={detail(id)} />
        </I18nProvider>
      );
    await act(async () => render("A"));
    await act(async () => button("earlier").click());
    await act(async () => render("B"));
    await act(async () => finish({ ...detail("A"), turns: [{ ...turn("stale", "stale result"), moreFields: [] }] }));
    expect(container.textContent).not.toContain("stale result");
    await act(async () => button("earlier").click());
    expect(container.textContent).toContain("temporarily unavailable");
    await act(async () => button("earlier").click());
    expect(container.textContent).not.toContain("temporarily unavailable");
  });
  it("checks for new turns without replacing the conversation in StrictMode", async () => {
    vi.useFakeTimers();
    const checkPanelTask = vi.fn(async (_id: string, _signal?: AbortSignal) => ({
      latestTurnId: "new",
      serverTime: "2026-10-27T00:00:00Z"
    }));
    const getPanelTaskDetail = vi.fn(async () => detail());
    const client = createMemoryRuntimeClientStub({ checkPanelTask, getPanelTaskDetail });
    await act(async () =>
      root.render(
        <StrictMode>
          <I18nProvider language="en-US">
            <TaskConversation client={client} initial={detail()} />
          </I18nProvider>
        </StrictMode>
      )
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(checkPanelTask).toHaveBeenCalledTimes(1);
    expect(checkPanelTask.mock.calls[0]?.[1]?.aborted).toBe(false);
    expect(getPanelTaskDetail).not.toHaveBeenCalled();
    expect(container.textContent).toContain("recent message");
    expect(container.textContent?.toLowerCase()).toContain("new message");
  });
});
