import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import {
  clampThreadListWidth,
  clampThreadPanelWidth,
  closeThreadTab,
  collectConversationPrompts,
  collectThreadArtifacts,
  collectThreadFileChanges,
  joinThreadPath,
  openThreadTab,
  relativeThreadPath,
  sumThreadFileChanges,
  threadFileKind,
  threadPanelContentWidth,
  threadPanelOffset,
  threadPreviewKind,
  threadTabForInAppPreview,
  threadTabForPath,
  type ThreadPanelTab,
} from "../agent-thread-panel-model.js";

function message(overrides: Partial<AgentChatMessage>): AgentChatMessage {
  return { id: overrides.id ?? `m-${Math.random()}`, role: "assistant", content: "", ...overrides };
}

function fileTab(id: string): ThreadPanelTab {
  return { id, type: "file", name: id };
}

describe("thread panel model", () => {
  it("classifies files by extension for icons and previews", () => {
    expect(threadFileKind("Report.PDF")).toBe("pdf");
    expect(threadFileKind("deck.pptx")).toBe("slides");
    expect(threadFileKind("main.tsx")).toBe("code");
    expect(threadFileKind("Makefile")).toBe("file");
    expect(threadPreviewKind("sheet.csv")).toBe("csv");
    expect(threadPreviewKind("config.yaml")).toBe("code");
    expect(threadPreviewKind("notes.md")).toBe("markdown");
    expect(threadPreviewKind("brief.docx")).toBe("unsupported");
  });

  it("opens markdown in the thread panel and leaves other files to the system app", () => {
    expect(threadTabForInAppPreview({
      name: "亿都00259_年报深度审阅.md",
      path: "/work/亿都00259_年报深度审阅.md",
      url: "http://127.0.0.1/api/media/report",
    })).toMatchObject({
      type: "file",
      name: "亿都00259_年报深度审阅.md",
      path: "/work/亿都00259_年报深度审阅.md",
      url: "http://127.0.0.1/api/media/report",
    });
    expect(threadTabForInAppPreview({ name: "notes.md", url: "http://127.0.0.1/api/media/notes" })?.id).toBe("file:http://127.0.0.1/api/media/notes");
    expect(threadTabForInAppPreview({ name: "交付物.xlsx", path: "/work/交付物.xlsx" })).toBeNull();
    expect(threadTabForInAppPreview({ name: "report.pdf", path: "/work/report.pdf" })).toBeNull();
  });

  it("collects assistant artifacts once, in conversation order", () => {
    const artifacts = collectThreadArtifacts([
      message({ role: "user", content: "[mine](/tmp/user-upload.pdf)" }),
      message({
        content: "See [report](/work/out/report.pdf), ![chart](/work/out/chart.png) and [site](https://example.com/about).",
        media: [{ kind: "file", path: "/work/out/data.xlsx", name: "data.xlsx" }],
      }),
      message({ content: "Again [the report](</work/out/report.pdf>) and [folder](/work/out)" }),
      message({ kind: "trace", content: "[trace](/work/out/trace.log)" }),
    ]);

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["data.xlsx", "report.pdf"]);
    expect(artifacts[1]).toMatchObject({ key: "/work/out/report.pdf", path: "/work/out/report.pdf" });
  });

  it("keeps Windows drive paths from file URLs usable", () => {
    const [artifact] = collectThreadArtifacts([message({ content: "[report](file:///C:/Users/A/report.pdf)" })]);

    expect(artifact).toMatchObject({ key: "C:/Users/A/report.pdf", path: "C:/Users/A/report.pdf", name: "report.pdf" });
    expect(threadTabForPath("file:///C:/Users/A/report.pdf").id).toBe("file:C:/Users/A/report.pdf");
    expect(threadTabForPath("C:\\Users\\A\\report.pdf").id).toBe("file:C:/Users/A/report.pdf");
  });

  it("aggregates completed file edits per file", () => {
    const changes = collectThreadFileChanges([
      message({
        fileEdits: [
          { call_id: "1", tool: "write", path: "src/a.ts", absolute_path: "/repo/src/a.ts", added: 10, deleted: 0, status: "done" },
          { call_id: "2", tool: "edit", path: "src/b.ts", added: 3, deleted: 1, status: "error" },
          { call_id: "3", tool: "edit", path: "src/c.ts", added: 1, pending: true },
        ],
      }),
      message({
        fileEdits: [
          { call_id: "4", tool: "edit", path: "src/a.ts", absolute_path: "/repo/src/a.ts", added: 2, deleted: 4, status: "done" },
          { call_id: "5", tool: "edit", path: "src/d.ts", unchanged: true },
        ],
      }),
    ]);

    expect(changes).toEqual([
      { key: "/repo/src/a.ts", path: "src/a.ts", absolutePath: "/repo/src/a.ts", name: "a.ts", added: 12, deleted: 4 },
    ]);
    expect(sumThreadFileChanges(changes)).toEqual({ added: 12, deleted: 4 });
  });

  it("lists user prompts as single-line history entries", () => {
    const prompts = collectConversationPrompts([
      message({ id: "u1", role: "user", content: "  first\n\nprompt  " }),
      message({ id: "a1", content: "answer" }),
      message({ id: "u2", role: "user", content: "   " }),
      message({ id: "u3", role: "user", content: "x".repeat(260) }),
    ]);

    expect(prompts.map((prompt) => prompt.messageId)).toEqual(["u1", "u3"]);
    expect(prompts[0]!.text).toBe("first prompt");
    expect(prompts[1]!.text).toHaveLength(200);
  });

  it("resolves workspace paths without escaping the root", () => {
    expect(joinThreadPath("/repo/app", "../docs/readme.md")).toBe("/repo/docs/readme.md");
    expect(joinThreadPath("/repo", "/abs/file.txt")).toBe("/abs/file.txt");
    expect(joinThreadPath("C:\\work", "out\\a.txt")).toBe("C:/work/out/a.txt");
    expect(relativeThreadPath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(relativeThreadPath("/repo", "/repository/a.ts")).toBeNull();
    expect(relativeThreadPath("C:\\Work", "c:/work/src/a.ts")).toBe("src/a.ts");
  });

  it("opens tabs once and activates the right neighbor when closing", () => {
    let state = openThreadTab({ tabs: [], activeId: null }, fileTab("a"));
    state = openThreadTab(state, fileTab("b"));
    state = openThreadTab(state, fileTab("c"));
    state = openThreadTab(state, fileTab("a"));
    expect(state.tabs.map((tab) => tab.id)).toEqual(["a", "b", "c"]);
    expect(state.activeId).toBe("a");

    state = closeThreadTab({ ...state, activeId: "b" }, "b");
    expect(state).toEqual({ tabs: [fileTab("a"), fileTab("c")], activeId: "c" });
    state = closeThreadTab(state, "c");
    expect(state.activeId).toBe("a");
    expect(closeThreadTab(state, "a")).toEqual({ tabs: [], activeId: null });
    expect(threadTabForPath("file:///repo/a.pdf").id).toBe("file:/repo/a.pdf");
  });

  it("keeps the panel at least 360px and the conversation at least 540px wide", () => {
    expect(clampThreadPanelWidth(200, 1248)).toBe(360);
    expect(clampThreadPanelWidth(900, 1248)).toBe(708);
    expect(threadPanelContentWidth(1248)).toBe(624);
    expect(threadPanelContentWidth(800)).toBe(360);
    expect(threadPanelOffset(624, 1248)).toBe(624);
    expect(threadPanelOffset(360, 600)).toBe(280);
    expect(clampThreadListWidth(100, 624)).toBe(200);
    expect(clampThreadListWidth(500, 624)).toBe(344);
  });
});
