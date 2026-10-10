import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputLocationPolicy, SetOutputDirectoryTool } from "../../../../src/core/agent-runtime/tools/output-location.js";
import { ReadFileTool, WriteFileTool, EditFileTool } from "../../../../src/core/agent-runtime/tools/filesystem.js";
import { ApplyPatchTool } from "../../../../src/core/agent-runtime/tools/apply-patch.js";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";
import { SpawnTool } from "../../../../src/core/agent-runtime/tools/spawn.js";
import { AgentRunner, AgentRunSpec } from "../../../../src/core/agent-runtime/runner.js";
import { ToolRegistry } from "../../../../src/core/agent-runtime/tools/registry.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../../src/providers/base.js";
import { AgentLoop } from "../../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../../src/config/schema.js";
import { InboundMessage, MessageBus } from "../../../../src/core/runtime-messages/index.js";

let root: string, a: string, b: string;
let metadata: Record<string, any>, policy: OutputLocationPolicy;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-output-location-"));
  a = path.join(root, "A"); b = path.join(root, "B");
  await fs.mkdir(a); await fs.mkdir(b);
  metadata = {}; policy = new OutputLocationPolicy(a, metadata, []);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
const ctx = () => ({ outputLocation: policy });
async function select(directory = b) {
  const quote = `请保存到 ${directory}`;
  policy.addUserRequest(quote);
  return new SetOutputDirectoryTool().execute({ directory, user_instruction: quote }, ctx());
}

describe("output location routing", () => {
  it("writes to the workspace and reads external sources without confirmation", async () => {
    await fs.writeFile(path.join(b, "old.txt"), "old report");
    expect(await new ReadFileTool({ workspace: a }).execute({ path: path.join(b, "old.txt") })).toContain("old report");
    expect(await new WriteFileTool({ workspace: a }).execute({ path: "nested/new.txt", content: "new" }, ctx())).toContain("Successfully");
    expect(await policy.checkDelivery(`[report](${a}/nested/new.txt) [reference](${b}/old.txt)`)).toEqual([]);
  });
  it("rejects an external write before creating its parent and gives a usable destination", async () => {
    const target = path.join(b, "nested", "new.txt");
    const stopTurn = vi.fn();
    const result = await new WriteFileTool({ workspace: a }).execute({ path: target, content: "new" }, { ...ctx(), stopTurn });
    expect(result).toContain("outside allowed directory"); expect(result).toContain(a);
    expect(stopTurn).not.toHaveBeenCalled();
    await expect(fs.stat(path.dirname(target))).rejects.toThrow();
  });
  it("does not modify an external reference through edit_file", async () => {
    const target = path.join(b, "old.txt"); await fs.writeFile(target, "old");
    expect(await new EditFileTool({ workspace: a }).execute({ path: target, old_text: "old", new_text: "new" }, ctx())).toContain("outside allowed directory");
    expect(await fs.readFile(target, "utf8")).toBe("old");
  });
  it("uses a user's external destination immediately and persists it only in this session", async () => {
    const directory = path.join(b, "new folder");
    expect(await select(directory)).toContain("No additional confirmation");
    const target = path.join(directory, "new.txt");
    expect(await new WriteFileTool({ workspace: a }).execute({ path: target, content: "new" }, ctx())).toContain("Successfully");
    expect(await policy.checkDelivery(`[file](<${target}>)`)).toEqual([]);
    expect(new OutputLocationPolicy(a, metadata, []).directory).toBe(directory);
    expect(new OutputLocationPolicy(a, {}, []).directory).toBe(a);
    expect(new OutputLocationPolicy(b, metadata, []).directory).toBe(b);
  });
  it("rejects a remembered destination quote or a destination absent from the current input", async () => {
    policy.addUserRequest("重新写报告");
    expect(await policy.selectDirectory(b, `请保存到 ${b}`)).toContain("current user's");
    expect(await policy.selectDirectory(b, "重新写报告")).toContain("does not match");
    expect(policy.directory).toBe(a);
  });
  it("supports the user's named desktop folder without another question", async () => {
    policy.addUserRequest("保存到桌面");
    expect(await policy.selectDirectory(path.join(os.homedir(), "Desktop"), "保存到桌面")).toContain("Output directory");
  });
  it("requires final files at the user-selected location, while allowing workspace intermediates", async () => {
    await select();
    await new WriteFileTool({ workspace: a }).execute({ path: "report.txt", content: "new" }, ctx());
    expect(await policy.checkDelivery(`[report](${a}/report.txt)`)).toEqual([path.join(a, "report.txt")]);
    await new WriteFileTool({ workspace: a }).execute({ path: path.join(b, "report.txt"), content: "new" }, ctx());
    expect(await policy.checkDelivery(`[report](${b}/report.txt)`)).toEqual([]);
  });
  it("allows temporary intermediates, but rejects declaring them as final outputs", async () => {
    const temporary = new OutputLocationPolicy(a, {}, [b]);
    const target = path.join(b, "scratch.txt");
    expect(await temporary.checkWrite(target)).toBeNull();
    expect(await temporary.checkWrite(target, undefined, true)).toContain("outside allowed directory");
    expect(await temporary.checkDelivery(`[reference](${b}/unrelated.txt)`)).toEqual([]);
  });
  it("catches a symlink escape, including a missing output below the link", async () => {
    await fs.symlink(b, path.join(a, "outside"));
    expect(await policy.checkWrite(path.join(a, "outside", "new", "file.txt"))).toContain("outside allowed directory");
  });
  it("rechecks the actual destination at delivery if a directory link was replaced", async () => {
    const destination = path.join(root, "destination"); await fs.symlink(b, destination);
    await select(destination);
    const target = path.join(destination, "file.txt"); await fs.writeFile(target, "new"); policy.recordFile(target, true);
    await fs.unlink(destination); await fs.symlink(a, destination);
    expect(await policy.checkDelivery(`[file](${target})`)).toEqual([target]);
  });
  it("rejects missing declared artifacts even if the final response omits links", async () => {
    const target = path.join(a, "missing.txt"); policy.recordFile(target, true);
    expect(await policy.checkDelivery("完成了")).toEqual([target]);
  });
  it("accepts encoded file URLs and does not scan reference links inside document contents", async () => {
    const target = path.join(a, "new report.md");
    await new WriteFileTool({ workspace: a }).execute({ path: target, content: `[reference](${b}/old.pdf)` }, ctx());
    expect(await policy.checkDelivery(`[file](${pathToFileURL(target).href})`)).toEqual([]);
    expect(await policy.checkDelivery(`[file](<${target}>) [source](${b}/old.pdf)`)).toEqual([]);
  });
  it("inherits the selected location in delegated runs without sharing final artifact lists", async () => {
    await select(); const child = policy.fork();
    expect(child.directory).toBe(b);
    child.recordFile(path.join(b, "missing.txt"), true);
    expect(await policy.checkDelivery("done")).toEqual([]);
  });
  it("passes the output policy to spawned tasks", async () => {
    await select(); const spawn = vi.fn().mockResolvedValue("task-id");
    const tool = new SpawnTool({ manager: { spawn } });
    await tool.execute({ task: "generate output" }, ctx());
    expect(spawn.mock.calls[0][0].outputLocation.directory).toBe(b);
  });
  it("cancels before a write", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(new WriteFileTool({ workspace: a }).execute({ path: "file.txt", content: "new" }, { ...ctx(), abortSignal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    await expect(fs.stat(path.join(a, "file.txt"))).rejects.toThrow();
  });
  it("tracks patch outputs for the same delivery check", async () => {
    const tool = new ApplyPatchTool({ workspace: a });
    expect(await tool.execute({ input: "*** Begin Patch\n*** Add File: file.txt\n+new\n*** End Patch" }, ctx())).toContain("Patch applied");
    await select();
    expect(await policy.checkDelivery(`[file](${a}/file.txt)`)).toEqual([path.join(a, "file.txt")]);
  });
});

describe("command preflight", () => {
  it("rejects undeclared command outputs without starting a process", async () => {
    const spawn = vi.spyOn(ExecTool, "spawnProcess");
    expect(await new ExecTool({ workspace: a }).execute({ command: "echo test" }, ctx())).toContain("declare output_paths");
    expect(spawn).not.toHaveBeenCalled();
  });
  it("rejects an external command output before execution", async () => {
    const spawn = vi.spyOn(ExecTool, "spawnProcess");
    const target = path.join(b, "file.txt");
    expect(await new ExecTool({ workspace: a }).execute({ command: `echo test > '${target}'`, output_paths: [target] }, ctx())).toContain("outside allowed directory");
    expect(spawn).not.toHaveBeenCalled(); await expect(fs.stat(target)).rejects.toThrow();
  });
  it("runs a real workspace command and verifies its output", async () => {
    expect(await new ExecTool({ workspace: a }).execute({ command: "echo new > file.txt", output_paths: ["file.txt"] }, ctx())).toContain("Exit code: 0");
    expect(await policy.checkDelivery(`[file](${a}/file.txt)`)).toEqual([]);
  });
  it("uses a user-selected destination with a different command cwd", async () => {
    await select(); const target = path.join(b, "file.txt");
    expect(await new ExecTool({ workspace: a }).execute({ command: "echo new > file.txt", cwd: b, output_paths: ["file.txt"] }, ctx())).toContain("Exit code: 0");
    expect(await fs.readFile(target, "utf8")).toContain("new");
    expect(await policy.checkDelivery(`[file](${target})`)).toEqual([]);
  });
  it("checks declared artifacts after a managed command", async () => {
    const tool = new ExecTool({ workspace: a });
    await tool.execute({ command: "echo new > file.txt", output_paths: ["file.txt"], yield_time_ms: 1000 }, ctx());
    expect(await policy.checkDelivery(`[file](${a}/file.txt)`)).toEqual([]);
  });
});

class ScriptedProvider extends LLMProvider {
  calls: any[] = [];
  constructor(private responses: LLMResponse[]) { super(); }
  getDefaultModel() { return "test-model"; }
  async chat(args: any) { return this.chatWithRetry(args); }
  async chatWithRetry(args: any) { this.calls.push(args); const response = this.responses.shift(); if (!response) throw new Error("Unexpected model request"); return response; }
}
let sequence = 0;
const call = (name: string, args: Record<string, any>) => new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: `call-${sequence++}`, name, arguments: args })], finishReason: "tool_calls" });
const reply = (content: string) => new LLMResponse({ content });
function registry() { const tools = new ToolRegistry(); tools.register(new WriteFileTool({ workspace: a })); tools.register(new SetOutputDirectoryTool()); return tools; }
async function run(responses: LLMResponse[], options: Record<string, any> = {}) {
  const provider = new ScriptedProvider(responses);
  const result = await new AgentRunner(provider).run(new AgentRunSpec({ workspace: a, outputLocation: policy, tools: registry(), messages: [{ role: "user", content: "write a file" }], ...options }));
  return { provider, result };
}

describe("Runner delivery boundary", () => {
  it("recovers from an external write using the workspace without a permission exchange", async () => {
    const { result } = await run([call("write_file", { path: path.join(b, "file.txt"), content: "new" }), call("write_file", { path: "file.txt", content: "new" }), reply(`[file](${a}/file.txt)`)]);
    expect(result.stopReason).toBe("completed"); expect(await fs.readFile(path.join(a, "file.txt"), "utf8")).toBe("new");
    await expect(fs.stat(path.join(b, "file.txt"))).rejects.toThrow();
  });
  it("takes a requested directory and delivers there in the same turn", async () => {
    const quote = `保存到 ${b}`; policy.addUserRequest(quote);
    const { result } = await run([call("set_output_directory", { directory: b, user_instruction: quote }), call("write_file", { path: path.join(b, "file.txt"), content: "new" }), reply(`[file](${b}/file.txt)`)]);
    expect(result.stopReason).toBe("completed"); expect(result.error).toBeNull();
  });
  it("returns a bounded error for repeated invalid delivery, without persisting false success", async () => {
    const missing = path.join(a, "missing.txt"); policy.recordFile(missing, true);
    const { result, provider } = await run([reply("完成"), reply("完成"), reply("完成")]);
    expect(result.stopReason).toBe("toolError"); expect(provider.calls).toHaveLength(3);
    expect(result.messages.some(message => message.role === "assistant" && message.content === "完成")).toBe(false);
  });
  it("lets the model correct a delivery after verification fails", async () => {
    const missing = path.join(a, "missing.txt"); policy.recordFile(missing, true);
    const { result } = await run([reply(`[file](${missing})`), call("write_file", { path: "missing.txt", content: "new" }), reply(`[file](${missing})`)]);
    expect(result.stopReason).toBe("completed"); expect(result.finalContent).toContain(missing);
  });
  it("also verifies the max-iteration finalization response", async () => {
    const missing = path.join(a, "missing.txt"); policy.recordFile(missing, true);
    const { result } = await run([call("write_file", { path: "scratch.txt", content: "intermediate" }), reply(`[file](${missing})`)], { maxIterations: 1, maxIterationsFinalPrompt: "give a final response" });
    expect(result.stopReason).toBe("toolError"); expect(result.finalContent).toContain("核验未通过");
    expect(result.messages.some(message => message.role === "assistant" && message.content === `[file](${missing})`)).toBe(false);
  });
  it("accepts a live steering request to change the directory", async () => {
    const quote = `保存到 ${b}`; let pending = true;
    const { result } = await run([call("write_file", { path: "scratch.txt", content: "scratch" }), call("set_output_directory", { directory: b, user_instruction: quote }), call("write_file", { path: path.join(b, "file.txt"), content: "new" }), reply(`[file](${b}/file.txt)`)], { injectionCallback: () => { if (!pending) return []; pending = false; return [{ role: "user", content: quote, output_user_instruction: quote }]; } });
    expect(result.stopReason).toBe("completed"); expect(policy.directory).toBe(b);
  });
  it("does not treat a generated follow-up as a user destination request", async () => {
    const quote = `保存到 ${b}`; let pending = true;
    const { result, provider } = await run([call("write_file", { path: "scratch.txt", content: "scratch" }), call("set_output_directory", { directory: b, user_instruction: quote }), reply("已参考旧任务，当前输出目录保持工作区")], { injectionCallback: () => { if (!pending) return []; pending = false; return [{ role: "user", content: quote }]; } });
    expect(result.stopReason).toBe("completed"); expect(policy.directory).toBe(a);
    expect(provider.calls.at(-1).messages.some((message: any) => message.role === "tool" && message.content.includes("current user's destination"))).toBe(true);
  });
});

describe("AgentLoop output routing", () => {
  function loop(responses: LLMResponse[]) {
    return new AgentLoop({ bus: new MessageBus(), provider: new ScriptedProvider(responses),
      config: new Config({ fileMemory: { enabled: false }, memmyMemory: { enabled: false } }),
      workspace: a, model: "test-model", sessionDir: path.join(root, "sessions"), maxIterations: 8 });
  }
  it("uses live user input for an external destination and saves it for the next turn", async () => {
    const quote = `请保存到 ${b}`;
    const target = path.join(b, "report.txt");
    const agent = loop([call("set_output_directory", { directory: b, user_instruction: quote }),
      call("write_file", { path: target, content: "new" }), reply(`[report](${target})`),
      call("write_file", { path: target, content: "revised" }), reply(`[report](${target})`)]);
    const first = await agent.processDirect(quote, { sessionKey: "cli:output-test" });
    expect(first?.content).toContain(target);
    expect(await fs.readFile(target, "utf8")).toBe("new");
    const second = await agent.processDirect("修改报告", { sessionKey: "cli:output-test" });
    expect(second?.content).toContain(target);
    expect(await fs.readFile(target, "utf8")).toBe("revised");
  });
  it("routes a bus user request through the same policy without a confirmation turn", async () => {
    const quote = `请保存到 ${b}`; const target = path.join(b, "report.txt");
    const agent = loop([call("set_output_directory", { directory: b, user_instruction: quote }),
      call("write_file", { path: target, content: "new" }), reply(`[report](${target})`)]);
    await agent.dispatchMessage(new InboundMessage({ channel: "telegram", chatId: "output-test", senderId: "test-user", content: quote }));
    expect(await fs.readFile(target, "utf8")).toBe("new");
    const outbound = [];
    while (agent.bus.outboundSize) outbound.push(await agent.bus.consumeOutbound());
    expect(outbound.some(message => message.content.includes("需要外部写入权限"))).toBe(false);
  });
});
