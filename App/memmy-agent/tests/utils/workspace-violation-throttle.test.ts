import { describe, expect, it } from "vitest";
import {
  repeatedWorkspaceViolationError,
  workspaceViolationSignature,
} from "../../src/utils/runtime.js";

describe("workspaceViolationSignature", () => {
  it("uses path arguments for filesystem tools", () => {
    const a = workspaceViolationSignature("read_file", { path: "/Users/x/Downloads/01.md" });
    const b = workspaceViolationSignature("write_file", { path: "/Users/x/Downloads/01.md" });
    const c = workspaceViolationSignature("edit_file", { file_path: "/Users/x/Downloads/01.md" });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toContain("/users/x/downloads/01.md");
  });

  it("extracts the first absolute path from exec commands", () => {
    expect(workspaceViolationSignature("exec", { command: "cat /Users/x/Downloads/01.md && echo done" })).toContain(
      "/users/x/downloads/01.md",
    );
  });

  it("falls back to working_dir when exec commands have no absolute path", () => {
    expect(workspaceViolationSignature("exec", { command: "ls -la", working_dir: "/etc" })).toContain("/etc");
  });

  it("collides across filesystem and exec for the same target", () => {
    expect(workspaceViolationSignature("read_file", { path: "/Users/x/Downloads/01.md" })).toBe(
      workspaceViolationSignature("exec", { command: "cat /Users/x/Downloads/01.md" }),
    );
  });

  it("returns null for unknown tools without paths", () => {
    expect(workspaceViolationSignature("web_search", { query: "anything" })).toBeNull();
    expect(workspaceViolationSignature("exec", { command: "echo hello" })).toBeNull();
  });
});

describe("repeatedWorkspaceViolationError", () => {
  it("allows two attempts within budget", () => {
    const counts: Record<string, number> = {};
    const args = { path: "/Users/x/Downloads/01.md" };
    expect(repeatedWorkspaceViolationError("read_file", args, counts)).toBeNull();
    expect(repeatedWorkspaceViolationError("read_file", args, counts)).toBeNull();
  });

  it("escalates on the third repeated target attempt", () => {
    const counts: Record<string, number> = {};
    const args = { path: "/Users/x/Downloads/01.md" };
    repeatedWorkspaceViolationError("read_file", args, counts);
    repeatedWorkspaceViolationError("read_file", args, counts);
    const third = repeatedWorkspaceViolationError("read_file", args, counts);
    expect(third).toContain("refusing repeated workspace-bypass");
    expect(third).toContain("/users/x/downloads/01.md");
    expect(third).toContain("ask how they want to proceed");
  });

  it("keeps independent budgets per target", () => {
    const counts: Record<string, number> = {};
    repeatedWorkspaceViolationError("read_file", { path: "/Users/x/Downloads/01.md" }, counts);
    repeatedWorkspaceViolationError("read_file", { path: "/Users/x/Downloads/01.md" }, counts);
    expect(repeatedWorkspaceViolationError("read_file", { path: "/Users/x/Documents/notes.md" }, counts)).toBeNull();
  });

  it("collapses tool switching against the same target", () => {
    const switched: Record<string, number> = {};
    repeatedWorkspaceViolationError("read_file", { path: "/Users/x/Downloads/01.md" }, switched);
    repeatedWorkspaceViolationError("exec", { command: "cat /Users/x/Downloads/01.md" }, switched);
    const third = repeatedWorkspaceViolationError("exec", { command: "node -e \"require('node:fs').readFileSync('/Users/x/Downloads/01.md')\"" }, switched);
    expect(third).toContain("refusing repeated workspace-bypass");
  });
});
