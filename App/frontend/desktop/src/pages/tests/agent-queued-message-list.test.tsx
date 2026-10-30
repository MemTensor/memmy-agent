// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentQueuedMessage } from "../../state/agent-chat-slice.js";
import { AgentQueuedMessageList, queuedComposerEditDecision, reorderQueuedMessageIds } from "../agent-queued-message-list.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stylesSourcePath = resolve(dirname(fileURLToPath(import.meta.url)), "../agent-queued-message-list.css");

function queued(
  clientRequestId: string,
  content: string,
  status: AgentQueuedMessage["status"] = "queued",
  media: AgentQueuedMessage["media"] = [],
  source: AgentQueuedMessage["source"] = { kind: "gui", channel: "websocket" },
  queueSurface: AgentQueuedMessage["queueSurface"] = null,
): AgentQueuedMessage {
  return { clientRequestId, content, status, media, queuedAt: Date.now(), source, queueSurface };
}

describe("queuedComposerEditDecision", () => {
  const textItem = queued("one", "先改一下这句话");

  it("restores text into an empty composer and leaves a busy composer queued", () => {
    expect(queuedComposerEditDecision({
      item: textItem,
      composerDraft: "",
      pendingAttachmentCount: 0
    })).toBe("restore");
    expect(queuedComposerEditDecision({
      item: textItem,
      composerDraft: "已经在写",
      pendingAttachmentCount: 0
    })).toBe("blocked");
    expect(queuedComposerEditDecision({
      item: textItem,
      composerDraft: "",
      pendingAttachmentCount: 1
    })).toBe("blocked");
  });

  it("ignores slash commands, attachments, and items that are already leaving the queue", () => {
    expect(queuedComposerEditDecision({
      item: queued("slash", " /status"),
      composerDraft: "",
      pendingAttachmentCount: 0
    })).toBe("ignore");
    expect(queuedComposerEditDecision({
      item: queued("file", "带附件", "queued", [{ url: "file://a", kind: "file" }]),
      composerDraft: "",
      pendingAttachmentCount: 0
    })).toBe("ignore");
    expect(queuedComposerEditDecision({
      item: queued("leaving", "先改一下这句话", "removing"),
      composerDraft: "",
      pendingAttachmentCount: 0
    })).toBe("ignore");
    expect(queuedComposerEditDecision({
      item: null,
      composerDraft: "",
      pendingAttachmentCount: 0
    })).toBe("ignore");
  });
});

describe("AgentQueuedMessageList", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRemove = vi.fn();
  const onEdit = vi.fn();
  const onSteer = vi.fn();

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

  function render(items: AgentQueuedMessage[], onReorder?: (orderedIds: string[]) => void): void {
    act(() => root.render(
      <I18nProvider language="zh-CN"><AgentQueuedMessageList
        items={items}
        label="Queued questions"
        removeLabel="Remove"
        editLabel="Edit"
        steerLabel="Steer"
        canSteer={true}
        attachmentOnlyLabel={(count) => `${count} attachments`}
        sourceLabels={{
          gui: "From GUI",
          tui: "From TUI",
          im: (channel) => `From ${channel}`,
          unknownIm: "From IM"
        }}
        onRemove={onRemove}
        onEdit={onEdit}
        onSteer={onSteer}
        onReorder={onReorder}
      /></I18nProvider>
    ));
  }

  it("renders no empty panel and one remove action per queued row", () => {
    render([]);
    expect(container.querySelector(".agent-queue-panel")).toBeNull();

    render([
      queued("one", "第一条"),
      queued("two", "第二条", "removing", [], { kind: "tui", channel: "websocket" }),
      queued(
        "three",
        "",
        "queued",
        [{ url: "file://a", kind: "file" }, { url: "file://b", kind: "file" }],
        { kind: "im", channel: "slack" }
      )
    ]);
    const rows = [...container.querySelectorAll<HTMLLIElement>(".agent-queue-item")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => [...row.querySelectorAll("button")].map(
      (button) => button.getAttribute("aria-label")
    ))).toEqual([
      ["Edit", "Remove"],
      ["Remove"],
      ["Remove"]
    ]);
    expect(rows[2]?.querySelector(".agent-queue-item__text")?.textContent).toBe("2 attachments");
    expect(rows[1]?.querySelector("button")?.disabled).toBe(true);
    const sources = rows.map((row) => row.querySelector<HTMLElement>(".agent-queue-item__source"));
    expect(sources.map((source) => source?.getAttribute("aria-label")))
      .toEqual([undefined, "From TUI", "From Slack"]);
    expect(sources[1]?.tabIndex).toBe(-1);
    expect(sources[2]?.tabIndex).toBe(-1);
    expect(rows[0]?.querySelector(".lucide-monitor")).toBeNull();
    expect(rows[1]?.querySelector(".lucide-square-terminal")).not.toBeNull();
    expect(rows[2]?.querySelector("img")?.getAttribute("src")).toContain("slack");

    act(() => rows[0]?.querySelector<HTMLButtonElement>(".agent-queue-item__remove")?.click());
    expect(onRemove).toHaveBeenCalledWith("one");
  });

  it("shows Steer and Edit only for editable GUI text, with Steer before Edit", () => {
    render([
      queued("gui", "GUI", "queued", [], { kind: "gui", channel: "websocket" }, "chat_composer"),
      queued(
        "media",
        "with file",
        "queued",
        [{ url: "file://a", kind: "file" }],
        { kind: "gui", channel: "websocket" },
        "chat_composer"
      ),
      queued("legacy", "Legacy"),
      queued("slash", " /status", "queued", [], { kind: "gui", channel: "websocket" }, "chat_composer"),
      queued("tui", "TUI", "queued", [], { kind: "tui", channel: "websocket" }, "chat_composer"),
      queued("im", "IM", "queued", [], { kind: "im", channel: "slack" }, "chat_composer")
    ]);
    const rows = [...container.querySelectorAll<HTMLLIElement>(".agent-queue-item")];
    expect(rows.map((row) => [...row.querySelectorAll("button")].map(
      (button) => button.getAttribute("aria-label")
    ))).toEqual([
      ["Steer", "Edit", "Remove"],
      ["Steer", "Remove"],
      ["Edit", "Remove"],
      ["Remove"],
      ["Remove"],
      ["Remove"]
    ]);
    expect(rows[0]?.querySelector(".agent-queue-item__steer span")).toBeNull();
    act(() => rows[0]?.querySelector<HTMLButtonElement>(".agent-queue-item__steer")?.click());
    act(() => rows[0]?.querySelector<HTMLButtonElement>(".agent-queue-item__edit")?.click());
    expect(onSteer).toHaveBeenCalledWith("gui");
    expect(onEdit).toHaveBeenCalledWith("gui");
  });

  it("uses icon-sized queue actions", () => {
    const styles = readFileSync(stylesSourcePath, "utf8");
    const sharedControlRule = styles.match(
      /\.agent-queue-item__remove,\s*\.agent-queue-item__steer,\s*\.agent-queue-item__edit\s*\{[^}]*\}/
    )?.[0] ?? "";
    const actionsRule = styles.match(/\.agent-queue-item__actions\s*\{[^}]*\}/)?.[0] ?? "";

    expect(sharedControlRule).toContain("display: inline-flex;");
    expect(sharedControlRule).toContain("width: 26px;");
    expect(sharedControlRule).toContain("height: 26px;");
    expect(sharedControlRule).toContain("padding: 0;");
    expect(sharedControlRule).not.toContain("color: var(--color-action-sky);");
    expect(actionsRule).toContain("justify-content: flex-end;");
    expect(actionsRule).toContain("gap: 4px;");
    expect(actionsRule).toContain("margin-left: auto;");
  });

  it("keeps an unconfirmed send in the same row and enables controls only after queue confirmation", () => {
    render([{ ...queued("pending", "发2000字给我", "sending"), queueSurface: "chat_composer" }]);
    const row = container.querySelector<HTMLLIElement>(".agent-queue-item");
    const controls = [...row!.querySelectorAll<HTMLButtonElement>("button")];
    expect(controls).toHaveLength(3);
    expect(controls.every((button) => button.disabled)).toBe(true);
    expect(queuedComposerEditDecision({
      item: queued("pending", "发2000字给我", "sending"),
      composerDraft: "",
      pendingAttachmentCount: 0
    })).toBe("ignore");

    render([{ ...queued("pending", "发2000字给我"), queueSurface: "chat_composer" }]);
    expect(container.querySelector(".agent-queue-item")).toBe(row);
    expect([...row!.querySelectorAll<HTMLButtonElement>("button")].every((button) => !button.disabled)).toBe(true);
  });

  it("falls back to MessageCircle for unknown or failed IM logos", () => {
    render([
      queued("unknown", "unknown", "queued", [], { kind: "im", channel: "unknown" }),
      queued("failed", "failed", "queued", [], { kind: "im", channel: "slack" })
    ]);
    const rows = [...container.querySelectorAll<HTMLLIElement>(".agent-queue-item")];
    expect(rows[0]?.querySelector(".lucide-message-circle")).not.toBeNull();
    expect(rows[0]?.querySelector(".agent-queue-item__source")?.getAttribute("aria-label")).toBe("From IM");
    const image = rows[1]?.querySelector<HTMLImageElement>("img");
    expect(image).not.toBeNull();
    act(() => image?.dispatchEvent(new Event("error")));
    expect(rows[1]?.querySelector(".lucide-message-circle")).not.toBeNull();
  });

  it("normalizes multiline display text and exposes a tooltip only for real overflow", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("agent-queue-item__text") ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("agent-queue-item__text")) return 0;
      return (this.textContent?.length ?? 0) > 12 ? 240 : 80;
    });

    render([
      queued("short", "  short\ntext "),
      queued("long", "  this is a very\nlong queued question  "),
      queued("tui", "from tui", "queued", [], { kind: "tui", channel: "websocket" })
    ]);
    const texts = [...container.querySelectorAll<HTMLElement>(".agent-queue-item__text")];
    expect(texts.map((element) => element.textContent)).toEqual([
      "short text",
      "this is a very long queued question",
      "from tui"
    ]);
    expect(texts[0]?.tabIndex).toBe(-1);
    expect(texts[0]?.getAttribute("aria-label")).toBeNull();
    expect(texts[1]?.tabIndex).toBe(0);
    expect(texts[1]?.getAttribute("aria-label")).toBe("this is a very long queued question");

    act(() => texts[1]?.focus());
    const tooltip = document.querySelector<HTMLElement>("#app-tooltip-singleton");
    expect(tooltip?.textContent).toBe("this is a very long queued question");
    expect(tooltip?.classList.contains("app-tooltip--hidden")).toBe(false);

    const source = container.querySelector<HTMLElement>(".agent-queue-item__source");
    act(() => source?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(tooltip?.textContent).toBe("From TUI");
  });

  it("keeps FIFO DOM order and scrolls its own list when an item is appended", () => {
    render([queued("one", "one")]);
    const list = container.querySelector<HTMLOListElement>(".agent-queue-list")!;
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 0, writable: true }
    });

    render([queued("one", "one"), queued("two", "two"), queued("three", "three")]);

    expect([...container.querySelectorAll(".agent-queue-item__text")].map((item) => item.textContent))
      .toEqual(["one", "two", "three"]);
    expect(list.scrollTop).toBe(400);
  });

  it("offers a drag grip and keyboard ordering only while all rows are queued", () => {
    const onReorder = vi.fn();
    render([queued("one", "first")], onReorder);
    expect(container.querySelector(".agent-queue-item__handle svg")).not.toBeNull();
    expect(container.querySelector("button.agent-queue-item__handle")).toBeNull();

    render([queued("one", "first"), queued("two", "second")], onReorder);
    const firstGrip = container.querySelector<HTMLButtonElement>("button.agent-queue-item__handle")!;
    expect(firstGrip.getAttribute("aria-label")).toContain("first");
    expect(firstGrip.closest("li")?.getAttribute("draggable")).toBe("true");
    act(() => firstGrip.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(onReorder).toHaveBeenCalledWith(["two", "one"]);

    render([queued("one", "first", "removing"), queued("two", "second")], onReorder);
    expect(container.querySelector("button.agent-queue-item__handle")).toBeNull();
    expect(container.querySelector(".agent-queue-item")?.getAttribute("draggable")).toBe("false");
  });

  it("moves an ID once and rejects no-op drops", () => {
    expect(reorderQueuedMessageIds(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(reorderQueuedMessageIds(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
    expect(reorderQueuedMessageIds(["a", "b", "c"], "a", "b", false)).toBeNull();
  });

  it("allows editing a reusable file without appending its filename to the queue text", () => {
    render([queued("file", "排队", "queued", [{
      kind: "file", name: "notes.docx", path: "/media/websocket/notes.docx"
    }])]);
    expect(container.querySelector(".agent-queue-item__text")?.textContent).toBe("排队");
    expect(container.querySelector(".agent-queue-item__edit")).not.toBeNull();
    expect(container.querySelector(".agent-queue-item__media [data-file-kind]")).not.toBeNull();
  });
});
