import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIHubMixImageGenerationClient,
  AzureOpenAIImageGenerationClient,
  BedrockNovaCanvasImageGenerationClient,
  BytePlusImageGenerationClient,
  CodexImageGenerationClient,
  CustomImageGenerationClient,
  DashScopeImageGenerationClient,
  GeminiImageGenerationClient,
  GeneratedImageResponse,
  ImageGenerationError,
  MemmyAccountImageGenerationClient,
  MiniMaxImageGenerationClient,
  NvidiaImageGenerationClient,
  OpenAIImageGenerationClient,
  OllamaImageGenerationClient,
  OpenRouterImageGenerationClient,
  QianfanImageGenerationClient,
  StepFunImageGenerationClient,
  VolcEngineImageGenerationClient,
  ZhipuImageGenerationClient,
  imageGenProviderNames,
} from "../../src/providers/image-generation.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;
const RAW_B64 = PNG_DATA_URL.replace(/^data:image\/png;base64,/, "");
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...new Array(12).fill(0x30)]);
const roots: string[] = [];
const codexEnvKeys = [
  "OPENAI_CODEX_ACCESS_TOKEN",
  "CHATGPT_ACCESS_TOKEN",
  "OPENAI_CODEX_ACCOUNT_ID",
  "CHATGPT_ACCOUNT_ID",
] as const;
const savedCodexEnv = Object.fromEntries(codexEnvKeys.map((key) => [key, process.env[key]]));

class FakeResponse {
  status: number;
  statusCode: number;
  text: string | (() => string | Promise<string>);
  content: Buffer;

  constructor(
    public payload: Record<string, any>,
    {
      status = 200,
      content = Buffer.alloc(0),
      text,
    }: { status?: number; content?: Buffer; text?: string | (() => string | Promise<string>) } = {},
  ) {
    this.status = status;
    this.statusCode = status;
    this.text = text ?? JSON.stringify(payload);
    this.content = content;
  }

  json(): Record<string, any> {
    return this.payload;
  }
}

class FakeClient {
  calls: any[] = [];
  getCalls: any[] = [];

  constructor(
    public response: FakeResponse,
    public getResponse = response,
  ) {}

  async post(url: string, kwargs: any): Promise<FakeResponse> {
    this.calls.push({ url, ...kwargs });
    return this.response;
  }

  async get(url: string): Promise<FakeResponse> {
    this.getCalls.push({ url });
    return this.getResponse;
  }
}

class FakeBedrockClient {
  calls: any[] = [];

  constructor(public payload: Record<string, any>) {}

  async send(command: any): Promise<Record<string, any>> {
    this.calls.push(command.input ?? command);
    return { body: Buffer.from(JSON.stringify(this.payload)) };
  }
}

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-provider-image-"));
  roots.push(root);
  return root;
}

function writePng(name = "ref.png"): string {
  const file = path.join(tmpRoot(), name);
  fs.writeFileSync(file, PNG_BYTES);
  return file;
}

function fakeSse(lines: string[]): FakeResponse {
  return new FakeResponse({}, { text: lines.join("\n") });
}

function setCodexEnv(access = "oauth-token", accountId = "acct-123"): void {
  process.env.OPENAI_CODEX_ACCESS_TOKEN = access;
  process.env.OPENAI_CODEX_ACCOUNT_ID = accountId;
  delete process.env.CHATGPT_ACCESS_TOKEN;
  delete process.env.CHATGPT_ACCOUNT_ID;
}

function clearCodexEnv(): void {
  for (const key of codexEnvKeys) delete process.env[key];
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const key of codexEnvKeys) {
    const saved = savedCodexEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

describe("image generation provider parity", () => {
  it("registers only canonical image generation providers", () => {
    expect(imageGenProviderNames()).toEqual([
      "openai",
      "custom",
      "memmy_account",
      "azure_openai",
      "bedrock",
      "openrouter",
      "aihubmix",
      "ollama",
      "gemini",
      "minimax",
      "stepfun",
      "zhipu",
      "openai_codex",
      "volcengine",
      "byteplus",
      "dashscope",
      "qianfan",
      "nvidia",
    ]);
  });

  it("memmy account image generation uses chat completions URL with DashScope payload", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        output: { choices: [{ message: { content: [{ image: "https://cdn.example/account.png" }] } }] },
      }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new MemmyAccountImageGenerationClient({
      apiKey: "cloud-login-uuid",
      apiBase: "https://cloud.example.com/api/agentExternal/v1",
      client: fake,
    });

    const response = await client.generate({
      prompt: "draw a cat",
      model: "image_gen",
      aspectRatio: "1:1",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://cloud.example.com/api/agentExternal/v1/chat/completions");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer cloud-login-uuid");
    expect(fake.calls[0].json).toMatchObject({
      model: "image_gen",
      input: { messages: [{ role: "user", content: [{ text: "draw a cat" }] }] },
      parameters: { size: "1328*1328", n: 1, watermark: false },
    });
    expect(fake.calls[0].json.prompt).toBeUndefined();
    expect(fake.calls[0].json.response_format).toBeUndefined();
    expect(fake.getCalls[0].url).toBe("https://cdn.example/account.png");
  });

  it("memmy account image generation extracts DashScope data URLs", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        output: { choices: [{ message: { content: [{ image: PNG_DATA_URL }] } }] },
      }),
    );
    const client = new MemmyAccountImageGenerationClient({
      apiKey: "cloud-login-uuid",
      apiBase: "https://cloud.example.com/api/agentExternal/v1",
      client: fake,
    });

    const response = await client.generate({ prompt: "draw a cat", model: "image_gen" });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.getCalls).toHaveLength(0);
  });

  it("memmy account no images error includes provider response summary", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        request_id: "rid-123",
        output: { choices: [{ message: { content: [{ text: "no image" }] } }] },
      }),
    );
    const client = new MemmyAccountImageGenerationClient({
      apiKey: "cloud-login-uuid",
      apiBase: "https://cloud.example.com/api/agentExternal/v1",
      client: fake,
    });

    await expect(client.generate({ prompt: "draw a cat", model: "image_gen" })).rejects.toThrow(
      /rid-123/,
    );
  });

  it("openrouter image generation payload and response", async () => {
    const ref = writePng();
    const fake = new FakeClient(
      new FakeResponse({
        choices: [{ message: { content: "done", images: [{ image_url: { url: PNG_DATA_URL } }] } }],
      }),
    );
    const client = new OpenRouterImageGenerationClient({
      apiKey: "sk-or-test",
      apiBase: "https://openrouter.ai/api/v1/",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "make this blue",
      model: "openai/gpt-5.4-image-2",
      referenceImages: [ref],
      aspectRatio: "16:9",
      imageSize: "2K",
    });

    expect(response).toBeInstanceOf(GeneratedImageResponse);
    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(response.content).toBe("done");
    expect(fake.calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-or-test");
    expect(fake.calls[0].headers["HTTP-Referer"]).toBe("https://github.com/MemTensor/memmy-agent");
    expect(fake.calls[0].headers["X-OpenRouter-Title"]).toBe("Memmy Agent");
    expect(fake.calls[0].headers["X-OpenRouter-Categories"]).toBe("personal-agent,cli-agent");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json.modalities).toEqual(["image", "text"]);
    expect(fake.calls[0].json.image_config).toEqual({ aspect_ratio: "16:9", image_size: "2K" });
    expect(fake.calls[0].json.messages[0].content[0]).toEqual({
      type: "text",
      text: "make this blue",
    });
    expect(fake.calls[0].json.messages[0].content[1].image_url.url).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("openrouter image generation requires images", async () => {
    const fake = new FakeClient(
      new FakeResponse({ choices: [{ message: { content: "text only" } }] }),
    );
    const client = new OpenRouterImageGenerationClient({ apiKey: "sk-or-test", client: fake });
    await expect(client.generate({ prompt: "draw", model: "model" })).rejects.toThrow(
      /returned no images/,
    );
  });

  it("openrouter image generation requires api key", async () => {
    const client = new OpenRouterImageGenerationClient({ apiKey: null });
    await expect(client.generate({ prompt: "draw", model: "model" })).rejects.toThrow(/API key/);
  });

  it("ollama image generation payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ image: RAW_B64 }));
    const client = new OllamaImageGenerationClient({
      apiKey: "ollama-test",
      apiBase: "http://localhost:11434/v1/",
      extraHeaders: { "X-Test": "1" },
      extraBody: { seed: 123 },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a sunset",
      model: "x/z-image-turbo",
      aspectRatio: "16:9",
      imageSize: "1K",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(response.content).toBe("");
    expect(fake.calls[0].url).toBe("http://localhost:11434/api/generate");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer ollama-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "x/z-image-turbo",
      prompt: "a sunset",
      width: 1024,
      height: 576,
      steps: 0,
      stream: false,
      seed: 123,
    });
  });

  it("ollama image generation rejects reference images", async () => {
    const client = new OllamaImageGenerationClient({ apiKey: null });
    await expect(
      client.generate({
        prompt: "edit this",
        model: "x/z-image-turbo",
        referenceImages: ["ref.png"],
      }),
    ).rejects.toThrow(/reference images/);
  });

  it("aihubmix image generation payload and response", async () => {
    const fake = new FakeClient(
      new FakeResponse({ output: { b64_json: [{ bytesBase64: RAW_B64 }] } }),
    );
    const client = new AIHubMixImageGenerationClient({
      apiKey: "sk-ahm-test",
      apiBase: "https://aihubmix.com/v1/",
      extraHeaders: { "APP-Code": "memmy" },
      extraBody: { quality: "low" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "draw a logo",
      model: "gpt-image-2-free",
      aspectRatio: "16:9",
      imageSize: "1K",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe(
      "https://aihubmix.com/v1/models/openai/gpt-image-2-free/predictions",
    );
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-ahm-test");
    expect(fake.calls[0].headers["APP-Code"]).toBe("memmy");
    expect(fake.calls[0].json).toEqual({
      input: { prompt: "draw a logo", n: 1, size: "1536x1024", quality: "low" },
    });
  });

  it("aihubmix image edit payload uses reference images", async () => {
    const ref = writePng();
    const fake = new FakeClient(new FakeResponse({ output: [{ b64_json: RAW_B64 }] }));
    const client = new AIHubMixImageGenerationClient({ apiKey: "sk-ahm-test", client: fake });

    const response = await client.generate({
      prompt: "edit this",
      model: "gpt-image-2-free",
      referenceImages: [ref],
      aspectRatio: "1:1",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe(
      "https://aihubmix.com/v1/models/openai/gpt-image-2-free/predictions",
    );
    expect(fake.calls[0].json.input.prompt).toBe("edit this");
    expect(fake.calls[0].json.input.n).toBe(1);
    expect(fake.calls[0].json.input.size).toBe("1024x1024");
    expect(fake.calls[0].json.input.image).toMatch(/^data:image\/png;base64,/);
  });

  it("aihubmix image generation downloads url response", async () => {
    const fake = new FakeClient(
      new FakeResponse({ data: [{ url: "https://cdn.example/image.png" }] }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new AIHubMixImageGenerationClient({ apiKey: "sk-ahm-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "gpt-image-2-free" });

    expect(response.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(fake.getCalls[0].url).toBe("https://cdn.example/image.png");
  });

  it("aihubmix base64 response uses detected mime", async () => {
    const rawB64 = JPEG_BYTES.toString("base64");
    const fake = new FakeClient(new FakeResponse({ output: { b64_json: rawB64 } }));
    const client = new AIHubMixImageGenerationClient({ apiKey: "sk-ahm-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "gpt-image-2-free" });

    expect(response.images).toEqual([`data:image/jpeg;base64,${rawB64}`]);
  });

  it("gemini imagen payload and response", async () => {
    const fake = new FakeClient(
      new FakeResponse({ predictions: [{ bytesBase64Encoded: RAW_B64, mimeType: "image/png" }] }),
    );
    const client = new GeminiImageGenerationClient({
      apiKey: "AIza-test",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      client: fake,
    });

    const response = await client.generate({
      prompt: "a sunset",
      model: "imagen-4.0-generate-001",
      aspectRatio: "16:9",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(response.content).toBe("");
    expect(fake.calls[0].url).toMatch(/:predict$/);
    expect(fake.calls[0].headers["x-goog-api-key"]).toBe("AIza-test");
    expect(fake.calls[0].params).toBeUndefined();
    expect(fake.calls[0].json.instances).toEqual([{ prompt: "a sunset" }]);
    expect(fake.calls[0].json.parameters.sampleCount).toBe(1);
    expect(fake.calls[0].json.parameters.aspectRatio).toBe("16:9");
  });

  it("gemini imagen ignores unsupported aspect ratio", async () => {
    const fake = new FakeClient(
      new FakeResponse({ predictions: [{ bytesBase64Encoded: RAW_B64, mimeType: "image/png" }] }),
    );
    const client = new GeminiImageGenerationClient({ apiKey: "AIza-test", client: fake });

    await client.generate({
      prompt: "a sunset",
      model: "imagen-4.0-generate-001",
      aspectRatio: "2:3",
    });

    expect(fake.calls[0].json.parameters.aspectRatio).toBeUndefined();
  });

  it("gemini flash payload and response", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        candidates: [
          {
            content: {
              parts: [
                { text: "here is your image" },
                { inlineData: { mimeType: "image/png", data: RAW_B64 } },
              ],
            },
          },
        ],
      }),
    );
    const client = new GeminiImageGenerationClient({
      apiKey: "AIza-test",
      apiBase: "https://generativelanguage.googleapis.com/v1beta",
      client: fake,
    });

    const response = await client.generate({
      prompt: "draw a cat",
      model: "gemini-2.0-flash-preview-image-generation",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(response.content).toBe("here is your image");
    expect(fake.calls[0].url).toMatch(/:generateContent$/);
    expect(fake.calls[0].headers["x-goog-api-key"]).toBe("AIza-test");
    expect(fake.calls[0].params).toBeUndefined();
    expect(fake.calls[0].json.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(fake.calls[0].json.contents[0].parts.at(-1)).toEqual({ text: "draw a cat" });
  });

  it("gemini flash reference images", async () => {
    const ref = writePng();
    const fake = new FakeClient(
      new FakeResponse({
        candidates: [
          { content: { parts: [{ inlineData: { mimeType: "image/png", data: RAW_B64 } }] } },
        ],
      }),
    );
    const client = new GeminiImageGenerationClient({ apiKey: "AIza-test", client: fake });

    const response = await client.generate({
      prompt: "edit this",
      model: "gemini-2.0-flash-preview-image-generation",
      referenceImages: [ref],
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    const parts = fake.calls[0].json.contents[0].parts;
    expect(parts[0].inlineData.mimeType).toBe("image/png");
    expect(parts[0].inlineData.data).toMatch(/^iVBOR/);
    expect(parts[1]).toEqual({ text: "edit this" });
  });

  it("gemini requires api key", async () => {
    const client = new GeminiImageGenerationClient({ apiKey: null });
    await expect(
      client.generate({ prompt: "draw", model: "imagen-4.0-generate-001" }),
    ).rejects.toThrow(/API key/);
  });

  it("gemini image client uses native api base by default", () => {
    const client = new GeminiImageGenerationClient({ apiKey: "AIza-test" });
    expect(client.apiBase).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("gemini no images raises", async () => {
    const fake = new FakeClient(
      new FakeResponse({ candidates: [{ content: { parts: [{ text: "sorry" }] } }] }),
    );
    const client = new GeminiImageGenerationClient({ apiKey: "AIza-test", client: fake });
    await expect(
      client.generate({ prompt: "draw", model: "gemini-2.0-flash-preview-image-generation" }),
    ).rejects.toThrow(/returned no images/);
  });

  it("minimax payload and response with reference image", async () => {
    const ref = writePng();
    const fake = new FakeClient(new FakeResponse({ data: { image_base64: [RAW_B64] } }));
    const client = new MiniMaxImageGenerationClient({
      apiKey: "sk-mm-test",
      apiBase: "https://api.minimaxi.com/v1/",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "draw a character",
      model: "image-01",
      referenceImages: [ref],
      aspectRatio: "21:9",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://api.minimaxi.com/v1/image_generation");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-mm-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json.model).toBe("image-01");
    expect(fake.calls[0].json.prompt).toBe("draw a character");
    expect(fake.calls[0].json.response_format).toBe("base64");
    expect(fake.calls[0].json.aspect_ratio).toBe("21:9");
    expect(fake.calls[0].json.subject_reference[0].type).toBe("character");
    expect(fake.calls[0].json.subject_reference[0].image_file).toMatch(/^data:image\/png;base64,/);
  });

  it("minimax base64 response uses detected mime", async () => {
    const rawB64 = JPEG_BYTES.toString("base64");
    const fake = new FakeClient(new FakeResponse({ data: { image_base64: [rawB64] } }));
    const client = new MiniMaxImageGenerationClient({ apiKey: "sk-mm-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "image-01" });

    expect(response.images).toEqual([`data:image/jpeg;base64,${rawB64}`]);
  });

  it("stepfun payload and response with aspect ratio", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new StepFunImageGenerationClient({
      apiKey: "sk-sf-test",
      apiBase: "https://api.stepfun.com/v1",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a cat on the moon",
      model: "step-image-edit-2",
      aspectRatio: "16:9",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://api.stepfun.com/v1/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-sf-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "step-image-edit-2",
      prompt: "a cat on the moon",
      response_format: "b64_json",
      n: 1,
      size: "1280x800",
    });
  });

  it("stepfun default size when no aspect ratio", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new StepFunImageGenerationClient({
      apiKey: "sk-sf-test",
      apiBase: "https://api.stepfun.com/v1",
      client: fake,
    });

    await client.generate({ prompt: "a dog", model: "step-image-edit-2" });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("stepfun uses explicit image size", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new StepFunImageGenerationClient({
      apiKey: "sk-sf-test",
      apiBase: "https://api.stepfun.com/v1",
      client: fake,
    });

    await client.generate({ prompt: "a bird", model: "step-image-edit-2", imageSize: "1024x1024" });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("stepfun style reference on 1x model", async () => {
    const ref = writePng();
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new StepFunImageGenerationClient({
      apiKey: "sk-sf-test",
      apiBase: "https://api.stepfun.com/v1",
      client: fake,
    });

    await client.generate({
      prompt: "in this style",
      model: "step-1x-medium",
      referenceImages: [ref],
    });

    expect(fake.calls[0].json.style_reference.source_url).toMatch(/^data:image\/png;base64,/);
  });

  it("stepfun no style reference on non 1x model", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new StepFunImageGenerationClient({
      apiKey: "sk-sf-test",
      apiBase: "https://api.stepfun.com/v1",
      client: fake,
    });

    await client.generate({
      prompt: "a flower",
      model: "step-image-edit-2",
      referenceImages: ["/tmp/ref.png"],
    });

    expect(fake.calls[0].json.style_reference).toBeUndefined();
  });

  it("stepfun requires api key", async () => {
    const client = new StepFunImageGenerationClient({ apiKey: null });
    await expect(client.generate({ prompt: "draw", model: "step-image-edit-2" })).rejects.toThrow(
      /API key/,
    );
  });

  it("stepfun no images raises", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ text: "sorry" }] }));
    const client = new StepFunImageGenerationClient({ apiKey: "sk-sf-test", client: fake });
    await expect(client.generate({ prompt: "draw", model: "step-image-edit-2" })).rejects.toThrow(
      /returned no images/,
    );
  });

  it("openai payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({
      apiKey: "sk-openai-test",
      apiBase: "https://api.openai.com/v1",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a cat on the moon",
      model: "dall-e-3",
      aspectRatio: "16:9",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://api.openai.com/v1/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-openai-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "dall-e-3",
      prompt: "a cat on the moon",
      response_format: "b64_json",
      n: 1,
      size: "1792x1024",
    });
  });

  it("openai b64 json response uses detected mime", async () => {
    const rawB64 = JPEG_BYTES.toString("base64");
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: rawB64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "dall-e-3" });

    expect(response.images).toEqual([`data:image/jpeg;base64,${rawB64}`]);
  });

  it("openai url download fallback", async () => {
    const fake = new FakeClient(
      new FakeResponse({ data: [{ url: "https://cdn.example/image.png" }] }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "dall-e-3" });

    expect(response.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(fake.getCalls[0].url).toBe("https://cdn.example/image.png");
  });

  it("openai multiple images", async () => {
    const fake = new FakeClient(
      new FakeResponse({ data: [{ b64_json: RAW_B64 }, { b64_json: RAW_B64 }] }),
    );
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "dall-e-3" });

    expect(response.images).toHaveLength(2);
    expect(response.images).toEqual([PNG_DATA_URL, PNG_DATA_URL]);
  });

  it("openai aspect ratio to size", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({ prompt: "draw", model: "dall-e-3", aspectRatio: "1:1" });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("openai dalle3 uses supported orientation sizes", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({ prompt: "draw", model: "dall-e-3", aspectRatio: "3:4" });
    await client.generate({ prompt: "draw", model: "dall-e-3", aspectRatio: "4:3" });

    expect(fake.calls[0].json.size).toBe("1024x1792");
    expect(fake.calls[1].json.size).toBe("1792x1024");
  });

  it("openai dalle2 uses square size for non square ratios", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({ prompt: "draw", model: "dall-e-2", aspectRatio: "16:9" });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("openai gpt image uses supported landscape size", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({ prompt: "draw", model: "gpt-image-1", aspectRatio: "16:9" });

    expect(fake.calls[0].json.size).toBe("1536x1024");
  });

  it("openai gpt image uses supported orientation sizes", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({ prompt: "draw", model: "gpt-image-1", aspectRatio: "3:4" });
    await client.generate({ prompt: "draw", model: "gpt-image-1", aspectRatio: "4:3" });

    expect(fake.calls[0].json.size).toBe("1024x1536");
    expect(fake.calls[1].json.size).toBe("1536x1024");
  });

  it("openai default size when no aspect ratio", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({ prompt: "draw", model: "dall-e-3" });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("openai ignores explicit size unsupported by model family", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({
      prompt: "draw",
      model: "dall-e-3",
      aspectRatio: "16:9",
      imageSize: "1536x1024",
    });

    expect(fake.calls[0].json.size).toBe("1792x1024");
  });

  it("openai uses explicit image size", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });

    await client.generate({
      prompt: "draw",
      model: "dall-e-3",
      aspectRatio: "16:9",
      imageSize: "1024x1024",
    });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("openai requires api key", async () => {
    const client = new OpenAIImageGenerationClient({ apiKey: null });
    await expect(client.generate({ prompt: "draw", model: "dall-e-3" })).rejects.toThrow(/API key/);
  });

  it("codex payload and response", async () => {
    setCodexEnv();
    const fake = new FakeClient(
      fakeSse([
        'data: {"type":"response.output_item.added","item":{"id":"ig_1","type":"image_generation_call","status":"in_progress"}}',
        "",
        `data: {"type":"response.output_item.done","item":{"id":"ig_1","type":"image_generation_call","result":"${PNG_DATA_URL}","status":"completed"}}`,
        "",
        "data: [DONE]",
        "",
      ]),
    );
    const client = new CodexImageGenerationClient({
      apiKey: null,
      apiBase: "https://chatgpt.com/backend-api",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({ prompt: "draw a cat", model: "gpt-5.4" });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(response.content).toBe("");
    expect(fake.calls[0].url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer oauth-token");
    expect(fake.calls[0].headers["chatgpt-account-id"]).toBe("acct-123");
    expect(fake.calls[0].headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "gpt-5.4",
      instructions: "Generate an image based on the user's request.",
      input: [{ role: "user", content: "draw a cat" }],
      tools: [{ type: "image_generation" }],
      tool_choice: "auto",
      stream: true,
      store: false,
    });
  });

  it("codex strips model prefix", async () => {
    setCodexEnv();
    const fake = new FakeClient(
      fakeSse([
        `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${PNG_DATA_URL}"}}`,
        "",
        "data: [DONE]",
        "",
      ]),
    );
    const client = new CodexImageGenerationClient({ apiKey: null, client: fake });

    await client.generate({ prompt: "draw", model: "openai-codex/gpt-5.4" });

    expect(fake.calls[0].json.model).toBe("gpt-5.4");
  });

  it("codex requires oauth", async () => {
    clearCodexEnv();
    const client = new CodexImageGenerationClient({ apiKey: null });
    await expect(client.generate({ prompt: "draw", model: "gpt-5.4" })).rejects.toThrow(
      /OAuth token/,
    );
  });

  it("codex no images raises", async () => {
    setCodexEnv();
    const fake = new FakeClient(
      fakeSse([
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        "",
        "data: [DONE]",
        "",
      ]),
    );
    const client = new CodexImageGenerationClient({ apiKey: null, client: fake });

    await expect(client.generate({ prompt: "draw", model: "gpt-5.4" })).rejects.toThrow(
      /returned no images/,
    );
  });

  it("codex extracts text content", async () => {
    setCodexEnv();
    const fake = new FakeClient(
      fakeSse([
        'data: {"type":"response.output_text.delta","delta":"Here "}',
        "",
        'data: {"type":"response.output_text.delta","delta":"is your cat image."}',
        "",
        `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":"${PNG_DATA_URL}"}}`,
        "",
        "data: [DONE]",
        "",
      ]),
    );
    const client = new CodexImageGenerationClient({ apiKey: null, client: fake });

    const response = await client.generate({ prompt: "draw a cat", model: "gpt-5.4" });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(response.content).toBe("Here is your cat image.");
  });

  it("codex json result format", async () => {
    setCodexEnv();
    const fake = new FakeClient(
      fakeSse([
        `data: {"type":"response.output_item.done","item":{"type":"image_generation_call","result":{"image_url":"${PNG_DATA_URL}"}}}`,
        "",
        "data: [DONE]",
        "",
      ]),
    );
    const client = new CodexImageGenerationClient({ apiKey: null, client: fake });

    const response = await client.generate({ prompt: "draw", model: "gpt-5.4" });

    expect(response.images).toEqual([PNG_DATA_URL]);
  });

  it("openai no images raises", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [] }));
    const client = new OpenAIImageGenerationClient({ apiKey: "sk-openai-test", client: fake });
    await expect(client.generate({ prompt: "draw", model: "dall-e-3" })).rejects.toThrow(
      /returned no images/,
    );
  });

  it("zhipu image generation payload and response", async () => {
    const fake = new FakeClient(
      new FakeResponse({ data: [{ url: "https://cdn.example/image.png" }] }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new ZhipuImageGenerationClient({
      apiKey: "sk-zhipu-test",
      apiBase: "https://open.bigmodel.cn/api/paas/v4",
      extraHeaders: { "X-Test": "1" },
      extraBody: { watermark_enabled: false },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a sunset over the ocean",
      model: "glm-image",
      aspectRatio: "16:9",
      imageSize: "2K",
    });

    expect(response.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(fake.calls[0].url).toBe("https://open.bigmodel.cn/api/paas/v4/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-zhipu-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "glm-image",
      prompt: "a sunset over the ocean",
      size: "1728x960",
      watermark_enabled: false,
    });
  });

  it("zhipu image generation with explicit size", async () => {
    const fake = new FakeClient(
      new FakeResponse({ data: [{ url: "https://cdn.example/image.png" }] }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new ZhipuImageGenerationClient({ apiKey: "sk-zhipu-test", client: fake });

    await client.generate({ prompt: "a cat", model: "cogview-4", imageSize: "1024x1024" });

    expect(fake.calls[0].json.size).toBe("1024x1024");
  });

  it("zhipu image generation downloads url response", async () => {
    const fake = new FakeClient(
      new FakeResponse({ data: [{ url: "https://cdn.example/image.png" }] }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new ZhipuImageGenerationClient({ apiKey: "sk-zhipu-test", client: fake });

    const response = await client.generate({ prompt: "draw", model: "glm-image" });

    expect(response.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(fake.getCalls[0].url).toBe("https://cdn.example/image.png");
  });

  it("zhipu image generation requires api key", async () => {
    const client = new ZhipuImageGenerationClient({ apiKey: null });
    await expect(client.generate({ prompt: "draw", model: "glm-image" })).rejects.toThrow(
      /API key/,
    );
  });

  it("zhipu image generation no images raises", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ text: "sorry" }] }));
    const client = new ZhipuImageGenerationClient({ apiKey: "sk-zhipu-test", client: fake });
    await expect(client.generate({ prompt: "draw", model: "glm-image" })).rejects.toThrow(
      /returned no images/,
    );
  });

  it("zhipu image generation rejects reference images", async () => {
    const client = new ZhipuImageGenerationClient({ apiKey: "sk-zhipu-test" });
    await expect(
      client.generate({ prompt: "edit this", model: "glm-image", referenceImages: ["ref.png"] }),
    ).rejects.toThrow(/reference images/);
  });

  it("custom OpenAI images compatible payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new CustomImageGenerationClient({
      apiKey: "sk-custom-test",
      apiBase: "https://image.example/v1",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({ prompt: "a cat", model: "custom-image-model" });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://image.example/v1/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-custom-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "custom-image-model",
      prompt: "a cat",
      response_format: "b64_json",
      n: 1,
    });
  });

  it("custom requires api base", async () => {
    const client = new CustomImageGenerationClient({ apiKey: "sk-custom-test" });
    await expect(client.generate({ prompt: "draw", model: "custom-image-model" })).rejects.toThrow(
      /API base|api base/,
    );
  });

  it("azure openai payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new AzureOpenAIImageGenerationClient({
      apiKey: "az-test",
      apiBase: "https://resource.openai.azure.com",
      extraHeaders: { "X-Test": "1" },
      extraBody: { api_version: "2025-04-01-preview", quality: "low" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a cat",
      model: "gpt-image-2",
      aspectRatio: "16:9",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe(
      "https://resource.openai.azure.com/openai/v1/images/generations?api-version=2025-04-01-preview",
    );
    expect(fake.calls[0].headers["api-key"]).toBe("az-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "gpt-image-2",
      prompt: "a cat",
      size: "1536x1024",
      quality: "low",
    });
    expect(fake.calls[0].json.api_version).toBeUndefined();
  });

  it("bedrock nova canvas payload and response", async () => {
    const fake = new FakeBedrockClient({ images: [RAW_B64] });
    const client = new BedrockNovaCanvasImageGenerationClient({
      extraBody: { region: "us-east-1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a cat",
      model: "amazon.nova-canvas-v1:0",
      aspectRatio: "16:9",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].modelId).toBe("amazon.nova-canvas-v1:0");
    expect(JSON.parse(fake.calls[0].body)).toMatchObject({
      taskType: "TEXT_IMAGE",
      textToImageParams: { text: "a cat" },
      imageGenerationConfig: {
        numberOfImages: 1,
        width: 1344,
        height: 768,
      },
    });
  });

  it("volcengine image generation payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new VolcEngineImageGenerationClient({
      apiKey: "sk-volc-test",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a cat",
      model: "doubao-seedream-4-0-250828",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-volc-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      model: "doubao-seedream-4-0-250828",
      prompt: "a cat",
      response_format: "b64_json",
      n: 1,
    });
  });

  it("volcengine uses default base url", () => {
    const client = new VolcEngineImageGenerationClient({ apiKey: "x" });
    expect(client.apiBase).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("volcengine requires api key", async () => {
    const client = new VolcEngineImageGenerationClient({ apiKey: null });
    await expect(
      client.generate({ prompt: "draw", model: "doubao-seedream-4-0-250828" }),
    ).rejects.toThrow(/API key/);
  });

  it("byteplus image generation payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new BytePlusImageGenerationClient({
      apiKey: "bp-test",
      client: fake,
    });

    const response = await client.generate({ prompt: "a logo", model: "seedream-4-0-250828" });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe("https://ark.ap-southeast.bytepluses.com/api/v3/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer bp-test");
    expect(fake.calls[0].json.model).toBe("seedream-4-0-250828");
  });

  it("nvidia image generation payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_json: RAW_B64 }] }));
    const client = new NvidiaImageGenerationClient({ apiKey: "nv-test", client: fake });

    await client.generate({ prompt: "a logo", model: "black-forest-labs/flux.1-dev" });

    expect(fake.calls[0].url).toBe("https://integrate.api.nvidia.com/v1/images/generations");
    expect(fake.calls[0].headers.Authorization).toBe("Bearer nv-test");
    expect(fake.calls[0].json.model).toBe("black-forest-labs/flux.1-dev");
  });

  it("dashscope image generation payload and response", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        output: { choices: [{ message: { content: [{ image: "https://cdn.example/q.png" }] } }] },
      }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new DashScopeImageGenerationClient({
      apiKey: "sk-dashscope-test",
      apiBase: "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1",
      extraHeaders: { "X-Test": "1" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a panda",
      model: "qwen-image-2.0-pro",
      aspectRatio: "16:9",
    });

    expect(response.images[0]).toMatch(/^data:image\/png;base64,/);
    expect(fake.calls[0].url).toBe(
      "https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(fake.calls[0].headers.Authorization).toBe("Bearer sk-dashscope-test");
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json.model).toBe("qwen-image-2.0-pro");
    expect(fake.calls[0].json.input.messages[0].content[0]).toEqual({ text: "a panda" });
    expect(fake.calls[0].json.parameters.size).toBe("2688*1536");
    expect(fake.getCalls[0].url).toBe("https://cdn.example/q.png");
  });

  it("dashscope uses default base url", () => {
    const client = new DashScopeImageGenerationClient({ apiKey: "x" });
    expect(client.apiBase).toBe("https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1");
  });

  it("dashscope qwen-image-2 default square size", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        output: { choices: [{ message: { content: [{ image: "https://cdn.example/q.png" }] } }] },
      }),
      new FakeResponse({}, { content: PNG_BYTES }),
    );
    const client = new DashScopeImageGenerationClient({ apiKey: "sk-dashscope-test", client: fake });

    await client.generate({ prompt: "a panda", model: "qwen-image-2.0-pro" });

    expect(fake.calls[0].json.parameters.size).toBe("2048*2048");
  });

  it("dashscope keeps legacy qwen-image size mapping", async () => {
    const fake = new FakeClient(
      new FakeResponse({
        output: { choices: [{ message: { content: [{ image: PNG_DATA_URL }] } }] },
      }),
    );
    const client = new DashScopeImageGenerationClient({ apiKey: "sk-dashscope-test", client: fake });

    await client.generate({ prompt: "a panda", model: "qwen-image", aspectRatio: "16:9" });

    expect(fake.calls[0].json.parameters.size).toBe("1664*928");
  });

  it("dashscope requires api key", async () => {
    const client = new DashScopeImageGenerationClient({ apiKey: null });
    await expect(client.generate({ prompt: "draw", model: "qwen-image" })).rejects.toThrow(
      /API key/,
    );
  });

  it("dashscope no images raises", async () => {
    const fake = new FakeClient(
      new FakeResponse({ output: { choices: [{ message: { content: [{ text: "sorry" }] } }] } }),
    );
    const client = new DashScopeImageGenerationClient({ apiKey: "sk-dashscope-test", client: fake });
    await expect(client.generate({ prompt: "draw", model: "qwen-image" })).rejects.toThrow(
      /returned no images/,
    );
  });

  it("provider HTTP errors include async response text bodies", async () => {
    const fake = new FakeClient(
      new FakeResponse(
        {},
        { status: 400, text: async () => '{"code":"InvalidApiKey","message":"bad key"}' },
      ),
    );
    const client = new DashScopeImageGenerationClient({ apiKey: "sk-dashscope-test", client: fake });

    await expect(client.generate({ prompt: "draw", model: "qwen-image" })).rejects.toThrow(
      /InvalidApiKey/,
    );
  });

  it("qianfan text2image payload and response", async () => {
    const fake = new FakeClient(new FakeResponse({ data: [{ b64_image: RAW_B64 }] }));
    const client = new QianfanImageGenerationClient({
      apiKey: "access-token",
      extraHeaders: { "X-Test": "1" },
      extraBody: { style: "Base" },
      client: fake,
    });

    const response = await client.generate({
      prompt: "a logo",
      model: "sd_xl",
      aspectRatio: "4:3",
    });

    expect(response.images).toEqual([PNG_DATA_URL]);
    expect(fake.calls[0].url).toBe(
      "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/text2image/sd_xl?access_token=access-token",
    );
    expect(fake.calls[0].headers["X-Test"]).toBe("1");
    expect(fake.calls[0].json).toMatchObject({
      prompt: "a logo",
      size: "1024x768",
      n: 1,
      steps: 20,
      style: "Base",
    });
  });

  it("qianfan exchanges api key and secret key for access token", async () => {
    const fake = new FakeClient(
      new FakeResponse({ access_token: "oauth-token" }),
      new FakeResponse({ data: [{ b64_image: RAW_B64 }] }),
    );
    fake.post = async (url: string, kwargs: any): Promise<FakeResponse> => {
      fake.calls.push({ url, ...kwargs });
      return fake.calls.length === 1
        ? new FakeResponse({ access_token: "oauth-token" })
        : new FakeResponse({ data: [{ b64_image: RAW_B64 }] });
    };
    const client = new QianfanImageGenerationClient({
      apiKey: "client-id",
      extraBody: { secret_key: "client-secret" },
      client: fake,
    });

    await client.generate({ prompt: "a logo", model: "sd_xl" });

    expect(fake.calls[0].url).toBe("https://aip.baidubce.com/oauth/2.0/token");
    expect(fake.calls[0].body).toContain("client_id=client-id");
    expect(fake.calls[1].url).toContain("access_token=oauth-token");
    expect(fake.calls[1].json.secret_key).toBeUndefined();
  });
});
