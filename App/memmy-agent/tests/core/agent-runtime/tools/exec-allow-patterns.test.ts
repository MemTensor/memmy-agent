import { describe, expect, it } from "vitest";
import { ExecTool, ExecToolConfig } from "../../../../src/core/agent-runtime/tools/shell.js";

describe("exec allow patterns", () => {
  it("blocks rm -rf by default", async () => {
    const result = await new ExecTool().guardCommand("rm -rf /tmp/build", "/tmp");

    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("deny pattern filter");
  });

  it("lets matching allowPatterns bypass deny patterns", async () => {
    const tool = new ExecTool({ config: new ExecToolConfig({ allowPatterns: [String.raw`rm\s+-rf\s+/tmp/`] }) });

    expect(await tool.guardCommand("rm -rf /tmp/build", "/tmp")).toBeNull();
  });

  it("does not bypass deny patterns when allowPatterns do not match", async () => {
    const tool = new ExecTool({ config: new ExecToolConfig({ allowPatterns: [String.raw`rm\s+-rf\s+/opt/`] }) });

    const result = await tool.guardCommand("rm -rf /tmp/build", "/tmp");

    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("deny pattern filter");
  });

  it("appends extra deny patterns from config", async () => {
    const tool = new ExecTool({ config: new ExecToolConfig({ denyPatterns: [String.raw`\bping\b`] }) });

    expect(await tool.guardCommand("ping example.com", "/tmp")).not.toBeNull();
    expect(await tool.guardCommand("rm -rf /tmp/x", "/tmp")).not.toBeNull();
  });

  it("lets allowPatterns bypass extra deny patterns", async () => {
    const tool = new ExecTool({
      config: new ExecToolConfig({
        denyPatterns: [String.raw`\bping\b`],
        allowPatterns: [String.raw`\bping\s+example\.com\b`],
      }),
    });

    expect(await tool.guardCommand("ping example.com", "/tmp")).toBeNull();
  });

  it("treats allowPatterns as a whitelist", async () => {
    const tool = new ExecTool({ config: new ExecToolConfig({ allowPatterns: [String.raw`\becho\b`] }) });

    expect(await tool.guardCommand("echo hello", "/tmp")).toBeNull();
    const result = await tool.guardCommand("ls /tmp", "/tmp");
    expect(result).not.toBeNull();
    expect(result!.toLowerCase()).toContain("allowlist");
  });
});
