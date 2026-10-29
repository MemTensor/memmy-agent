import { describe, expect, it } from "vitest";
import type { AgentChatMessage } from "../../state/agent-chat-slice.js";
import {
  clampThreadListWidth,
  clampThreadPanelWidth,
  closeThreadTab,
  collectConversationPrompts,
  collectThreadArtifacts,
  collectThreadFileChanges,
  completedFileEditRevision,
  joinThreadPath,
  normalizeThreadPath,
  openThreadTab,
  relativeThreadPath,
  sumThreadFileChanges,
  threadFileKind,
  threadPanelContentWidth,
  threadPanelOffset,
  threadPanelUsesOverlay,
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
    expect(threadPreviewKind("brief.docx")).toBe("document");
    expect(threadPreviewKind("sheet.XLSX")).toBe("document");
    expect(threadPreviewKind("bundle.ZIP")).toBe("unsupported");
    expect(threadPreviewKind("bundle.rar")).toBe("unsupported");
    for (const extension of ["tex", "bib", "sty"]) expect(threadPreviewKind(`review.${extension}`)).toBe("code");
  });

  it("opens every local file in the thread panel, including formats that cannot be previewed", () => {
    expect(threadTabForInAppPreview({
      name: "示例公司00000_年报测试.md",
      path: "/work/示例公司00000_年报测试.md",
      url: "http://127.0.0.1/api/media/report",
    })).toMatchObject({
      type: "file",
      name: "示例公司00000_年报测试.md",
      path: "/work/示例公司00000_年报测试.md",
      url: "http://127.0.0.1/api/media/report",
    });
    expect(threadTabForInAppPreview({ name: "notes.md", url: "http://127.0.0.1/api/media/notes" })?.id).toBe("file:http://127.0.0.1/api/media/notes");
    expect(threadTabForInAppPreview({ name: "交付物.xlsx", path: "/work/交付物.xlsx" })).toMatchObject({ name: "交付物.xlsx", type: "file" });
    expect(threadTabForInAppPreview({ name: "report.pdf", path: "/work/report.pdf" })).toMatchObject({ name: "report.pdf", type: "file" });
    expect(threadTabForInAppPreview({ name: "archive.zip", path: "/work/archive.zip" })).toMatchObject({ name: "archive.zip", type: "file" });
    expect(threadTabForInAppPreview({ name: "archive.rar", path: "/work/archive.rar" })).toMatchObject({ name: "archive.rar", type: "file" });
  });

  it("collects delivered assistant files, not files merely linked or edited", () => {
    const artifacts = collectThreadArtifacts([
      message({ role: "user", content: "[mine](/tmp/user-upload.pdf)" }),
      message({
        content: "See [source](/work/src/app.ts) and [report](/work/out/report.pdf).",
        fileEdits: [{ call_id: "edit", tool: "edit", path: "src/app.ts", status: "done", added: 2, deleted: 1 }],
        media: [
          { kind: "file", path: "/work/out/data.xlsx", name: "data.xlsx" },
          { kind: "file", path: "/work/out/script.py", name: "script.py" },
        ],
      }),
      message({
        content: "The existing report was revised.",
        media: [
          { kind: "file", path: "/work/out/report.pdf", name: "report.pdf" },
          { kind: "file", path: "/work/out/data.xlsx", name: "data.xlsx" },
        ],
      }),
      message({ kind: "trace", content: "[trace](/work/out/trace.log)" }),
    ]);

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["data.xlsx", "script.py", "report.pdf"]);
    expect(artifacts[2]).toMatchObject({ key: "/work/out/report.pdf", path: "/work/out/report.pdf" });
  });

  it("leaves written pages and markdown in changes until the assistant attaches them", () => {
    const messages = [
      message({
        id: "write-1",
        role: "tool",
        kind: "trace",
        content: "",
        fileEdits: [
          { call_id: "w1", tool: "write_file", path: "/work/index.html", absolute_path: "/work/index.html", status: "done", added: 1, deleted: 0 },
          { call_id: "py", tool: "write_file", path: "/work/app.py", absolute_path: "/work/app.py", status: "done", added: 4, deleted: 0 },
          { call_id: "ts", tool: "write", path: "/work/main.ts", absolute_path: "/work/main.ts", status: "done", added: 2, deleted: 0 },
        ],
      }),
      message({ id: "answer-1", content: "页面好了", isStreaming: false }),
      message({
        id: "write-2",
        role: "tool",
        kind: "trace",
        content: "",
        fileEdits: [
          { call_id: "w2", tool: "write_file", path: "/work/note.md", absolute_path: "/work/note.md", status: "done", added: 1, deleted: 0 },
          { call_id: "e2", tool: "edit_file", path: "/work/index.html", absolute_path: "/work/index.html", status: "done", added: 2, deleted: 1 },
          { call_id: "js", tool: "replace_in_file", path: "/work/app.py", absolute_path: "/work/app.py", status: "done", added: 1, deleted: 1 },
        ],
      }),
      message({ id: "answer-2", content: "改配色", isStreaming: true }),
    ];

    expect(collectThreadArtifacts(messages)).toEqual([]);
    expect(collectThreadFileChanges(messages).map((change) => change.name)).toEqual(["index.html", "app.py", "main.ts", "note.md"]);
  });

  it("keeps a code file in artifacts when the assistant delivers it", () => {
    const artifacts = collectThreadArtifacts([
      message({
        role: "tool",
        kind: "trace",
        content: "",
        fileEdits: [{ call_id: "py", tool: "write_file", path: "/work/app.py", absolute_path: "/work/app.py", status: "done", added: 1, deleted: 0 }],
      }),
      message({
        content: "脚本已附上",
        isStreaming: false,
        media: [{ kind: "file", path: "/work/app.py", name: "app.py" }],
      }),
    ]);

    expect(artifacts.map((artifact) => artifact.name)).toEqual(["app.py"]);
  });

  it("waits until the assistant finishes before offering a new artifact", () => {
    const attachment = { kind: "file", path: "/repo/report.md", name: "report.md" };
    expect(collectThreadArtifacts([message({ media: [attachment], isStreaming: true })])).toEqual([]);
    expect(collectThreadArtifacts([message({ media: [attachment], isStreaming: false })])).toHaveLength(1);
  });

  it("keeps delivered Windows drive paths usable", () => {
    const [artifact] = collectThreadArtifacts([message({ media: [{ kind: "file", path: "C:\\Users\\A\\report.pdf", name: "report.pdf" }] })]);

    expect(artifact).toMatchObject({ key: "C:/Users/A/report.pdf", path: "C:\\Users\\A\\report.pdf", name: "report.pdf" });
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

  it("refreshes only the preview whose completed write changed", () => {
    const tab = threadTabForPath("/repo/report.md");
    const pending = message({ fileEdits: [{ call_id: "write-1", tool: "write_file", path: "report.md", status: "editing" }] });
    const done = message({ fileEdits: [{ call_id: "write-1", tool: "write_file", path: "report.md", status: "done", added: 3 }] });
    const other = message({ fileEdits: [{ call_id: "write-2", tool: "write_file", path: "other.md", status: "done" }] });

    expect(collectThreadFileChanges([pending])).toEqual([]);
    expect(completedFileEditRevision(tab, [pending], "/repo")).toBe("");
    expect(completedFileEditRevision(tab, [done], "/repo")).toBe("write-1:3:0");
    expect(completedFileEditRevision(tab, [done, other], "/repo")).toBe("write-1:3:0");
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
    expect(relativeThreadPath("\\\\?\\C:\\Work", "C:/work/src/a.ts")).toBe("src/a.ts");
    expect(relativeThreadPath("C:/work", "\\\\?\\C:\\work\\src\\a.ts")).toBe("src/a.ts");
    expect(normalizeThreadPath("\\\\vmware-host\\Shared Folders\\proj\\demo_toolkit.py"))
      .toBe("//vmware-host/Shared Folders/proj/demo_toolkit.py");
    expect(relativeThreadPath("//VMWARE-HOST/Shared Folders/proj", "//vmware-host/Shared Folders/proj/demo_toolkit.py"))
      .toBe("demo_toolkit.py");
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
    expect(threadPanelUsesOverlay(620)).toBe(true);
    expect(threadPanelUsesOverlay(680)).toBe(false);
    expect(clampThreadListWidth(100, 624)).toBe(200);
    expect(clampThreadListWidth(500, 624)).toBe(344);
  });
});
