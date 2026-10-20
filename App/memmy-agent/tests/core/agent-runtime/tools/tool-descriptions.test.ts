import { describe, expect, it } from "vitest";
import { ApplyPatchTool } from "../../../../src/core/agent-runtime/tools/apply-patch.js";
import { EditFileTool, ReadFileTool, WriteFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
import { FindFilesTool, GrepTool } from "../../../../src/core/agent-runtime/tools/search.js";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";
import { ListExecSessionsTool, WriteStdinTool } from "../../../../src/core/agent-runtime/tools/exec-session.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";

describe("coding tool descriptions", () => {
  it("documents replace_all restrictions only for true, consistent with parameter validation", () => {
    const registry = new ToolRegistry();
    registry.register(new EditFileTool());
    const description = registry.getDefinitions()[0].function.parameters.properties.replace_all.description;

    expect(description).toContain("When true, cannot be combined with non-null occurrence or line_hint, or used in create mode.");
    expect(description).toContain("When false, may be combined with occurrence or line_hint, or used in create mode.");

    for (const options of [{ old_text: "same", occurrence: 1 }, { old_text: "same", line_hint: 1 }, { old_text: "" }]) {
      const params = { path: "sample.txt", new_text: "changed", ...options };
      expect(registry.prepareCall("edit_file", { ...params, replace_all: false })[2]).toBeNull();
      expect(registry.prepareCall("edit_file", { ...params, replace_all: true })[2]).toContain(
        options.old_text === "" ? "create mode" : "cannot be used with replace_all=true",
      );
    }
  });

  it("steers editing priority", () => {
    const applyPatch = new ApplyPatchTool().description.toLowerCase();
    const editFile = new EditFileTool().description.toLowerCase();
    const writeFile = new WriteFileTool().description.toLowerCase();

    expect(applyPatch).toBe(
      "apply a patch to add, update, delete, or move one or more workspace-relative files.",
    );

    expect(editFile).toContain("small, exact replacement");
    expect(editFile).toContain("copied from read_file");
    expect(editFile).toContain("prefer apply_patch");

    expect(writeFile).toContain("replace an entire file");
    expect(writeFile).toContain("prefer apply_patch");
  });

  it("keeps the patch protocol in the input parameter description", () => {
    const tool = new ApplyPatchTool();
    const description = tool.parameters.properties.input.description;

    expect(description).toContain("*** Begin Patch");
    expect(description).toContain("*** Add File:");
    expect(description).toContain("*** Update File:");
    expect(description).toContain("*** Delete File:");
    expect(description).toContain("*** Move to:");
    expect(description).toContain("*** End of File");
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
