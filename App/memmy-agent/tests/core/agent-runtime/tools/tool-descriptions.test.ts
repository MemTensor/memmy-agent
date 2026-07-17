import { describe, expect, it } from "vitest";
import { ApplyPatchTool } from "../../../../src/core/agent-runtime/tools/apply-patch.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
import { FindFilesTool, GrepTool } from "../../../../src/core/agent-runtime/tools/search.js";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";
import { ListExecSessionsTool, WriteStdinTool } from "../../../../src/core/agent-runtime/tools/exec-session.js";

describe("coding tool descriptions", () => {
  it("steers editing priority", () => {
    const applyPatch = new ApplyPatchTool().description.toLowerCase();
    const editFile = new EditFileTool().description.toLowerCase();
    const writeFile = new WriteFileTool().description.toLowerCase();

    expect(applyPatch).toContain("default tool for code edits");
    expect(applyPatch).toContain("multi-file");
    expect(applyPatch).toContain("dryrun=true");
    expect(applyPatch).toContain("edit_file only for small exact replacements");

    expect(editFile).toContain("small, exact replacement");
    expect(editFile).toContain("copied from read_file");
    expect(editFile).toContain("prefer apply_patch");

    expect(writeFile).toContain("replace an entire file");
    expect(writeFile).toContain("prefer apply_patch");
  });

  it("steers discovery and shell usage", () => {
    const readFile = new ReadFileTool().description.toLowerCase();
    const findFiles = new FindFilesTool().description.toLowerCase();
    const grep = new GrepTool().description.toLowerCase();
    const execTool = new ExecTool().description.toLowerCase();
    const writeStdin = new WriteStdinTool().description.toLowerCase();
    const listSessions = new ListExecSessionsTool().description.toLowerCase();

    expect(readFile).toContain("find_files/list_dir first");
    expect(readFile).toContain("before editing");
    expect(findFiles).toContain("prefer it over shell find/ls");
    expect(grep).toContain("prefer this over shell grep");

    expect(execTool).toContain("tests, builds");
    expect(execTool).toContain("prefer read_file/find_files/grep");
    expect(execTool).toContain("apply_patch/write_file/edit_file");
    expect(execTool).toContain("yield_time_ms");

    expect(writeStdin).toContain("do not use this to start new commands");
    expect(writeStdin).toContain("wait_for");
    expect(listSessions).toContain("recover a session_id");
  });
});
