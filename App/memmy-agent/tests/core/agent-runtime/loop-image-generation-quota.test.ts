import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setConfigPath } from "../../../src/config/loader.js";
import { Config } from "../../../src/config/schema.js";
import { AgentLoop } from "../../../src/core/agent-runtime/loop.js";
import { InboundMessage } from "../../../src/core/runtime-messages/index.js";
import { LLMProvider, LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";
import {
  GeneratedImageResponse,
  ImageGenerationProvider,
  OpenAIImageGenerationClient,
  registerImageGenProvider,
} from "../../../src/providers/image-generation.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const roots: string[] = [];
const originalConfig = process.env.MEMMY_CONFIG;
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;

class ScriptedLlmProvider extends LLMProvider {
  requests: any[] = [];

  constructor(private readonly responses: LLMResponse[]) {
    super();
  }

  getDefaultModel(): string {
    return "test-model";
  }

  async chat(args: any): Promise<LLMResponse> {
    this.requests.push(args);
    const response = this.responses.shift();
    if (!response) throw new Error("scripted LLM response exhausted");
    return response;
  }
}

class LoopFakeImageClient extends ImageGenerationProvider {
  static override providerName = "openai";
  override providerName = "openai";
  static calls: any[] = [];

  async generate(args: any): Promise<GeneratedImageResponse> {
    LoopFakeImageClient.calls.push(args);
    return new GeneratedImageResponse({ images: [PNG_DATA_URL], content: "", raw: {} });
  }
}

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-loop-image-quota-"));
  roots.push(root);
  return root;
}

function imageCall(id: string, count: number): LLMResponse {
  return new LLMResponse({
    content: null,
    toolCalls: [
      new ToolCallRequest({
        id,
        name: "generate_image",
        arguments: { prompt: `image request ${id}`, count },
      }),
    ],
  });
}

afterEach(() => {
  setConfigPath(null);
  if (originalConfig === undefined) delete process.env.MEMMY_CONFIG;
  else process.env.MEMMY_CONFIG = originalConfig;
  if (originalDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  LoopFakeImageClient.calls = [];
  registerImageGenProvider(OpenAIImageGenerationClient);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("AgentLoop image generation turn quota", () => {
  it("shares the quota within one turn and resets it for the next turn", async () => {
    registerImageGenProvider(LoopFakeImageClient);
    const root = tmpRoot();
    const configPath = path.join(root, "config.yaml");
    setConfigPath(configPath);
    process.env.MEMMY_CONFIG = configPath;
    process.env.MEMMY_AGENT_DATA_DIR = root;
    const provider = new ScriptedLlmProvider([
      imageCall("turn-1-first", 3),
      imageCall("turn-1-too-many", 2),
      imageCall("turn-1-last", 1),
      new LLMResponse({ content: "turn one complete" }),
      imageCall("turn-2-full", 4),
      new LLMResponse({ content: "turn two complete" }),
    ]);
    const loop = new AgentLoop({
      config: new Config({
        memmyMemory: { enabled: false },
        tools: {
          imageGeneration: {
            enabled: true,
            provider: "openai",
            model: "gpt-image-2",
            apiKey: "sk-image-test",
            maxImagesPerTurn: 4,
          },
        },
      }),
      provider,
      workspace: root,
      model: "test-model",
    });
    (loop.consolidator as any).maybeConsolidateByTokens = async () => false;

    const first = await loop.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "quota-chat",
      senderId: "user",
      content: "first turn",
    }));
    const second = await loop.processMessage(new InboundMessage({
      channel: "websocket",
      chatId: "quota-chat",
      senderId: "user",
      content: "second turn",
    }));

    expect(first).toMatchObject({ channel: "websocket", chatId: "quota-chat", content: "turn one complete" });
    expect(second).toMatchObject({ channel: "websocket", chatId: "quota-chat", content: "turn two complete" });
    expect(LoopFakeImageClient.calls).toHaveLength(8);

    const toolResults = provider.requests.flatMap((request) =>
      request.messages.filter((message: any) => message.role === "tool" && message.name === "generate_image"),
    );
    expect(toolResults.some((message: any) => String(message.content).includes(
      "Error: count 2 exceeds the remaining image quota for this turn (1 remaining of 4).",
    ))).toBe(true);

    const successPayload = toolResults
      .map((message: any) => {
        try {
          return JSON.parse(String(message.content));
        } catch {
          return null;
        }
      })
      .find((payload: any) => Array.isArray(payload?.artifacts));
    expect(Object.keys(successPayload).sort()).toEqual(["artifacts", "next_step"]);
  });
});
