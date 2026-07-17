import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../../src/config/schema.js";
import { HeartbeatService } from "../../../src/heartbeat/service.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import { LLMRuntime } from "../../../src/utils/llm-runtime.js";

const roots: string[] = [];

class DummyProvider {
  responses: LLMResponse[];
  calls = 0;
  models: Array<string | null> = [];

  constructor(responses: LLMResponse[]) {
    this.responses = [...responses];
  }

  async chat(args: any = {}): Promise<LLMResponse> {
    this.calls += 1;
    this.models.push(args.model ?? null);
    return this.responses.shift() ?? new LLMResponse({ content: "", toolCalls: [] });
  }

  getDefaultModel(): string {
    return "test-model";
  }
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-heartbeat-"));
  roots.push(root);
  return root;
}

function writeHeartbeat(root: string, content = "- [ ] do thing"): void {
  fs.writeFileSync(path.join(root, "HEARTBEAT.md"), content, "utf8");
}

function decision(action: "skip" | "run", tasks?: string): LLMResponse {
  return new LLMResponse({
    content: "",
    toolCalls: [
      new ToolCallRequest({
        id: "hb_1",
        name: "heartbeat",
        arguments: tasks == null ? { action } : { action, tasks },
      }),
    ],
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("heartbeat service config", () => {
  it("keeps heartbeat defaults available to the agent config", () => {
    const config = new Config({ gateway: { heartbeat: { enabled: true, intervalS: 900, keepRecentMessages: 4 } } });

    expect(config.heartbeat.enabled).toBe(true);
    expect(config.heartbeat.intervalS).toBe(900);
    expect(config.heartbeat.keepRecentMessages).toBe(4);
    expect(config.heartbeat).toBe(config.gateway.heartbeat);
  });
});

describe("HeartbeatService", () => {
  it("starts idempotently", async () => {
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: new DummyProvider([]) as any,
      model: "openai/gpt-4o-mini",
      intervalS: 9999,
      enabled: true,
    });

    await service.start();
    const firstTask = service.runningTask;
    await service.start();

    expect(service.runningTask).toBe(firstTask);
    service.stop();
  });

  it("cancels the previous loop when stopped before restart", async () => {
    vi.useFakeTimers();
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: new DummyProvider([]) as any,
      model: "openai/gpt-4o-mini",
      intervalS: 1,
      enabled: true,
    });
    const tick = vi.spyOn(service, "tick").mockResolvedValue(undefined);

    await service.start();
    service.stop();
    await service.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(tick).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("decides skip when the model returns no heartbeat tool call", async () => {
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: new DummyProvider([new LLMResponse({ content: "no tool call", toolCalls: [] })]) as any,
      model: "openai/gpt-4o-mini",
    });

    await expect(service.decide("heartbeat content")).resolves.toEqual(["skip", ""]);
  });

  it("triggerNow executes when the decision is run", async () => {
    const root = workspace();
    writeHeartbeat(root);
    const calledWith: string[] = [];
    const service = new HeartbeatService({
      workspace: root,
      provider: new DummyProvider([decision("run", "check open tasks")]) as any,
      model: "openai/gpt-4o-mini",
      onExecute: async (tasks) => {
        calledWith.push(tasks);
        return "done";
      },
    });

    await expect(service.triggerNow()).resolves.toBe("done");
    expect(calledWith).toEqual(["check open tasks"]);
  });

  it("triggerNow returns null when the decision is skip", async () => {
    const root = workspace();
    writeHeartbeat(root);
    const service = new HeartbeatService({
      workspace: root,
      provider: new DummyProvider([decision("skip")]) as any,
      model: "openai/gpt-4o-mini",
      onExecute: async (tasks) => tasks,
    });

    await expect(service.triggerNow()).resolves.toBeNull();
  });

  it("notifies when the evaluator says yes", async () => {
    const root = workspace();
    writeHeartbeat(root, "- [ ] check deployments");
    const executed: string[] = [];
    const notified: string[] = [];
    const service = new HeartbeatService({
      workspace: root,
      provider: new DummyProvider([decision("run", "check deployments")]) as any,
      model: "openai/gpt-4o-mini",
      onExecute: async (tasks) => {
        executed.push(tasks);
        return "deployment failed on staging";
      },
      onNotify: async (response) => {
        notified.push(response);
      },
      evaluateResponse: async () => true,
    });

    await service.tick();

    expect(executed).toEqual(["check deployments"]);
    expect(notified).toEqual(["deployment failed on staging"]);
  });

  it("suppresses notification when the evaluator says no", async () => {
    const root = workspace();
    writeHeartbeat(root, "- [ ] check status");
    const executed: string[] = [];
    const notified: string[] = [];
    const service = new HeartbeatService({
      workspace: root,
      provider: new DummyProvider([decision("run", "check status")]) as any,
      model: "openai/gpt-4o-mini",
      onExecute: async (tasks) => {
        executed.push(tasks);
        return "everything is fine, no issues";
      },
      onNotify: async (response) => {
        notified.push(response);
      },
      evaluateResponse: async () => false,
    });

    await service.tick();

    expect(executed).toEqual(["check status"]);
    expect(notified).toEqual([]);
  });

  it("uses the runtime provider and model for decision and evaluation", async () => {
    const root = workspace();
    writeHeartbeat(root, "- [ ] check runtime model");
    const runtimeProvider = new DummyProvider([decision("run", "check runtime model")]);
    const runtimeModel = "openai/gpt-4.1";
    const executed: string[] = [];
    const evaluated: any[] = [];
    const service = new HeartbeatService({
      workspace: root,
      llmRuntime: () => new LLMRuntime(runtimeProvider as any, runtimeModel),
      onExecute: async (tasks) => {
        executed.push(tasks);
        return "runtime model produced a user-facing update";
      },
      evaluateResponse: async (response, tasks, provider, model) => {
        evaluated.push([provider, model]);
        return false;
      },
    });

    await service.tick();

    expect(runtimeProvider.calls).toBe(1);
    expect(runtimeProvider.models).toEqual([runtimeModel]);
    expect(executed).toEqual(["check runtime model"]);
    expect(evaluated).toEqual([[runtimeProvider, runtimeModel]]);
  });

  it("does not add a heartbeat retry after provider retry returns an error", async () => {
    const provider = {
      chatWithRetry: vi.fn(async () => new LLMResponse({ content: "429 rate limit", finishReason: "error" })),
      chat: vi.fn(async () => decision("run", "check open tasks")),
      getDefaultModel: () => "test-model",
    };
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: provider as any,
      model: "openai/gpt-4o-mini",
    });

    await expect(service.decide("heartbeat content")).resolves.toEqual(["skip", ""]);
    expect(provider.chatWithRetry).toHaveBeenCalledTimes(1);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("includes current time in the decision prompt", async () => {
    const capturedMessages: any[] = [];
    const provider = {
      async chat(args: any): Promise<LLMResponse> {
        capturedMessages.push(...args.messages);
        return decision("skip");
      },
      getDefaultModel: () => "test-model",
    };
    const service = new HeartbeatService({
      workspace: workspace(),
      provider: provider as any,
      model: "test-model",
      timezone: "Asia/Shanghai",
    });

    await service.decide("- [ ] check servers at 10:00 UTC");

    expect(capturedMessages[1]).toMatchObject({ role: "user" });
    expect(capturedMessages[1].content).toContain("Current Time:");
    expect(capturedMessages[1].content).toMatch(
      /Current Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \([^)]+\) \(Asia\/Shanghai, UTC[+-]\d{2}:\d{2}\)/,
    );
  });
});
