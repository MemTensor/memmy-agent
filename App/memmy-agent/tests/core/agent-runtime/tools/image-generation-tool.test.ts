import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Config, ImageGenerationToolConfig } from "../../../../src/config/schema.js";
import { AgentLoop } from "../../../../src/core/agent-runtime/loop.js";
import { ImageGenerationTool } from "../../../../src/core/agent-runtime/tools/image-generation.js";
import {
  AIHubMixImageGenerationClient,
  GeneratedImageResponse,
  ImageGenerationProvider,
  MemmyAccountImageGenerationClient,
  OllamaImageGenerationClient,
  OpenAIImageGenerationClient,
  OpenRouterImageGenerationClient,
  ZhipuImageGenerationClient,
  registerImageGenProvider,
} from "../../../../src/providers/image-generation.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const roots: string[] = [];
const oldConfig = process.env.MEMMY_CONFIG;

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-image-tool-"));
  roots.push(root);
  return root;
}

class FakeImageClient extends ImageGenerationProvider {
  static override providerName = "openai";
  override providerName = "openai";
  static instances: FakeImageClient[] = [];
  static results: Array<GeneratedImageResponse | Error> = [];
  calls: any[] = [];

  constructor(init: any = {}) {
    super(init);
    FakeImageClient.instances.push(this);
  }

  async generate(args: any): Promise<GeneratedImageResponse> {
    this.calls.push(args);
    const scripted = FakeImageClient.results.shift();
    if (scripted instanceof Error) throw scripted;
    if (scripted) return scripted;
    return new GeneratedImageResponse({ images: [PNG_DATA_URL], content: "", raw: {} });
  }
}

class FakeAIHubMixClient extends FakeImageClient {
  static override providerName = "aihubmix";
  override providerName = "aihubmix";
}

class FakeOllamaClient extends FakeImageClient {
  static override providerName = "ollama";
  override providerName = "ollama";
}

function totalFakeGenerateCalls(): number {
  return FakeImageClient.instances.reduce((total, instance) => total + instance.calls.length, 0);
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(root, entry.name);
    return entry.isDirectory() ? listFiles(target) : [target];
  }).sort();
}

afterEach(() => {
  process.env.MEMMY_CONFIG = oldConfig;
  FakeImageClient.instances = [];
  FakeImageClient.results = [];
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  registerImageGenProvider(OpenRouterImageGenerationClient);
  registerImageGenProvider(OpenAIImageGenerationClient);
  registerImageGenProvider(MemmyAccountImageGenerationClient);
  registerImageGenProvider(AIHubMixImageGenerationClient);
  registerImageGenProvider(OllamaImageGenerationClient);
  registerImageGenProvider(ZhipuImageGenerationClient);
});

describe("ImageGenerationTool", () => {
  it("keeps the existing tool description and parameter schema", () => {
    const tool = new ImageGenerationTool();

    expect(tool.description).toBe(
      "Generate or edit images and store them as persistent artifacts. Returns artifact ids and local paths.",
    );
    expect(tool.parameters.properties.prompt).toEqual({ type: "string", minLength: 1 });
    expect(tool.parameters.properties.count).toEqual({ type: "integer", minimum: 1, maximum: 8 });
  });

  it("enables only complete effective profile config", () => {
    const accountConfig = new ImageGenerationToolConfig({
      enabled: true,
      activeProfile: "account",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
          apiKey: "cloud-login-uuid",
          apiBase: "https://cloud.example.com/api/agentExternal/v1",
        },
        byok: {
          provider: "openai",
          model: "gpt-image-1",
          apiKey: "sk-byok",
          apiBase: "https://api.openai.com/v1",
        },
      },
    });
    expect(ImageGenerationTool.enabled({ config: { imageGeneration: accountConfig } })).toBe(true);
    const tool = ImageGenerationTool.create({ workspace: tmpRoot(), config: { imageGeneration: accountConfig } }) as ImageGenerationTool;
    expect(tool.config.provider).toBe("memmy_account");
    expect(tool.config.model).toBe("image_gen");
    expect(tool.config.apiKey).toBe("cloud-login-uuid");

    const missingByok = new ImageGenerationToolConfig({
      enabled: true,
      activeProfile: "byok",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
          apiKey: "cloud-login-uuid",
          apiBase: "https://cloud.example.com/api/agentExternal/v1",
        },
      },
    });
    expect(ImageGenerationTool.enabled({ config: { imageGeneration: missingByok } })).toBe(false);
  });

  it("refreshes runtime image generation config when tool registry is rebuilt", () => {
    let imageGeneration = new ImageGenerationToolConfig({
      enabled: true,
      activeProfile: "account",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
          apiKey: "cloud-login-uuid",
          apiBase: "https://cloud.example.com/api/agentExternal/v1",
        },
        byok: {
          provider: "openai",
          model: "gpt-image-1",
          apiKey: "sk-byok",
          apiBase: "https://api.openai.com/v1",
        },
      },
    });
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const loop = new AgentLoop({
      config: new Config({ tools: { imageGeneration: { enabled: false } } }),
      provider: { generation: {}, getDefaultModel: () => "model" },
      workspace: root,
      toolsSnapshotLoader: () => ({ imageGeneration }),
    });

    let tool = loop.tools.get("generate_image") as ImageGenerationTool;
    expect(tool.config.provider).toBe("memmy_account");
    expect(tool.config.model).toBe("image_gen");

    imageGeneration = new ImageGenerationToolConfig({
      enabled: true,
      activeProfile: "byok",
      profiles: {
        account: {
          provider: "memmy_account",
          model: "image_gen",
          apiKey: "cloud-login-uuid",
          apiBase: "https://cloud.example.com/api/agentExternal/v1",
        },
      },
    });
    loop.registerDefaultTools();
    expect(loop.tools.get("generate_image")).toBeUndefined();

    imageGeneration = new ImageGenerationToolConfig({
      enabled: true,
      activeProfile: "byok",
      profiles: {
        byok: {
          provider: "openai",
          model: "gpt-image-1",
          apiKey: "sk-byok",
          apiBase: "https://api.openai.com/v1",
        },
      },
    });
    loop.registerDefaultTools();
    tool = loop.tools.get("generate_image") as ImageGenerationTool;
    expect(tool.config.provider).toBe("openai");
    expect(tool.config.model).toBe("gpt-image-1");
  });

  it("stores artifacts and source image metadata", async () => {
    registerImageGenProvider(FakeImageClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const ref = path.join(root, "ref.png");
    fs.writeFileSync(ref, PNG_BYTES);
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        maxImagesPerTurn: 2,
        apiKey: "sk-image-test",
      }),
    });

    const result = await tool.execute({
      prompt: "make this blue",
      reference_images: ["ref.png"],
      aspect_ratio: "16:9",
      image_size: "2K",
      count: 2,
    });

    const payload = JSON.parse(result);
    expect(payload.artifacts).toHaveLength(2);
    expect(fs.existsSync(payload.artifacts[0].path)).toBe(true);
    expect(payload.artifacts[0].source_images).toEqual([fs.realpathSync(ref)]);
    expect(payload.artifacts[0].model).toBe("gpt-image-2");
    const fake = FakeImageClient.instances[0];
    expect(fake.apiKey).toBe("sk-image-test");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ aspectRatio: "16:9", imageSize: "2K" });
  });

  it("does not impose a turn quota when the limit is null", async () => {
    registerImageGenProvider(FakeImageClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({ enabled: true, apiKey: "sk-image-test" }),
    });

    const first = JSON.parse(await tool.execute({ prompt: "first", count: 2 }));
    const second = JSON.parse(await tool.execute({ prompt: "second", count: 2 }));

    expect(first.artifacts).toHaveLength(2);
    expect(second.artifacts).toHaveLength(2);
    expect(totalFakeGenerateCalls()).toBe(4);
  });

  it("enforces a cumulative finite turn quota before provider execution", async () => {
    registerImageGenProvider(FakeImageClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        maxImagesPerTurn: 4,
        apiKey: "sk-image-test",
      }),
    });

    const first = JSON.parse(await tool.execute({ prompt: "first", count: 3 }));
    expect(Object.keys(first).sort()).toEqual(["artifacts", "next_step"]);
    expect(first.artifacts).toHaveLength(3);
    const filesBeforeRejection = listFiles(path.join(root, "media"));

    await expect(tool.execute({ prompt: "too many", count: 2 })).resolves.toBe(
      "Error: count 2 exceeds the remaining image quota for this turn (1 remaining of 4).",
    );
    expect(totalFakeGenerateCalls()).toBe(3);
    expect(listFiles(path.join(root, "media"))).toEqual(filesBeforeRejection);

    expect(JSON.parse(await tool.execute({ prompt: "last", count: 1 })).artifacts).toHaveLength(1);
    await expect(tool.execute({ prompt: "exhausted" })).resolves.toBe(
      "Error: image generation quota is exhausted for this turn (4/4 images generated).",
    );
    expect(totalFakeGenerateCalls()).toBe(4);
  });

  it("counts stored artifacts after a partial provider failure", async () => {
    registerImageGenProvider(FakeImageClient);
    FakeImageClient.results = [
      new GeneratedImageResponse({ images: [PNG_DATA_URL], content: "", raw: {} }),
      new Error("scripted provider failure"),
    ];
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        maxImagesPerTurn: 2,
        apiKey: "sk-image-test",
      }),
    });

    await expect(tool.execute({ prompt: "partial", count: 2 })).resolves.toBe(
      "Error: scripted provider failure",
    );
    await expect(tool.execute({ prompt: "too many", count: 2 })).resolves.toBe(
      "Error: count 2 exceeds the remaining image quota for this turn (1 remaining of 2).",
    );
    expect(totalFakeGenerateCalls()).toBe(2);
    expect(JSON.parse(await tool.execute({ prompt: "remaining" })).artifacts).toHaveLength(1);
  });

  it("does not count provider failures that produce no artifacts", async () => {
    registerImageGenProvider(FakeImageClient);
    FakeImageClient.results = [new Error("first call failed")];
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        maxImagesPerTurn: 1,
        apiKey: "sk-image-test",
      }),
    });

    await expect(tool.execute({ prompt: "failure" })).resolves.toBe("Error: first call failed");
    expect(JSON.parse(await tool.execute({ prompt: "retry" })).artifacts).toHaveLength(1);
  });

  it("counts only requested artifacts when a provider returns multiple images", async () => {
    registerImageGenProvider(FakeImageClient);
    FakeImageClient.results = [
      new GeneratedImageResponse({
        images: [PNG_DATA_URL, PNG_DATA_URL, PNG_DATA_URL],
        content: "",
        raw: {},
      }),
    ];
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        maxImagesPerTurn: 2,
        apiKey: "sk-image-test",
      }),
    });

    expect(JSON.parse(await tool.execute({ prompt: "batch", count: 2 })).artifacts).toHaveLength(2);
    expect(totalFakeGenerateCalls()).toBe(1);
    await expect(tool.execute({ prompt: "exhausted" })).resolves.toContain("quota is exhausted");
  });

  it("resets the turn quota for a new tool instance", async () => {
    registerImageGenProvider(FakeImageClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const config = new ImageGenerationToolConfig({
      enabled: true,
      maxImagesPerTurn: 1,
      apiKey: "sk-image-test",
    });
    const first = new ImageGenerationTool({ workspace: root, config });
    const second = new ImageGenerationTool({ workspace: root, config });

    expect(JSON.parse(await first.execute({ prompt: "first" })).artifacts).toHaveLength(1);
    await expect(first.execute({ prompt: "blocked" })).resolves.toContain("quota is exhausted");
    expect(JSON.parse(await second.execute({ prompt: "new turn" })).artifacts).toHaveLength(1);
  });

  it("uses tool-level apiKey/apiBase", async () => {
    registerImageGenProvider(FakeImageClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        provider: "openai",
        apiKey: "sk-image-dedicated",
        apiBase: "https://image.example/v1",
      }),
    });

    await tool.execute({ prompt: "draw" });

    const fake = FakeImageClient.instances[0];
    expect(fake.apiKey).toBe("sk-image-dedicated");
    expect(fake.apiBase).toBe("https://image.example/v1");
  });

  it("reports a missing OpenAI key", async () => {
    const result = await new ImageGenerationTool({
      workspace: tmpRoot(),
      config: new ImageGenerationToolConfig({ enabled: true }),
    }).execute({ prompt: "draw" });

    expect(result).toMatch(/^Error: OpenAI API key is not configured/);
  });

  it("selects the AIHubMix provider config", async () => {
    registerImageGenProvider(FakeAIHubMixClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        provider: "aihubmix",
        model: "gpt-image-2-free",
        apiKey: "sk-ahm-test",
        extraBody: { quality: "low" },
      }),
    });

    const result = await tool.execute({ prompt: "draw a poster", aspect_ratio: "3:4" });

    expect(JSON.parse(result).artifacts).toHaveLength(1);
    const fake = FakeImageClient.instances[0];
    expect(fake.apiKey).toBe("sk-ahm-test");
    expect(fake.extraBody).toEqual({ quality: "low" });
    expect(fake.calls[0]).toMatchObject({ model: "gpt-image-2-free", aspectRatio: "3:4" });
  });

  it("reports a missing AIHubMix key", async () => {
    const result = await new ImageGenerationTool({
      workspace: tmpRoot(),
      config: new ImageGenerationToolConfig({ enabled: true, provider: "aihubmix" }),
    }).execute({ prompt: "draw" });

    expect(result).toMatch(/^Error: AIHubMix API key is not configured/);
  });

  it("allows Ollama without an API key", async () => {
    registerImageGenProvider(FakeOllamaClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({
        enabled: true,
        provider: "ollama",
        model: "x/z-image-turbo",
        apiBase: "http://localhost:11434/v1",
      }),
    });

    const result = await tool.execute({ prompt: "draw a cat" });

    expect(JSON.parse(result).artifacts).toHaveLength(1);
    const fake = FakeImageClient.instances[0];
    expect(fake.apiKey).toBeNull();
    expect(fake.apiBase).toBe("http://localhost:11434/v1");
    expect(fake.calls[0]).toMatchObject({ aspectRatio: "1:1", imageSize: "1K" });
  });

  it("reports a missing Zhipu key", async () => {
    const result = await new ImageGenerationTool({
      workspace: tmpRoot(),
      config: new ImageGenerationToolConfig({
        enabled: true,
        provider: "zhipu",
        model: "glm-image",
        apiBase: "https://open.bigmodel.cn/api/paas/v4",
      }),
    }).execute({ prompt: "draw a cat" });

    expect(result).toMatch(/^Error: Zhipu API key is not configured/);
  });

  it("rejects reference images outside the workspace", async () => {
    registerImageGenProvider(FakeImageClient);
    const root = tmpRoot();
    process.env.MEMMY_CONFIG = path.join(root, "config.yaml");
    const outsideRoot = tmpRoot();
    const outside = path.join(outsideRoot, "outside.png");
    fs.writeFileSync(outside, PNG_BYTES);
    const tool = new ImageGenerationTool({
      workspace: root,
      config: new ImageGenerationToolConfig({ enabled: true, apiKey: "sk-image-test" }),
    });

    const result = await tool.execute({ prompt: "edit", reference_images: [outside] });

    expect(result).toContain("reference_images must be inside the workspace");
    expect(JSON.parse(await tool.execute({ prompt: "retry" })).artifacts).toHaveLength(1);
  });
});
