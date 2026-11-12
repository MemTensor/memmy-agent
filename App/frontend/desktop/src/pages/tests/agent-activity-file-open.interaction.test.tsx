// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import { AgentThreadMessages } from "../agent-thread-messages.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("activity file rows open in the side panel", () => {
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
  });

  function render(message: AgentChatMessage, onOpenActivityFile = vi.fn()) {
    act(() => {
      root.render(
        <I18nProvider language="zh-CN">
          <AgentThreadMessages
            chatScopeKey="chat-activity-file"
            messages={[message]}
            onOpenActivityFile={onOpenActivityFile}
          />
        </I18nProvider>,
      );
    });
    return onOpenActivityFile;
  }

  it("opens the edited file from the activity row", () => {
    const onOpen = render({
      id: "edit-1",
      role: "tool",
      kind: "trace",
      content: "",
      fileEdits: [{
        call_id: "edit-1",
        tool: "edit_file",
        path: "tmp/analyze_tpl.py",
        absolute_path: "/work/tmp/analyze_tpl.py",
        status: "done",
        added: 51,
        deleted: 0,
      }],
      stoppedByUser: true,
    });

    const button = container.querySelector<HTMLButtonElement>("[data-activity-file-path]");
    expect(button?.textContent).toContain("tmp/analyze_tpl.py");
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith({ path: "/work/tmp/analyze_tpl.py", name: "analyze_tpl.py" });
  });

  it("opens a read file from its path field", () => {
    const onOpen = render({
      id: "read-1",
      role: "tool",
      kind: "trace",
      content: "",
      toolEvents: [{ phase: "end", name: "read_file", arguments: { path: "tmp/analyze_tpl.py" } }],
      stoppedByUser: true,
    });

    const button = container.querySelector<HTMLButtonElement>("[data-activity-file-path]");
    expect(button?.textContent).toContain("analyze_tpl.py");
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith({ path: "tmp/analyze_tpl.py", name: "analyze_tpl.py" });
  });

  it("shows raw short web output without JSON number rounding or formatting", () => {
    const raw = ' {"n":9007199254740993,  "x":1}  ';
    render({ id: "raw-web", role: "tool", kind: "trace", content: "", stoppedByUser: true,
      toolEvents: [{ phase: "end", name: "web_fetch", result: raw, display_text: raw }] });
    expect(container.querySelector('[data-detail="result"] pre')?.textContent).toBe(raw);
    expect(container.querySelector('details.agent-activity-tool-details')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('[data-activity-file-path]')).toBeNull();
  });
  it("opens a long web result from explicit metadata", () => {
    const onOpen = render({ id: "long-web", role: "tool", kind: "trace", content: "", stoppedByUser: true,
      toolEvents: [{ phase: "end", name: "web_fetch", result: "head and tail preview", arguments: { url: "https://example.com" },
        output_file: { path: "/work/.memmy/tool-results/session/raw.json", name: "raw.json", sizeBytes: 3000000, contentType: "application/json", complete: true, untrusted: true } }] });
    const button = container.querySelector<HTMLButtonElement>('[data-activity-file-path]');
    expect(button?.textContent).toContain("raw.json"); expect(button?.textContent).toContain("3,000,000");
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledWith({path:"/work/.memmy/tool-results/session/raw.json",name:"raw.json"});
  });
  it("never creates a saved-file link from a failure message", () => {
    render({ id: "failed-web", role: "tool", kind: "trace", content: "", stoppedByUser: true,
      toolEvents: [{ phase: "end", name: "web_fetch", result: "Full content NOT saved. /some/fake/path.json" }] });
    expect(container.querySelector('[data-activity-file-path]')).toBeNull();
  });

  it("does not turn deletes, search text, commands, or legacy summaries into file buttons", () => {
    const cases: AgentChatMessage[] = [
      {
        id: "delete-1",
        role: "tool",
        kind: "trace",
        content: "",
        fileEdits: [{ call_id: "delete-1", tool: "delete_file", path: "tmp/a.py", status: "done" }],
        stoppedByUser: true,
      },
      {
        id: "grep-1",
        role: "tool",
        kind: "trace",
        content: "",
        toolEvents: [{ phase: "end", name: "grep", arguments: { pattern: "TODO", path: "tmp/analyze_tpl.py" } }],
        stoppedByUser: true,
      },
      {
        id: "shell-1",
        role: "tool",
        kind: "trace",
        content: "",
        toolEvents: [{ phase: "end", name: "exec", arguments: { command: "python tmp/analyze_tpl.py" } }],
        stoppedByUser: true,
      },
      {
        id: "legacy-1",
        role: "tool",
        kind: "trace",
        content: "Read app.tsx",
        traces: ["Read app.tsx"],
        stoppedByUser: true,
      },
    ];

    for (const message of cases) {
      render(message);
      expect(container.querySelector("[data-activity-file-path]")).toBeNull();
    }
  });
});
