import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OutputLocationPolicy } from "../../../src/core/agent-runtime/tools/output-location.js";
import { ExecTool } from "../../../src/core/agent-runtime/tools/shell.js";
import { ExecSessionManager, WriteStdinTool } from "../../../src/core/agent-runtime/tools/exec-session.js";
import { WriteFileTool } from "../../../src/core/agent-runtime/tools/filesystem.js";
import { SetOutputDirectoryTool } from "../../../src/core/agent-runtime/tools/output-location.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { AgentHook } from "../../../src/core/agent-runtime/hook.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { SubagentManager } from "../../../src/core/agent-runtime/subagent.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { AsyncQueue, InboundMessage, MessageBus } from "../../../src/core/runtime-messages/index.js";
vi.mock("../../../src/tools/computer-use/desktop-screen-capture.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/tools/computer-use/desktop-screen-capture.js")>(),
  initializeDesktopScreenCapture: vi.fn().mockResolvedValue(undefined),
}));
let root: string, workspace: string, policy: OutputLocationPolicy;
let manager: ExecSessionManager;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-delivery-boundary-"));
  workspace = path.join(root, "workspace"); await fs.mkdir(workspace);
  policy = new OutputLocationPolicy(workspace, {}, []);
  manager = new ExecSessionManager();
});
afterEach(async () => {
  for (const id of [...manager.sessions.keys()]) await manager.stop(id);
  vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true });
});
class Provider extends LLMProvider {
  requests: any[] = [];
  constructor(private responses: LLMResponse[]) { super(); }
  getDefaultModel() { return "test-model"; }
  async chat(args: any) { return this.chatWithRetry(args); }
  async chatWithRetry(args: any) {
    this.requests.push(structuredClone({ messages: args.messages }));
    const response = this.responses.shift(); if (!response) throw new Error("Unexpected model request"); return response;
  }
}
let sequence = 0;
const reply = (content: string) => new LLMResponse({ content });
const call = (name: string, args: Record<string, unknown>) => new LLMResponse({ content: null,
  toolCalls: [new ToolCallRequest({ id: `delivery-${sequence++}`, name, arguments: args })], finishReason: "tool_calls" });
function tools() {
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool({ workspace, postWriteValidation: false }));
  registry.register(new SetOutputDirectoryTool()); return registry;
}
async function run(responses: LLMResponse[], options: Partial<AgentRunSpec> = {}) {
  const provider = new Provider(responses);
  return new AgentRunner(provider).run(new AgentRunSpec({ provider, outputLocation: policy, tools: tools(),
    workspace, messages: [{ role: "user", content: "generate files" }], ...options }));
}
function makeLoop(responses: LLMResponse[], maxIterations = 4) {
  return new AgentLoop({ bus: new MessageBus(), provider: new Provider(responses), workspace,
    model: "test-model", maxIterations, sessionDir: path.join(root, "sessions"),
    config: new Config({ fileMemory: { enabled: false }, memmyMemory: { enabled: false } }) });
}
async function waitUntilFile(target: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await fs.stat(target); return; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
  }
  throw new Error("background test file did not appear");
}

describe("managed generation completion", () => {
  it("does not certify an existing file while the managed writer is still running", async () => {
    const target = path.join(workspace, "report.md");
    const output = await new ExecTool({ workspace, sessionManager: manager }).execute({
      command: "printf partial > report.md; while [ ! -f release ]; do sleep 0.01; done; printf final > report.md",
      output_paths: ["report.md"], yield_time_ms: 0,
    }, { outputLocation: policy });
    const id = /session_id: (\S+)/.exec(output)![1];
    await waitUntilFile(target);
    expect(await policy.checkDelivery()).toEqual([]);
    expect(policy.pendingProducers()).toEqual([`exec:${id}`]);
    const result = await run([reply("all done")], { maxIterations: 1 });
    expect(result.stopReason).toBe("deliveryPending"); expect(result.finalContent).not.toBe("all done");
    await fs.writeFile(path.join(workspace, "release"), "go");
    await new WriteStdinTool({ manager }).execute({ session_id: id, yield_time_ms: 1000 });
    expect(manager.get(id)).toBeUndefined();
    expect(policy.pendingProducers()).toEqual([]);
    expect(await fs.readFile(target, "utf8")).toBe("final");
    expect((await run([reply("now complete")])).stopReason).toBe("completed");
  });

  it("waits for every writer of the same artifact and does not track read-only exec declarations", async () => {
    const exec = new ExecTool({ workspace, sessionManager: manager });
    await exec.execute({ command: "printf work > report.md; while [ ! -f release ]; do sleep 0.01; done",
      output_paths: ["report.md"], yield_time_ms: 0 }, { outputLocation: policy });
    await exec.execute({ command: "printf second > report.md", output_paths: ["report.md"], yield_time_ms: 1000 }, { outputLocation: policy });
    expect(policy.pendingProducers()).toHaveLength(1);
    const readPolicy = new OutputLocationPolicy(workspace, {}, []);
    await exec.execute({ command: "pwd", output_paths: [], yield_time_ms: 1000 }, { outputLocation: readPolicy });
    expect(readPolicy.hasWork).toBe(false);
  });
});

describe("fresh checks and publication", () => {
  it("runs write-capable finalization hooks before verification", async () => {
    const target = path.join(workspace, "report.md"); policy.recordFile(target, true); await fs.writeFile(target, "report");
    class Hook extends AgentHook { override async afterIteration() { await fs.rm(target, { force: true }); } }
    const result = await run([reply("complete"), reply("complete"), reply("complete")], { hook: new Hook() });
    expect(result.stopReason).toBe("toolError"); expect(result.finalContent).toContain(target);
    expect(result.messages.some(message => message.role === "assistant" && message.content === "complete")).toBe(false);
  });

  it("does not reuse a pass after an end-of-run hook changes the file", async () => {
    const target = path.join(workspace, "report.md"); policy.recordFile(target, true); await fs.writeFile(target, "report");
    class Hook extends AgentHook { override async afterRun() { await fs.rm(target); } }
    const result = await run([reply("complete")], { hook: new Hook() });
    expect(result.stopReason).toBe("toolError"); expect(result.finalContent).toContain(target);
  });

  it("processes input arriving during verification and checks the complete relocated manifest", async () => {
    const target = path.join(workspace, "report.md"), destination = path.join(root, "new");
    policy.recordFile(target, true); await fs.writeFile(target, "report");
    const quote = `改放 ${destination}`; let pending = false; let injected = false;
    const original = policy.checkDelivery.bind(policy);
    vi.spyOn(policy, "checkDelivery").mockImplementation(async () => {
      const result = await original(); if (!injected) pending = true; return result;
    });
    const result = await run([reply("old complete"), call("set_output_directory", { directory: destination, user_instruction: quote }),
      call("write_file", { path: path.join(destination, "report.md"), content: "updated", output_paths: [path.join(destination, "report.md")] }), reply("new complete")], {
      hasPendingInput: () => pending,
      injectionCallback: () => { if (!pending) return []; pending = false; injected = true;
        return [{ role: "user", content: quote, output_user_instruction: quote }]; },
    });
    expect(result.finalContent).toBe("new complete");
    expect(result.messages.some(message => message.role === "assistant" && message.content === "old complete")).toBe(false);
    expect(await original()).toEqual([]); expect(policy.directory).toBe(destination);
  });

  it("does not publish an old completion when the iteration limit leaves input pending", async () => {
    const target = path.join(workspace, "report.md"); policy.recordFile(target, true); await fs.writeFile(target, "report");
    const result = await run([reply("old complete")], { maxIterations: 1, hasPendingInput: () => true });
    expect(result.stopReason).toBe("maxIterations"); expect(result.finalContent).not.toBe("old complete");
  });

  it("checks the actual GUI and bus publication boundary, preserves obligations, then handles the follow-up", async () => {
    const target = path.join(workspace, "report.md");
    const agent = makeLoop([call("write_file", { path: target, content: "report", output_paths: [target] }), reply("old complete"),
      call("write_file", { path: target, content: "updated", output_paths: [target] }), reply("new complete")]);
    const queue = new AsyncQueue<InboundMessage>();
    agent.unifiedSession = false;
    const mirror = { user: vi.fn(), prepareSession: vi.fn().mockReturnValue(null), sessionKeyForMessage: vi.fn().mockReturnValue(null), progress: vi.fn(), final: vi.fn(), ended: vi.fn(), running: vi.fn(), turn: vi.fn().mockReturnValue({}) };
    agent.guiTranscriptMirror = mirror as any;
    const originalSave = agent.stateSave.bind(agent); let first = true;
    vi.spyOn(agent, "stateSave").mockImplementation(async context => {
      await originalSave(context);
      if (first) { first = false; queue.put(new InboundMessage({ channel: "telegram", chatId: "test", senderId: "human", content: "revise report" })); }
      return "ok";
    });
    await agent.dispatchMessage(new InboundMessage({ channel: "telegram", chatId: "test", senderId: "human", content: "generate report" }), () => false, null, queue);
    const messages: string[] = [];
    while (agent.bus.outboundSize) messages.push((await agent.bus.nextOutbound()).content);
    expect(messages).not.toContain("old complete"); expect(mirror.final).not.toHaveBeenCalled();
    const task = (agent as any).outputTasks.get("telegram:test") as OutputLocationPolicy;
    expect(task.hasOutputs).toBe(true);
    await agent.dispatchMessage(await agent.bus.nextInbound());
    while (agent.bus.outboundSize) messages.push((await agent.bus.nextOutbound()).content);
    expect(messages.filter(text => text === "new complete")).toHaveLength(1);
    expect(mirror.final).toHaveBeenCalledTimes(1);
    expect((agent as any).outputTasks.has("telegram:test")).toBe(false);
  });

  it("reattaches a cross-round child result and rejects missing child artifacts", async () => {
    const agent = makeLoop([reply("child says complete"), reply("child says complete"), reply("child says complete")], 3);
    const key = "cli:child-result";
    const child = policy.fork(), missing = path.join(workspace, "summary.xlsx"); child.recordFile(missing, true);
    (agent as any).outputTasks.set(key, policy);
    const result = await agent.processMessage(new InboundMessage({ channel: "system", senderId: "subagent", chatId: key,
      content: "child complete", sessionKeyOverride: key, metadata: { injectedEvent: "subagentResult", outputTaskId: policy.taskId, subagentTaskId: "child-1" } }), key);
    expect(result?.content).toContain(missing); expect(result?.content).toContain("核验未通过");
  });

  it("does not attach a late child result to a different task", async () => {
    const agent = makeLoop([]), key = "cli:late";
    (agent as any).outputTasks.set(key, new OutputLocationPolicy(workspace));
    const result = await agent.processMessage(new InboundMessage({ channel: "system", senderId: "subagent", chatId: key,
      content: "old complete", metadata: { outputTaskId: policy.taskId } }), key);
    expect(result).toBeNull();
  });
});


describe("delegation and cancellation", () => {
  it("returns child records with the original task id and never waits on itself or siblings", async () => {
    const missing = path.join(workspace, "parent.pdf"), childFile = path.join(workspace, "child.md");
    policy.recordFile(missing, true);
    policy.trackDelegation("subagent:sibling", () => false, async () => undefined);
    const bus = new MessageBus();
    const subagents = new SubagentManager({ bus, workspace, maxIterations: 3, provider: new Provider([
      call("write_file", { path: childFile, content: "child report", output_paths: [childFile] }), reply("child done"),
    ]) });
    await subagents.spawn({ task: "generate child report", workspace, sessionKey: "cli:parent", outputLocation: policy.fork() });
    await Promise.all([...subagents.runningTasks.values()]);
    const result = await bus.nextInbound();
    expect(result.metadata.outputTaskId).toBe(policy.taskId);
    expect(result.content).toContain("child done");
    expect(await policy.checkDelivery()).toEqual([missing]);
    expect(policy.pendingProducers()).toEqual(["subagent:sibling"]);
  });

  it("does not commit file success after cancellation during the save phase", async () => {
    const target = path.join(workspace, "report.md");
    const agent = makeLoop([call("write_file", { path: target, content: "report", output_paths: [target] }), reply("complete")]);
    const controller = new AbortController();
    const save = agent.stateSave.bind(agent);
    vi.spyOn(agent, "stateSave").mockImplementation(async context => { await save(context); controller.abort(); return "ok"; });
    await agent.dispatchMessage(new InboundMessage({ channel: "telegram", chatId: "cancel", senderId: "human", content: "generate" }), () => controller.signal.aborted, controller.signal);
    const output: string[] = [];
    while (agent.bus.outboundSize) output.push((await agent.bus.nextOutbound()).content);
    expect(output).not.toContain("complete");
  });
});
