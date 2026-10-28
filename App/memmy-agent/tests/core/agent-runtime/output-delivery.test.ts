import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELIVERY_NOT_CONFIRMED,
  OUTPUT_FEEDBACK_KEY,
  OutputDelivery,
  SetOutputDirectoryTool,
  clearOutputDelivery,
  hasOutputObligations,
} from "../../../src/core/agent-runtime/tools/output-location.js";
import { ExecTool } from "../../../src/core/agent-runtime/tools/shell.js";
import { ExecSessionManager } from "../../../src/core/agent-runtime/tools/exec-session.js";
import { WriteFileTool } from "../../../src/core/agent-runtime/tools/filesystem.js";
import { ApplyPatchTool } from "../../../src/core/agent-runtime/tools/apply-patch.js";
import { ToolRegistry } from "../../../src/core/agent-runtime/tools/registry.js";
import { AgentRunner, AgentRunSpec } from "../../../src/core/agent-runtime/runner.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { Config } from "../../../src/config/schema.js";
import { InboundMessage, MessageBus, OutboundMessage } from "../../../src/core/runtime-messages/index.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { MessageTool } from "../../../src/core/agent-runtime/tools/message.js";
import { SessionManager } from "../../../src/core/session/manager.js";
import { GoalRuntime } from "../../../src/core/agent-runtime/goal-runtime.js";
import { cmdNew, cmdStop } from "../../../src/command/builtin.js";
import { AgentHook, type AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { withProgressCapabilities } from "../../../src/utils/progress-events.js";

vi.mock("../../../src/tools/computer-use/desktop-screen-capture.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/tools/computer-use/desktop-screen-capture.js")>(),
  initializeDesktopScreenCapture: vi.fn().mockResolvedValue(undefined),
}));

let root: string;
let workspace: string;
let manager: ExecSessionManager;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "memmy-output-delivery-")));
  workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  manager = new ExecSessionManager();
});

afterEach(async () => {
  for (const id of [...manager.sessions.keys()]) await manager.stop(id);
  await fs.rm(root, { recursive: true, force: true });
});

let sequence = 0;
const reply = (content: string) => new LLMResponse({ content });
const call = (name: string, args: Record<string, unknown>) => new LLMResponse({
  content: null,
  toolCalls: [new ToolCallRequest({ id: `delivery-${sequence++}`, name, arguments: args })],
  finishReason: "tool_calls",
});

class ScriptedProvider extends LLMProvider {
  requests: any[] = [];
  constructor(private readonly responses: LLMResponse[]) { super(); }
  getDefaultModel() { return "test-model"; }
  async chat(args: any) { return this.chatWithRetry(args); }
  async chatWithRetry(args: any) {
    this.requests.push(structuredClone({ messages: args.messages, tools: args.tools }));
    const response = this.responses.shift();
    if (!response) throw new Error("Unexpected model request");
    return response;
  }
}

function registry() {
  const tools = new ToolRegistry();
  tools.register(new WriteFileTool({ workspace, postWriteValidation: false }));
  tools.register(new ApplyPatchTool({ workspace }));
  tools.register(new ExecTool({ workspace, sessionManager: manager }));
  tools.register(new SetOutputDirectoryTool());
  return tools;
}

async function run(responses: LLMResponse[], delivery: OutputDelivery, maxIterations = 8) {
  const provider = new ScriptedProvider(responses);
  const result = await new AgentRunner(provider).run(new AgentRunSpec({
    provider, tools: registry(), workspace, outputLocation: delivery, maxIterations,
    messages: [{ role: "system", content: "base prompt" }, { role: "user", content: "make the files" }],
  }));
  return { result, provider };
}

describe("OutputDelivery", () => {
  it("checks the registered paths, including names with brackets, not the reply text", async () => {
    const delivery = new OutputDelivery({}, workspace);
    expect(await delivery.declare(["report (final).pdf", "data[1].xlsx"])).toBeNull();
    await fs.writeFile(path.join(workspace, "report (final).pdf"), "pdf");
    const problem = await delivery.verify();
    expect(problem).toContain(DELIVERY_NOT_CONFIRMED);
    expect(problem).toContain(path.join(workspace, "data[1].xlsx"));
    expect(problem).not.toContain("report (final).pdf");
    await fs.writeFile(path.join(workspace, "data[1].xlsx"), "xlsx");
    expect(await delivery.verify()).toBeNull();
  });

  it("accumulates declarations; [] and omissions never shrink the list", async () => {
    const metadata: Record<string, any> = {};
    const delivery = new OutputDelivery(metadata, workspace);
    await delivery.declare(["a.pdf"]);
    await delivery.declare([]);
    await delivery.declare(["b.xlsx", "a.pdf"]);
    expect(metadata.outputDelivery.files).toEqual(["a.pdf", "b.xlsx"]);
  });

  it("rejects final files outside the output directory, including through a symlink", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace, "link"));
    const metadata: Record<string, any> = {};
    const delivery = new OutputDelivery(metadata, workspace);
    expect(await delivery.declare([path.join(outside, "x.pdf")])).toMatch(/outside the output directory/);
    expect(await delivery.declare(["link/x.pdf"])).toMatch(/outside the output directory/);
    expect(hasOutputObligations(metadata)).toBe(false);
  });

  it("re-checks the declared symlink, not the file it pointed to when declared", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(workspace, "canonical.md"), "report");
    await fs.writeFile(path.join(outside, "elsewhere.md"), "report");
    const link = path.join(workspace, "report.md");
    await fs.symlink(path.join(workspace, "canonical.md"), link);
    const metadata: Record<string, any> = {};
    const delivery = new OutputDelivery(metadata, workspace);
    expect(await delivery.declare(["report.md"])).toBeNull();
    expect(metadata.outputDelivery.files).toEqual(["report.md"]);
    expect(await delivery.verify()).toBeNull();

    await fs.rm(link);
    await fs.symlink(path.join(outside, "elsewhere.md"), link);
    expect(await delivery.verify()).toContain(link);

    await fs.rm(link);
    expect(await delivery.verify()).toContain(link);

    const target = path.join(root, "chosen");
    await fs.mkdir(target);
    delivery.addUserText(`save it to ${target}`);
    expect(await delivery.selectDirectory(target, `save it to ${target}`)).toContain(target);
    await fs.writeFile(path.join(target, "canonical.md"), "report");
    await fs.symlink(path.join(target, "canonical.md"), path.join(target, "report.md"));
    expect(await delivery.verify()).toBeNull();
    await fs.rm(path.join(target, "report.md"));
    expect(await delivery.verify()).toContain(path.join(target, "report.md"));
  });

  it("rejects a declaration that reaches the output directory only through an outside link", async () => {
    await fs.writeFile(path.join(workspace, "report.md"), "report");
    const alias = path.join(root, "alias");
    await fs.symlink(workspace, alias);
    const metadata: Record<string, any> = {};
    expect(await new OutputDelivery(metadata, workspace).declare([path.join(alias, "report.md")])).toMatch(/only through another link/);
    expect(hasOutputObligations(metadata)).toBe(false);
  });

  it("records output_paths only after the tool call succeeded, keeping earlier ones", async () => {
    const metadata: Record<string, any> = {};
    const delivery = new OutputDelivery(metadata, workspace);
    await delivery.declare(["kept.md"]);
    await fs.writeFile(path.join(workspace, "blocker"), "a file, not a directory");
    const { result } = await run([
      call("write_file", { path: "blocker/failed.md", content: "x", output_paths: ["kept.md", "failed.md"] }),
      reply("Sorry, the file could not be written."),
      reply("Sorry, the file could not be written."),
      reply("Sorry, the file could not be written."),
    ], delivery);
    expect(metadata.outputDelivery.files).toEqual(["kept.md"]);
    expect(result.finalContent).toContain("kept.md");
    expect(result.finalContent).not.toContain("failed.md");
  });

  it("keeps a child's declaration of the same file when the parent's call fails", async () => {
    const parent = new OutputDelivery({}, workspace);
    const child = parent.forChild();
    let started!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class FailedWrite extends WriteFileTool {
      override async execute(): Promise<string> {
        started();
        await gate;
        return "Error: write rejected";
      }
    }
    const tools = new ToolRegistry();
    tools.register(new FailedWrite({ workspace, postWriteValidation: false }));
    const provider = new ScriptedProvider([]);
    const pending = new AgentRunner(provider).executeTools(new AgentRunSpec({ provider, tools, workspace, outputLocation: parent }), [
      new ToolCallRequest({ id: "failed-parent", name: "write_file", arguments: { path: "shared.md", content: "x", output_paths: ["shared.md"] } }),
    ]);
    await ready;
    expect(await child.declare(["shared.md"])).toBeNull();
    release();
    expect((await pending)[0].event.status).toBe("error");
    expect(await child.verify()).toContain("shared.md");
    expect(await parent.verify()).toContain("shared.md");
  });

  it("keeps output_paths when the tool succeeded but a later progress notification failed", async () => {
    const delivery = new OutputDelivery({}, workspace);
    const progressCallback = withProgressCapabilities(async (_text: string, options: any = {}) => {
      if (options.fileEditEvents?.some((event: any) => event.phase === "end")) throw new Error("notification failed");
    }, { fileEditEvents: true });
    const provider = new ScriptedProvider([
      call("write_file", { path: "report.md", content: "report", output_paths: ["report.md", "summary.csv"] }),
      reply("Both files are ready."),
      reply("Both files are ready."),
      reply("Both files are ready."),
    ]);
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      provider, tools: registry(), workspace, outputLocation: delivery, progressCallback, maxIterations: 5,
      messages: [{ role: "user", content: "make report and summary" }],
    }));
    expect(result.stopReason).toBe("toolError");
    expect(result.finalContent).toContain("summary.csv");
  });

  it("checks delivery before ending the stream when no retry is left", async () => {
    const delivery = new OutputDelivery({}, workspace);
    await delivery.declare(["missing.md"]);
    const order: string[] = [];
    const verify = delivery.verify.bind(delivery);
    delivery.verify = async () => { order.push("verify"); return verify(); };
    class TrackingHook extends AgentHook {
      override wantsStreaming() { return true; }
      override async onStreamEnd(_ctx: AgentHookContext, options: { resuming?: boolean } = {}) {
        if (!options.resuming) order.push("end");
      }
    }
    const provider = new ScriptedProvider([reply("All files delivered.")]);
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      provider, tools: registry(), workspace, outputLocation: delivery, hook: new TrackingHook(), maxIterations: 1,
      messages: [{ role: "user", content: "make missing.md" }],
    }));
    expect(result.stopReason).toBe("toolError");
    expect(order.indexOf("verify")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("verify")).toBeLessThan(order.indexOf("end"));
  });

  it("checks delivery before ending the stream when beforeFinalize rejects the last reply", async () => {
    const delivery = new OutputDelivery({}, workspace);
    await delivery.declare(["missing.md"]);
    const order: string[] = [];
    const verify = delivery.verify.bind(delivery);
    delivery.verify = async () => { order.push("verify"); return verify(); };
    class RejectingHook extends AgentHook {
      override wantsStreaming() { return true; }
      override async beforeFinalize() { return [{ role: "user" as const, content: "Create missing.md first." }]; }
      override async onStreamEnd(_ctx: AgentHookContext, options: { resuming?: boolean } = {}) {
        if (!options.resuming) order.push("end");
      }
    }
    const provider = new ScriptedProvider([reply("All files delivered.")]);
    const result = await new AgentRunner(provider).run(new AgentRunSpec({
      provider, tools: registry(), workspace, outputLocation: delivery, hook: new RejectingHook(), maxIterations: 1,
      messages: [{ role: "user", content: "make missing.md" }],
    }));
    expect(result.stopReason).toBe("toolError");
    expect(result.finalContent).toContain("missing.md");
    expect(order.indexOf("verify")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("verify")).toBeLessThan(order.indexOf("end"));
  });

  it("keeps the list and its directory for a later turn that runs in another workspace", async () => {
    const metadata: Record<string, any> = {};
    await new OutputDelivery(metadata, workspace).declare(["report.pdf"]);
    const otherWorkspace = path.join(root, "global");
    await fs.mkdir(otherWorkspace);
    const later = new OutputDelivery(metadata, otherWorkspace);
    expect(later.directory).toBe(workspace);
    expect(await later.verify()).toContain(path.join(workspace, "report.pdf"));
    await fs.writeFile(path.join(workspace, "report.pdf"), "pdf");
    expect(await later.verify()).toBeNull();
  });

  it("changes directory only from the user's own words and retargets declared files", async () => {
    const metadata: Record<string, any> = {};
    const target = path.join(root, "delivery");
    const delivery = new OutputDelivery(metadata, workspace, `请保存到 ${target}`);
    await delivery.declare(["report.pdf"]);
    await fs.writeFile(path.join(workspace, "report.pdf"), "old location");

    expect(await delivery.selectDirectory(target, "remembered from an older task")).toMatch(/^Error/);
    expect(await delivery.selectDirectory(path.join(root, "elsewhere"), `请保存到 ${target}`)).toMatch(/^Error/);
    expect(await delivery.forChild().selectDirectory(target, `请保存到 ${target}`)).toMatch(/^Error/);
    expect(await delivery.selectDirectory(target, `保存到 ${target}`)).toContain(target);

    // The old copy no longer counts, and late declarations against the old directory are refused.
    expect(await delivery.verify()).toContain(path.join(target, "report.pdf"));
    expect(await delivery.declare([path.join(workspace, "late.pdf")])).toMatch(/outside the output directory/);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "report.pdf"), "new location");
    expect(await delivery.verify()).toBeNull();

    delivery.complete();
    expect(hasOutputObligations(metadata)).toBe(false);
    expect(metadata.outputDelivery).toEqual({ directory: target, chosen: true });
  });

  it("lets a child check only its own files while the parent checks everything", async () => {
    const metadata: Record<string, any> = {};
    const parent = new OutputDelivery(metadata, workspace);
    const child = parent.forChild();
    await parent.declare(["parent.pdf"]);
    await child.declare(["child.xlsx"]);
    await fs.writeFile(path.join(workspace, "child.xlsx"), "xlsx");
    expect(await child.verify()).toBeNull();
    child.complete();
    expect(metadata.outputDelivery.files).toEqual(["parent.pdf", "child.xlsx"]);
    expect(await parent.verify()).toContain("parent.pdf");
  });

  it("does not confirm delivery while a tracked producer is still running", async () => {
    const delivery = new OutputDelivery({}, workspace);
    let running = true;
    delivery.track(() => running);
    expect(await delivery.verify()).toContain("后台命令或子任务");
    running = false;
    expect(await delivery.verify()).toBeNull();
  });

  it("clearing for cancel keeps only a user-chosen directory", () => {
    const metadata: Record<string, any> = { outputDelivery: { directory: workspace, files: ["a.pdf"] } };
    clearOutputDelivery(metadata);
    expect(metadata.outputDelivery).toBeUndefined();
  });
});

describe("runner delivery check", () => {
  it("feeds a missing file back to the model, then confirms once every declared file exists", async () => {
    const metadata: Record<string, any> = {};
    const { result, provider } = await run([
      call("write_file", { path: "a.md", content: "A", output_paths: ["a.md", "b.md"] }),
      reply("Done: a.md and b.md"),
      call("apply_patch", { input: "*** Begin Patch\n*** Add File: b.md\n+B\n*** End Patch", output_paths: ["b.md"] }),
      reply("Now both files are ready."),
    ], new OutputDelivery(metadata, workspace));

    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("Now both files are ready.");
    expect(hasOutputObligations(metadata)).toBe(false);
    // Tools never see output_paths; the model sees the parameter and the output instruction.
    expect(await fs.readFile(path.join(workspace, "b.md"), "utf8")).toBe("B\n");
    const writeFile = provider.requests[0].tools.find((tool: any) => tool.function.name === "write_file");
    expect(writeFile.function.parameters.properties.output_paths).toBeTruthy();
    expect(provider.requests[0].messages[0].content).toContain("Output directory for final files");
    // Feedback goes in as a user message, never a mid-conversation system message.
    const retry = provider.requests[2].messages;
    expect(retry.filter((message: any) => message.role === "system")).toHaveLength(1);
    expect(retry.at(-1)).toMatchObject({ role: "user" });
    expect(retry.at(-1).content).toContain(path.join(workspace, "b.md"));
    expect(retry.some((message: any) => OUTPUT_FEEDBACK_KEY in message)).toBe(false);
    expect(result.messages.filter((message: any) => message[OUTPUT_FEEDBACK_KEY])).toHaveLength(2);
  });

  it("reports an honest failure and keeps the list when the file never appears", async () => {
    const metadata: Record<string, any> = {};
    const { result } = await run([
      call("write_file", { path: "a.md", content: "A", output_paths: ["a.md", "b.xlsx"] }),
      reply("All done."),
      reply("All done."),
      reply("All done."),
    ], new OutputDelivery(metadata, workspace));

    expect(result.stopReason).toBe("toolError");
    expect(result.finalContent).toContain(DELIVERY_NOT_CONFIRMED);
    expect(result.finalContent).toContain("b.xlsx");
    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: result.finalContent });
    expect(metadata.outputDelivery.files).toEqual(["a.md", "b.xlsx"]);
  });

  it("rejects a declaration outside the output directory before the tool runs", async () => {
    const outside = path.join(root, "outside.md");
    const { result } = await run([
      call("write_file", { path: outside, content: "X", output_paths: [outside] }),
      reply("Could not write there."),
    ], new OutputDelivery({}, workspace));
    expect(result.toolEvents[0].status).toBe("error");
    await expect(fs.stat(outside)).rejects.toThrow();
  });

  it("waits for a background exec that declared outputs", async () => {
    const metadata: Record<string, any> = {};
    const { result } = await run([
      call("exec", { command: "sleep 30; echo late > report.md", yield_time_ms: 0, output_paths: ["report.md"] }),
      reply("Report is done."),
      reply("Report is done."),
      reply("Report is done."),
    ], new OutputDelivery(metadata, workspace));
    expect(result.finalContent).toContain("后台命令或子任务");
    expect(metadata.outputDelivery.producers).toHaveLength(1);
  });

  it("leaves ordinary turns without declarations untouched", async () => {
    const metadata: Record<string, any> = {};
    const { result } = await run([reply("Hello")], new OutputDelivery(metadata, workspace));
    expect(result.finalContent).toBe("Hello");
    expect(result.stopReason).toBe("completed");
    expect(metadata.outputDelivery).toBeUndefined();
  });
});

describe("AgentLoop parent and subagent delivery", () => {
  async function runParentChild({ attachments, childWaitMs }: { attachments: boolean; childWaitMs: number }) {
    const task = path.join(root, "task");
    await fs.mkdir(task);
    const parentFile = path.join(task, "parent.txt");
    const childFile = path.join(task, "child.txt");
    const key = "websocket:delivery";
    let parentCalls = 0;
    class Provider extends LLMProvider {
      getDefaultModel() { return "test-model"; }
      async chat(args: any) { return this.chatWithRetry(args); }
      async chatWithRetry(args: any) {
        const isParent = args.tools?.some((tool: any) => tool.function?.name === "spawn");
        if (!isParent) {
          const wrote = args.messages.some((message: any) => message.role === "tool");
          return wrote ? reply(`child done ${childFile}`)
            : call("write_file", { path: childFile, content: "CHILD", output_paths: [childFile] });
        }
        parentCalls += 1;
        if (parentCalls === 1) {
          return new LLMResponse({ content: null, finishReason: "tool_calls", toolCalls: [
            new ToolCallRequest({ id: `p-${sequence++}`, name: "write_file", arguments: { path: parentFile, content: "PARENT", output_paths: [parentFile] } }),
            new ToolCallRequest({ id: `p-${sequence++}`, name: "spawn", arguments: { label: "child", task: "write child.txt" } }),
          ] });
        }
        if (attachments && parentCalls === 2) return call("message", { content: "attachments", media: [parentFile, childFile] });
        return reply(`FINAL ${parentFile} ${childFile}`);
      }
    }
    const bus = new MessageBus();
    const outbound: OutboundMessage[] = [];
    const publish = bus.publishOutbound.bind(bus);
    bus.publishOutbound = async (message: OutboundMessage) => { outbound.push(message); return publish(message); };
    const agent = new AgentLoop({
      bus, provider: new Provider(), workspace, model: "test-model", maxIterations: 8,
      sessionDir: path.join(root, "sessions"),
      config: new Config({ fileMemory: { enabled: false }, memmyMemory: { enabled: false }, sessionDag: { enabled: false }, contextCompaction: { summaryMode: "text" } }),
    });
    agent.subagentPendingWaitMs = childWaitMs;
    const session = agent.sessions.getOrCreate(key);
    Object.assign(session.metadata, { webui: true, webuiProjectId: null, webuiWorkspaceCwd: task });
    agent.sessions.save(session);
    const running = agent.run();
    await bus.publishInbound(new InboundMessage({
      channel: "websocket", senderId: "user", chatId: "delivery", content: "父任务写 parent.txt，子任务写 child.txt，交付二者。",
      sessionKeyOverride: key, metadata: { webui: true, wantsStream: false },
    }));
    const deadline = Date.now() + 15_000;
    let quietSince = 0;
    while (Date.now() < deadline) {
      const idle = agent.activeTasks.size === 0 && agent.subagents.getRunningCountBySession(key) === 0 && parentCalls >= 2;
      if (!idle) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince > 300) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    agent.stop();
    await running;
    await agent.closeRuntimeTools();
    const finals = outbound.filter((message) => !message.metadata?.agentProgress && !message.metadata?.streamDelta && message.content)
      .map((message) => message.content);
    return { finals, metadata: agent.sessions.getOrCreate(key).metadata, parentFile, childFile };
  }

  it("delivers attachments from a task workspace without losing the list (child result in the turn)", async () => {
    const { finals, metadata, childFile } = await runParentChild({ attachments: true, childWaitMs: 10_000 });
    expect(await fs.readFile(childFile, "utf8")).toBe("CHILD");
    expect(finals.some((content) => content.includes(DELIVERY_NOT_CONFIRMED) || content.includes("不可用"))).toBe(false);
    expect(hasOutputObligations(metadata)).toBe(false);
  });

  it("confirms delivery on the later subagent-result turn instead of reporting a lost list", async () => {
    const { finals, metadata, parentFile, childFile } = await runParentChild({ attachments: false, childWaitMs: 1 });
    expect(finals.some((content) => content.includes("不可用"))).toBe(false);
    expect(finals.at(-1)).toBe(`FINAL ${parentFile} ${childFile}`);
    expect(hasOutputObligations(metadata)).toBe(false);
  });
});

describe("review regressions", () => {
  const config = () => new Config({ fileMemory: { enabled: false }, memmyMemory: { enabled: false }, sessionDag: { enabled: false }, contextCompaction: { summaryMode: "text" } });
  const sessionStore = (sessions: SessionManager, key: string) => ({
    metadata: () => sessions.getOrCreate(key).metadata,
    save: () => sessions.save(sessions.getOrCreate(key)),
  });

  it("keeps a subagent declaration made after the session was reloaded", async () => {
    const sessions = new SessionManager(path.join(root, "sessions"));
    const key = "cli:reload";
    const parent = new OutputDelivery(sessionStore(sessions, key), workspace);
    const child = parent.forChild();
    parent.track(() => false);
    sessions.invalidate(key);
    await child.declare(["missing-child.md"]);
    sessions.invalidate(key);
    expect(await new OutputDelivery(sessions.getOrCreate(key).metadata, workspace).verify()).toContain("missing-child.md");
  });

  it("keeps declarations after a Goal mutation replaces session metadata", async () => {
    const sessions = new SessionManager(path.join(root, "sessions"));
    const key = "cli:goal";
    const session = sessions.getOrCreate(key);
    const delivery = new OutputDelivery(sessionStore(sessions, key), workspace);
    const before = session.metadata;
    await new GoalRuntime({ sessions, bus: new MessageBus() }).create({ sessionKey: key, objective: "report", route: { channel: "cli", chatId: "goal" }, turnId: "t" });
    expect(session.metadata).not.toBe(before);
    await delivery.declare(["missing.md"]);
    expect(await new OutputDelivery(session.metadata, workspace).verify()).toContain("missing.md");
  });

  it("does not let a CLI parent confirm a file a late subagent declared but never wrote", async () => {
    const key = "cli:late-child";
    const missing = path.join(workspace, "missing-child.md");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let childCalls = 0;
    let parentCalls = 0;
    class Provider extends LLMProvider {
      getDefaultModel() { return "test-model"; }
      async chat(args: any) { return this.chatWithRetry(args); }
      async chatWithRetry(args: any) {
        if (!args.tools?.some((tool: any) => tool.function?.name === "spawn")) {
          childCalls += 1;
          if (childCalls === 1) { await gate; return call("exec", { command: "true", output_paths: [missing] }); }
          return reply("child finished");
        }
        parentCalls += 1;
        return parentCalls === 1 ? call("spawn", { label: "child", task: "write missing-child.md" }) : reply(`Delivered ${missing}`);
      }
    }
    const bus = new MessageBus();
    const finals: string[] = [];
    const publish = bus.publishOutbound.bind(bus);
    bus.publishOutbound = async (message: OutboundMessage) => {
      if (message.content && !message.metadata?.agentProgress && !message.metadata?.streamDelta) finals.push(message.content);
      return publish(message);
    };
    const agent = new AgentLoop({ bus, provider: new Provider(), workspace, model: "test-model", maxIterations: 6, sessionDir: path.join(root, "sessions"), config: config() });
    agent.subagentPendingWaitMs = 1;
    const running = agent.run();
    try {
      await bus.publishInbound(new InboundMessage({ channel: "cli", senderId: "user", chatId: "late-child", content: "let a child write missing-child.md", sessionKeyOverride: key }));
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !(parentCalls >= 2 && agent.activeTasks.size === 0)) await new Promise((resolve) => setTimeout(resolve, 10));
      release();
      let idleSince = 0;
      while (Date.now() < deadline) {
        const idle = agent.activeTasks.size === 0 && agent.subagents.getRunningCountBySession(key) === 0 && childCalls >= 2;
        if (!idle) idleSince = 0;
        else if (!idleSince) idleSince = Date.now();
        else if (Date.now() - idleSince > 300) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(finals.some((content) => content.startsWith("Delivered"))).toBe(false);
      expect(finals.at(-1)).toContain(DELIVERY_NOT_CONFIRMED);
      expect(finals.at(-1)).toContain("missing-child.md");
      expect(hasOutputObligations(agent.sessions.getOrCreate(key).metadata)).toBe(true);
    } finally {
      release();
      agent.stop();
      await running;
      await agent.closeRuntimeTools();
    }
  }, 15_000);

  it("does not send a message while a declared file is missing", async () => {
    const sent: any[] = [];
    const tools = registry();
    tools.register(new MessageTool({ workspace, defaultChannel: "websocket", defaultChatId: "review", sendCallback: (message) => { sent.push(message); } }));
    const provider = new ScriptedProvider([
      call("write_file", { path: "report.md", content: "report", output_paths: ["report.md", "summary.csv"] }),
      call("message", { content: "Both files are ready.", media: [path.join(workspace, "report.md")] }),
      call("write_file", { path: "summary.csv", content: "a,b", output_paths: ["summary.csv"] }),
      call("message", { content: "Both files are ready.", media: [path.join(workspace, "report.md"), path.join(workspace, "summary.csv")] }),
      reply("Sent."),
    ]);
    const result = await new AgentRunner(provider).run(new AgentRunSpec({ provider, tools, workspace, outputLocation: new OutputDelivery({}, workspace),
      maxIterations: 8, messages: [{ role: "user", content: "deliver report.md and summary.csv" }] }));
    expect(result.toolEvents[1]).toMatchObject({ name: "message", status: "error" });
    expect(sent).toHaveLength(1);
    expect(sent[0].media).toHaveLength(2);
    expect(result.stopReason).toBe("completed");
  });

  it("ends an idle failed task on /stop, and /new also resets the chosen directory", async () => {
    const agent = new AgentLoop({ bus: new MessageBus(), provider: new ScriptedProvider([]), workspace, model: "test-model", sessionDir: path.join(root, "sessions"), config: config() });
    try {
      const stopKey = "cli:stop";
      const stopSession = agent.sessions.getOrCreate(stopKey);
      await new OutputDelivery(stopSession.metadata, workspace).declare(["missing.md"]);
      const stopMessage = () => new InboundMessage({ channel: "cli", senderId: "user", chatId: "stop", content: "/stop" });
      const stopped = await cmdStop({ msg: stopMessage(), key: stopKey, loop: agent } as any);
      expect(stopped.content).toBe("Ended the unfinished file delivery.");
      expect(hasOutputObligations(agent.sessions.getOrCreate(stopKey).metadata)).toBe(false);
      expect((await cmdStop({ msg: stopMessage(), key: stopKey, loop: agent } as any)).content).toBe("No active task to stop.");

      const newKey = "cli:new";
      const target = path.join(root, "chosen");
      const session = agent.sessions.getOrCreate(newKey);
      const delivery = new OutputDelivery(session.metadata, workspace, `save to ${target}`);
      await delivery.selectDirectory(target, `save to ${target}`);
      await delivery.declare([path.join(target, "missing.md")]);
      await cmdNew({ msg: new InboundMessage({ channel: "cli", senderId: "user", chatId: "new", content: "/new" }), key: newKey, session, loop: agent } as any);
      expect(agent.sessions.getOrCreate(newKey).metadata.outputDelivery).toBeUndefined();
    } finally {
      await agent.closeRuntimeTools();
    }
  });
});
