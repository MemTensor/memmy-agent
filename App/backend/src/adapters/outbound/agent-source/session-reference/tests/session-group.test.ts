import { describe, expect, it } from "vitest";
import {
  codexProjectGroup,
  createSessionGrouper,
  cursorWorkspaceGroup,
  directoryGroup,
  mainCheckoutOf
} from "../session-group.js";
import type { SourceAdapter } from "../../types.js";

describe("local session groups", () => {
  it("groups by working directory, named after the folder", () => {
    expect(directoryGroup("/Users/a/MemOS-WorkSpace/")).toEqual({ id: "/Users/a/MemOS-WorkSpace", label: "MemOS-WorkSpace", path: "/Users/a/MemOS-WorkSpace" });
    expect(directoryGroup(null)).toBeNull();
  });

  it("names a Cursor multi-folder workspace after its .code-workspace file", () => {
    expect(cursorWorkspaceGroup("/Users/a/.cursor/glassMultiRootWorkspaces/Memmy-Dev.code-workspace")).toMatchObject({ label: "Memmy-Dev" });
    expect(cursorWorkspaceGroup(null)).toBeNull();
  });

  it("puts a Codex session in the project with the longest matching root", () => {
    const projects = [
      { id: "p-product", name: "MemOS产品", roots: ["/w/MemOS_Product"] },
      { id: "p-lenovo", name: "联想", roots: ["/w/MemOS_Product/企业合作项目/联想/lenovo_chat"] }
    ];
    expect(codexProjectGroup(projects, "/w/MemOS_Product/企业合作项目/联想/lenovo_chat/docs")).toEqual({ id: "p-lenovo", label: "联想", path: null });
    expect(codexProjectGroup(projects, "/w/MemOS_Product/Product_Doc")).toMatchObject({ id: "p-product" });
    expect(codexProjectGroup(projects, "/w/MemOS_Products")).toBeNull();
    expect(codexProjectGroup(projects, null)).toBeNull();
  });

  it("leaves WorkBuddy one-off tasks outside every workspace", () => {
    const grouper = createSessionGrouper(adapter("workbuddy"));
    expect(grouper({ workspacePath: "/Users/a/WorkBuddy/2026-10-14-23-49-28", conversationId: "w-1" })).toBeNull();
    expect(grouper({ workspacePath: "/Users/a/MemOS-CLI", conversationId: "w-2" })).toMatchObject({ label: "MemOS-CLI" });
  });

  it("falls back to directories when the Codex state database cannot be read", () => {
    expect(createSessionGrouper(adapter("codex"))({ workspacePath: "/repo/app", conversationId: "c-1" })).toMatchObject({ id: "/repo/app", label: "app" });
  });

  it("files a git worktree under the repository it was created from", () => {
    expect(mainCheckoutOf("gitdir: /Users/a/GitHub/Project-Drive/.git/worktrees/main-2c81a4de\n")).toBe("/Users/a/GitHub/Project-Drive");
    expect(mainCheckoutOf("gitdir: /Users/a/repo/.git/modules/sub\n")).toBeNull();
    expect(mainCheckoutOf("not a git file")).toBeNull();
  });

  it("leaves Cursor chats outside every workspace when the global store cannot be read", () => {
    const grouper = createSessionGrouper(adapter("cursor"));
    expect(grouper({ workspacePath: null, conversationId: "composer-1" })).toBeNull();
    expect(grouper({ workspacePath: "/w/MemOS_Product", conversationId: "composer-2" })).toMatchObject({ label: "MemOS_Product" });
  });
});

function adapter(sourceId: string): SourceAdapter {
  return {
    descriptor: { sourceId, displayName: sourceId, builtin: true, dataPath: `/nonexistent-memmy-test/${sourceId}/sessions` },
    detect: async () => false,
    scan: async function* () {}
  };
}
