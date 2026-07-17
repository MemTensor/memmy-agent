import fs from "node:fs";
import path from "node:path";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { fromIni } from "@aws-sdk/credential-providers";
import { detectImageMime } from "../utils/helpers.js";
import { getCodexStorage } from "./openai-codex-provider.js";
import { OPENROUTER_ATTRIBUTION_HEADERS } from "./openrouter-attribution.js";

const AIHUBMIX_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "3:4": "1024x1536",
  "9:16": "1024x1536",
  "4:3": "1536x1024",
  "16:9": "1536x1024",
};

const OLLAMA_SIZE_PRESETS: Record<string, number> = { "1K": 1024, "2K": 2048, "4K": 4096 };
const GEMINI_IMAGEN_ASPECT_RATIOS = new Set(["1:1", "9:16", "16:9", "3:4", "4:3"]);
const MINIMAX_ASPECT_RATIO_SIZES = new Set([
  "1:1",
  "16:9",
  "4:3",
  "3:2",
  "2:3",
  "3:4",
  "9:16",
  "21:9",
]);
const STEPFUN_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1280x800",
  "9:16": "800x1280",
  "3:4": "768x1360",
  "4:3": "1360x768",
};
const ZHIPU_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1280x1280",
  "16:9": "1728x960",
  "9:16": "960x1728",
  "3:4": "1088x1472",
  "4:3": "1472x1088",
};
const OPENAI_DALLE2_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1024x1024",
  "9:16": "1024x1024",
  "3:4": "1024x1024",
  "4:3": "1024x1024",
};
const OPENAI_DALLE3_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "3:4": "1024x1792",
  "4:3": "1792x1024",
};
const OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "3:4": "1024x1536",
  "4:3": "1536x1024",
};
const QWEN_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1328*1328",
  "16:9": "1664*928",
  "9:16": "928*1664",
  "3:4": "1140*1472",
  "4:3": "1472*1140",
};
const QWEN_IMAGE_2_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "2048*2048",
  "16:9": "2688*1536",
  "9:16": "1536*2688",
};
const QIANFAN_ASPECT_RATIO_SIZES: Record<string, string> = {
  "1:1": "1024x1024",
  "16:9": "1024x576",
  "9:16": "576x1024",
  "3:4": "768x1024",
  "4:3": "1024x768",
};
const BEDROCK_NOVA_DIMENSIONS: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "3:4": [768, 1024],
  "4:3": [1024, 768],
};
const OPENAI_DALLE2_SUPPORTED_SIZES = new Set(["256x256", "512x512", "1024x1024"]);
const OPENAI_DALLE3_SUPPORTED_SIZES = new Set(["1024x1024", "1792x1024", "1024x1792"]);
const OPENAI_GPT_IMAGE_SUPPORTED_SIZES = new Set(["1024x1024", "1536x1024", "1024x1536", "auto"]);

export class ImageGenerationError extends Error {}

export class GeneratedImageResponse {
  images: string[];
  content: string;
  raw: Record<string, any>;
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;

  constructor(
    init: Partial<GeneratedImageResponse> & {
      images?: string[];
      content?: string;
      raw?: Record<string, any>;
    } = {},
  ) {
    this.images = init.images ?? [];
    this.content = init.content ?? "";
    this.raw = init.raw ?? {};
    this.url = init.url;
    this.b64Json = init.b64Json;
    this.revisedPrompt = init.revisedPrompt;
  }
}

function readImageB64(filePath: string): [string, string] {
  const raw = fs.readFileSync(path.resolve(filePath));
  const mime = detectImageMime(raw);
  if (!mime) throw new ImageGenerationError(`unsupported reference image: ${filePath}`);
  return [mime, raw.toString("base64")];
}

export function imagePathToDataUrl(filePath: string): string {
  const [mime, b64] = readImageB64(filePath);
  return `data:${mime};base64,${b64}`;
}

export function imagePathToInlineData(filePath: string): Record<string, string> {
  const [mime, b64] = readImageB64(filePath);
  return { mimeType: mime, data: b64 };
}

function b64ImageDataUrl(value: string): string {
  const encoded = value.replace(/\s+/g, "");
  const raw = Buffer.from(encoded, "base64");
  if (!raw.length || raw.toString("base64").replace(/=+$/g, "") !== encoded.replace(/=+$/g, "")) {
    throw new ImageGenerationError("generated image payload was not valid base64");
  }
  const mime = detectImageMime(raw);
  if (!mime) throw new ImageGenerationError("generated image payload was not a supported image");
  return `data:${mime};base64,${encoded}`;
}

function aihubmixSize(aspectRatio?: string | null, imageSize?: string | null): string {
  if (imageSize && imageSize.toLowerCase().includes("x")) return imageSize;
  if (aspectRatio && AIHUBMIX_ASPECT_RATIO_SIZES[aspectRatio])
    return AIHUBMIX_ASPECT_RATIO_SIZES[aspectRatio];
  return "auto";
}

function aihubmixModelPath(model: string): string {
  if (model.includes("/")) return model;
  if (model.startsWith("gpt-image-") || model.startsWith("dall-e-")) return `openai/${model}`;
  return model;
}

function roundToMultiple(value: number, multiple = 8): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function ollamaDimensions(
  aspectRatio?: string | null,
  imageSize?: string | null,
): [number, number] {
  const explicit = imageSize?.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
  if (explicit) return [Number(explicit[1]), Number(explicit[2])];
  const longSide = imageSize ? (OLLAMA_SIZE_PRESETS[imageSize.toUpperCase()] ?? 1024) : 1024;
  const ratio = aspectRatio?.match(/^\s*(\d+)\s*:\s*(\d+)\s*$/);
  if (!ratio) return [longSide, longSide];
  const rw = Number(ratio[1]);
  const rh = Number(ratio[2]);
  if (rw <= 0 || rh <= 0) return [longSide, longSide];
  if (rw >= rh) return [longSide, roundToMultiple((longSide * rh) / rw)];
  return [roundToMultiple((longSide * rw) / rh), longSide];
}

function statusCode(response: any): number {
  return response?.status ?? response?.statusCode ?? 200;
}

async function responseText(response: any): Promise<string> {
  if (!response) return "";
  if (typeof response.text === "function") {
    try {
      return String(await response.text());
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (typeof response.text === "string") return response.text;
  if (typeof response.body === "string") return response.body;
  if (typeof response.content === "string") return response.content;
  if (Buffer.isBuffer(response.content)) return response.content.toString("utf8");
  if (response.content instanceof Uint8Array) return Buffer.from(response.content).toString("utf8");
  return String(response.statusText ?? "");
}

async function responseJson(response: any): Promise<Record<string, any>> {
  const value = typeof response?.json === "function" ? await response.json() : response;
  return value && typeof value === "object" ? value : {};
}

async function assertOk(response: any, label: string): Promise<void> {
  const status = statusCode(response);
  if (status >= 400 || response?.ok === false) {
    const detail = (await responseText(response)).slice(0, 500) || `HTTP ${status}`;
    throw new ImageGenerationError(
      `${label} image generation failed: ${detail}`,
    );
  }
}

async function bufferFromResponse(response: any): Promise<Buffer> {
  if (Buffer.isBuffer(response?.content)) return response.content;
  if (response?.content instanceof Uint8Array) return Buffer.from(response.content);
  if (typeof response?.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer());
  if (typeof response?.body === "string") return Buffer.from(response.body);
  return Buffer.alloc(0);
}

function safeSummaryValue(value: any): any {
  if (value == null) return undefined;
  if (typeof value === "string") return value.slice(0, 300);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 3).map((item) => safeSummaryValue(item));
  if (typeof value !== "object") return String(value).slice(0, 300);
  const out: Record<string, any> = {};
  for (const [key, child] of Object.entries(value).slice(0, 8)) {
    if (/authorization|api.?key|token|secret|password/i.test(key)) out[key] = "[redacted]";
    else out[key] = safeSummaryValue(child);
  }
  return out;
}

function emptyImagePayloadSummary(data: Record<string, any>): string {
  if (!data || typeof data !== "object") return "";
  const summary: Record<string, any> = {};
  for (const key of ["error", "code", "message", "request_id", "requestId", "id"]) {
    const value = data[key];
    if (value !== undefined) summary[key] = safeSummaryValue(value);
  }
  const output = data.output;
  if (output && typeof output === "object") {
    for (const key of ["code", "message", "request_id", "requestId"]) {
      const value = output[key];
      if (value !== undefined) summary[`output.${key}`] = safeSummaryValue(value);
    }
  }
  if (!Object.keys(summary).length) summary.keys = Object.keys(data).slice(0, 12);
  return JSON.stringify(summary);
}

export abstract class ImageGenerationProvider {
  static providerName = "";
  providerName = "";
  missingKeyMessage = "";
  apiKey: string | null;
  apiBase: string;
  extraHeaders: Record<string, string>;
  extraBody: Record<string, any>;
  timeout: number;
  client: any;

  constructor({
    apiKey,
    apiBase,
    extraHeaders,
    extraBody,
    timeout,
    client,
  }: {
    apiKey?: string | null;
    apiBase?: string | null;
    extraHeaders?: Record<string, string> | null;
    extraBody?: Record<string, any> | null;
    timeout?: number | null;
    client?: any;
  } = {}) {
    this.apiKey = apiKey ?? null;
    this.apiBase = (apiBase ?? this.defaultBaseUrl()).replace(/\/+$/, "");
    this.extraHeaders = extraHeaders ?? {};
    this.extraBody = extraBody ?? {};
    this.timeout = timeout ?? 120;
    this.client = client;
  }

  defaultBaseUrl(): string {
    return "";
  }

  async httpPost(
    url: string,
    headers: Record<string, string>,
    body: Record<string, any>,
  ): Promise<any> {
    if (this.client?.post) return this.client.post(url, { headers, json: body });
    return fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });
  }

  async httpGet(url: string): Promise<any> {
    if (this.client?.get) return this.client.get(url);
    return fetch(url, { signal: AbortSignal.timeout(this.timeout * 1000) });
  }

  requireImages(images: string[], data: Record<string, any>): void {
    if (images.length) return;
    const providerSummary = emptyImagePayloadSummary(data);
    throw new ImageGenerationError(
      `${this.providerName} returned no images${providerSummary ? `: ${providerSummary}` : ""}`,
    );
  }

  abstract generate(args: {
    prompt: string;
    model: string;
    referenceImages?: string[] | null;
    aspectRatio?: string | null;
    imageSize?: string | null;
  }): Promise<GeneratedImageResponse>;
}

export type ImageGenerationAuthStrategy = "api_key" | "bedrock" | "codex_oauth" | "optional";

type ProviderClass = (new (init?: any) => ImageGenerationProvider) & {
  providerName: string;
  displayName?: string;
  authStrategy?: ImageGenerationAuthStrategy;
};
const IMAGE_GEN_PROVIDERS = new Map<string, ProviderClass>();

export function registerImageGenProvider(cls: ProviderClass): void {
  const name = (cls as any).providerName;
  if (!name) throw new Error(`${cls.name} must set providerName`);
  IMAGE_GEN_PROVIDERS.set(name, cls);
}

export function getImageGenProvider(name: string): ProviderClass | null {
  return IMAGE_GEN_PROVIDERS.get(name) ?? null;
}

export function imageGenProviderNames(): string[] {
  return [...IMAGE_GEN_PROVIDERS.keys()];
}

export function imageGenProviderDefaultBase(name: string): string | null {
  const cls = getImageGenProvider(name);
  if (!cls) return null;
  const base = new cls().defaultBaseUrl();
  return base || null;
}

export function imageGenProviderLabel(name: string): string {
  const cls = getImageGenProvider(name);
  return cls?.displayName ?? name;
}

export function imageGenProviderAuthStrategy(name: string): ImageGenerationAuthStrategy {
  return getImageGenProvider(name)?.authStrategy ?? "api_key";
}

export function imageGenProviderConfigured(name: string, config: Record<string, any>): boolean {
  const strategy = imageGenProviderAuthStrategy(name);
  if (strategy === "optional") return Boolean(config.apiKey || config.apiBase || imageGenProviderDefaultBase(name));
  if (strategy === "bedrock") return bedrockConfigured(config);
  if (strategy === "codex_oauth") return codexConfigured(config);
  return Boolean(config.apiKey);
}

function bedrockConfigured(config: Record<string, any>): boolean {
  const extraBody = config.extraBody ?? {};
  return Boolean(
    config.apiKey ||
      extraBody.region ||
      extraBody.profile ||
      process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_PROFILE ||
      process.env.AWS_REGION ||
      process.env.AWS_DEFAULT_REGION,
  );
}

function codexConfigured(config: Record<string, any>): boolean {
  const stored = getCodexStorage().load();
  const access =
    config.apiKey ||
    stored?.access ||
    stored?.accessToken ||
    process.env.OPENAI_CODEX_ACCESS_TOKEN ||
    process.env.CHATGPT_ACCESS_TOKEN;
  const accountId =
    config.extraBody?.account_id ||
    config.extraBody?.accountId ||
    stored?.account_id ||
    stored?.accountId ||
    process.env.OPENAI_CODEX_ACCOUNT_ID ||
    process.env.CHATGPT_ACCOUNT_ID;
  return Boolean(access && accountId);
}

export class OpenRouterImageGenerationClient extends ImageGenerationProvider {
  static providerName = "openrouter";
  static displayName = "OpenRouter";
  providerName = "openrouter";
  missingKeyMessage = "OpenRouter API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://openrouter.ai/api/v1";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const refs = args.referenceImages ?? [];
    const content = refs.length
      ? [
          { type: "text", text: args.prompt },
          ...refs.map((ref: string) => ({
            type: "image_url",
            image_url: { url: imagePathToDataUrl(ref) },
          })),
        ]
      : args.prompt;
    const imageConfig: Record<string, string> = {};
    const aspectRatio = args.aspectRatio;
    const imageSize = args.imageSize;
    if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
    if (imageSize) imageConfig.image_size = imageSize;
    const body = {
      model: args.model,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
      stream: false,
      ...(Object.keys(imageConfig).length ? { image_config: imageConfig } : {}),
      ...this.extraBody,
    };
    const response = await this.httpPost(
      `${this.apiBase}/chat/completions`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...OPENROUTER_ATTRIBUTION_HEADERS,
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "OpenRouter");
    const data = await responseJson(response);
    const images: string[] = [];
    const textParts: string[] = [];
    for (const choice of data.choices ?? []) {
      const message = choice?.message ?? {};
      if (typeof message.content === "string") textParts.push(message.content);
      for (const image of message.images ?? []) {
        const value = image?.image_url?.url ?? image?.imageUrl?.url;
        if (typeof value === "string" && value.startsWith("data:image/")) images.push(value);
      }
    }
    this.requireImages(images, data);
    return new GeneratedImageResponse({
      images,
      content: textParts.filter(Boolean).join("\n").trim(),
      raw: data,
    });
  }
}

async function downloadImageDataUrl(
  provider: ImageGenerationProvider,
  url: string,
): Promise<string> {
  const response = await provider.httpGet(url);
  await assertOk(response, "Image download");
  const raw = await bufferFromResponse(response);
  const mime = detectImageMime(raw);
  if (!mime) throw new ImageGenerationError("generated image URL did not return a supported image");
  return `data:${mime};base64,${raw.toString("base64")}`;
}

async function aihubmixImagesFromPayload(
  provider: ImageGenerationProvider,
  payload: Record<string, any>,
): Promise<string[]> {
  const out: string[] = [];
  const collect = async (value: any): Promise<void> => {
    if (!value) return;
    if (typeof value === "string") {
      if (value.startsWith("data:image/")) out.push(value);
      else if (/^https?:\/\//.test(value)) out.push(await downloadImageDataUrl(provider, value));
      else out.push(b64ImageDataUrl(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) await collect(item);
      return;
    }
    if (typeof value === "object") {
      await collect(value.b64_json);
      await collect(value.bytesBase64 ?? value.bytes_base64 ?? value.base64);
      const imageUrl = value.image_url ?? value.imageUrl;
      await collect(typeof imageUrl === "object" ? imageUrl?.url : imageUrl);
      await collect(value.url);
      await collect(value.images);
      await collect(value.image);
      await collect(value.output);
    }
  };
  await collect(payload.output);
  await collect(payload.data);
  return out;
}

export class AIHubMixImageGenerationClient extends ImageGenerationProvider {
  static providerName = "aihubmix";
  static displayName = "AIHubMix";
  providerName = "aihubmix";
  missingKeyMessage = "AIHubMix API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://aihubmix.com/v1";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const refs = args.referenceImages ?? [];
    const imageRefs = refs.map((ref: string) => imagePathToDataUrl(ref));
    const input: Record<string, any> = {
      prompt: args.prompt,
      n: 1,
      size: aihubmixSize(args.aspectRatio, args.imageSize),
      ...this.extraBody,
    };
    if (imageRefs.length === 1) input.image = imageRefs[0];
    else if (imageRefs.length > 1) input.image = imageRefs;
    const response = await this.httpPost(
      `${this.apiBase}/models/${aihubmixModelPath(args.model)}/predictions`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      { input },
    );
    await assertOk(response, "AIHubMix");
    const data = await responseJson(response);
    const images = await aihubmixImagesFromPayload(this, data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

function ollamaImageDataUrl(value: string): string {
  return value.startsWith("data:image/") ? value : b64ImageDataUrl(value);
}

function ollamaImagesFromPayload(payload: Record<string, any>): string[] {
  const out: string[] = [];
  const collect = (value: any): void => {
    if (!value) return;
    if (typeof value === "string") out.push(ollamaImageDataUrl(value));
    else if (Array.isArray(value)) value.forEach(collect);
  };
  collect(payload.image);
  collect(payload.images);
  return out;
}

function dataUrlFromB64(value: string, mime = "image/png"): string {
  return value.startsWith("data:image/")
    ? value
    : `data:${mime};base64,${value.replace(/\s+/g, "")}`;
}

function stepfunSize(aspectRatio?: string | null, imageSize?: string | null): string {
  if (imageSize && imageSize.toLowerCase().includes("x")) return imageSize;
  if (aspectRatio && STEPFUN_ASPECT_RATIO_SIZES[aspectRatio])
    return STEPFUN_ASPECT_RATIO_SIZES[aspectRatio];
  return "1024x1024";
}

function zhipuSize(aspectRatio?: string | null, imageSize?: string | null): string {
  if (imageSize && imageSize.toLowerCase().includes("x")) return imageSize;
  if (aspectRatio && ZHIPU_ASPECT_RATIO_SIZES[aspectRatio])
    return ZHIPU_ASPECT_RATIO_SIZES[aspectRatio];
  return "1280x1280";
}

function qwenSize(
  model?: string | null,
  aspectRatio?: string | null,
  imageSize?: string | null,
): string {
  const explicit = imageSize?.match(/^\s*(\d+)\s*[x*]\s*(\d+)\s*$/i);
  if (explicit) return `${explicit[1]}*${explicit[2]}`;
  const normalizedModel = String(model ?? "").toLowerCase();
  const sizes = normalizedModel.startsWith("qwen-image-2.0")
    ? QWEN_IMAGE_2_ASPECT_RATIO_SIZES
    : QWEN_ASPECT_RATIO_SIZES;
  if (aspectRatio && sizes[aspectRatio]) return sizes[aspectRatio];
  return sizes["1:1"];
}

function qianfanSize(aspectRatio?: string | null, imageSize?: string | null): string {
  const explicit = imageSize?.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
  if (explicit) return `${explicit[1]}x${explicit[2]}`;
  if (aspectRatio && QIANFAN_ASPECT_RATIO_SIZES[aspectRatio])
    return QIANFAN_ASPECT_RATIO_SIZES[aspectRatio];
  return "1024x1024";
}

function bedrockNovaDimensions(
  aspectRatio?: string | null,
  imageSize?: string | null,
): [number, number] {
  const explicit = imageSize?.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/i);
  if (explicit) return [Number(explicit[1]), Number(explicit[2])];
  if (aspectRatio && BEDROCK_NOVA_DIMENSIONS[aspectRatio])
    return BEDROCK_NOVA_DIMENSIONS[aspectRatio];
  return [1024, 1024];
}

function openaiCleanModel(model: string): string {
  return model.replace(/^(openai|openai_codex)\//, "");
}

function openaiIsGptImageModel(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith("gpt-image") || normalized.startsWith("chatgpt-image");
}

function openaiSizeOptions(model: string): [Record<string, string>, Set<string> | null] {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("dall-e-2"))
    return [OPENAI_DALLE2_ASPECT_RATIO_SIZES, OPENAI_DALLE2_SUPPORTED_SIZES];
  if (normalized.startsWith("dall-e-3"))
    return [OPENAI_DALLE3_ASPECT_RATIO_SIZES, OPENAI_DALLE3_SUPPORTED_SIZES];
  if (normalized.startsWith("gpt-image-2")) return [OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES, null];
  return [OPENAI_GPT_IMAGE_ASPECT_RATIO_SIZES, OPENAI_GPT_IMAGE_SUPPORTED_SIZES];
}

function normalizeOpenAIImageSize(imageSize?: string | null): string | null {
  const normalized = imageSize?.trim().toLowerCase();
  return normalized || null;
}

function openaiExplicitSizeSupported(size: string, supported: Set<string> | null): boolean {
  if (supported) return supported.has(size);
  return /^\d+x\d+$/.test(size);
}

function openaiSize(model: string, aspectRatio?: string | null, imageSize?: string | null): string {
  const [sizes, supported] = openaiSizeOptions(model);
  const explicit = normalizeOpenAIImageSize(imageSize);
  if (explicit && openaiExplicitSizeSupported(explicit, supported)) return explicit;
  if (aspectRatio && sizes[aspectRatio]) return sizes[aspectRatio];
  return "1024x1024";
}

async function imagesFromDataItems(
  provider: ImageGenerationProvider,
  payload: Record<string, any>,
): Promise<string[]> {
  const images: string[] = [];
  for (const item of payload.data ?? []) {
    const value = item?.b64_json ?? item?.url ?? item?.image_url;
    if (!value) continue;
    if (typeof value === "string" && /^https?:\/\//.test(value))
      images.push(await downloadImageDataUrl(provider, value));
    else if (typeof value === "string")
      images.push(value.startsWith("data:image/") ? value : b64ImageDataUrl(value));
  }
  return images;
}

async function dashscopeImagesFromPayload(
  provider: ImageGenerationProvider,
  payload: Record<string, any>,
): Promise<string[]> {
  const images: string[] = [];
  const collect = async (value: any): Promise<void> => {
    if (!value) return;
    if (typeof value === "string") {
      if (value.startsWith("data:image/")) images.push(value);
      else if (/^https?:\/\//.test(value)) images.push(await downloadImageDataUrl(provider, value));
      else images.push(b64ImageDataUrl(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) await collect(item);
      return;
    }
    if (typeof value !== "object") return;
    await collect(value.image);
    const imageUrl = value.image_url ?? value.imageUrl;
    await collect(typeof imageUrl === "object" ? imageUrl?.url : imageUrl);
    await collect(value.url);
    await collect(value.base64);
    await collect(value.b64_json);
    await collect(value.image_base64);
  };

  for (const choice of payload.output?.choices ?? []) {
    await collect(choice?.message?.content);
  }
  await collect(payload.output?.images);
  await collect(payload.data);
  return images;
}

export class OllamaImageGenerationClient extends ImageGenerationProvider {
  static providerName = "ollama";
  static displayName = "Ollama";
  static authStrategy: ImageGenerationAuthStrategy = "optional";
  providerName = "ollama";

  override defaultBaseUrl(): string {
    return "http://localhost:11434/api";
  }

  constructor(init: any = {}) {
    super(init);
    if (init.apiBase?.replace(/\/+$/, "").endsWith("/v1")) {
      this.apiBase = init.apiBase.replace(/\/v1\/?$/, "/api");
    }
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    const refs = args.referenceImages ?? [];
    if (refs.length)
      throw new ImageGenerationError("Ollama image generation does not support reference images");
    const [width, height] = ollamaDimensions(args.aspectRatio, args.imageSize);
    const body = {
      model: args.model,
      prompt: args.prompt,
      width,
      height,
      steps: 0,
      ...this.extraBody,
      stream: false,
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const response = await this.httpPost(`${this.apiBase}/generate`, headers, body);
    await assertOk(response, "Ollama");
    const data = await responseJson(response);
    const images = ollamaImagesFromPayload(data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({
      images,
      content: typeof data.response === "string" ? data.response : "",
      raw: data,
    });
  }
}

export class ZhipuImageGenerationClient extends ImageGenerationProvider {
  static providerName = "zhipu";
  static displayName = "Zhipu";
  providerName = "zhipu";
  missingKeyMessage = "Zhipu API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://open.bigmodel.cn/api/paas/v4";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const refs = args.referenceImages ?? [];
    if (refs.length)
      throw new ImageGenerationError("Zhipu image generation does not support reference images");
    const body = {
      model: args.model,
      prompt: args.prompt,
      size: zhipuSize(args.aspectRatio, args.imageSize),
      ...this.extraBody,
    };
    const response = await this.httpPost(
      `${this.apiBase}/images/generations`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Zhipu");
    const data = await responseJson(response);
    const images = await imagesFromDataItems(this, data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class GeminiImageGenerationClient extends ImageGenerationProvider {
  static providerName = "gemini";
  static displayName = "Gemini";
  providerName = "gemini";
  missingKeyMessage = "Gemini API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://generativelanguage.googleapis.com/v1beta";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const model = args.model;
    if (String(model).toLowerCase().includes("imagen")) return this.generateImagen(args);
    return this.generateFlash(args);
  }

  private async generateImagen(args: any): Promise<GeneratedImageResponse> {
    const parameters: Record<string, any> = { sampleCount: 1 };
    const aspectRatio = args.aspectRatio;
    if (GEMINI_IMAGEN_ASPECT_RATIOS.has(aspectRatio)) parameters.aspectRatio = aspectRatio;
    const body = {
      instances: [{ prompt: args.prompt }],
      parameters: { ...parameters, ...this.extraBody },
    };
    const response = await this.httpPost(
      `${this.apiBase}/models/${args.model}:predict`,
      {
        "x-goog-api-key": this.apiKey ?? "",
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Gemini Imagen");
    const data = await responseJson(response);
    const images = (data.predictions ?? [])
      .map((item: any) =>
        item?.bytesBase64Encoded
          ? dataUrlFromB64(item.bytesBase64Encoded, item.mimeType ?? "image/png")
          : null,
      )
      .filter(Boolean);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }

  private async generateFlash(args: any): Promise<GeneratedImageResponse> {
    const refs = args.referenceImages ?? [];
    const parts = refs.map((ref: string) => ({ inlineData: imagePathToInlineData(ref) }));
    parts.push({ text: args.prompt });
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      ...this.extraBody,
    };
    const response = await this.httpPost(
      `${this.apiBase}/models/${args.model}:generateContent`,
      {
        "x-goog-api-key": this.apiKey ?? "",
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Gemini");
    const data = await responseJson(response);
    const images: string[] = [];
    const textParts: string[] = [];
    for (const candidate of data.candidates ?? []) {
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part?.text === "string") textParts.push(part.text);
        const inline = part?.inlineData ?? part?.inline_data;
        if (inline?.data)
          images.push(
            dataUrlFromB64(inline.data, inline.mimeType ?? inline.mime_type ?? "image/png"),
          );
      }
    }
    this.requireImages(images, data);
    return new GeneratedImageResponse({
      images,
      content: textParts.filter(Boolean).join("\n").trim(),
      raw: data,
    });
  }
}

export class OpenAIImagesCompatibleImageGenerationClient extends ImageGenerationProvider {
  static displayName = "OpenAI Images";
  missingKeyMessage = "Image generation API key is not configured. Set tools.imageGeneration.apiKey.";
  missingBaseMessage =
    "Image generation API base is not configured. Set tools.imageGeneration.apiBase.";

  endpointPath(): string {
    return "/images/generations";
  }

  requestLabel(): string {
    return this.providerName || "OpenAI-compatible";
  }

  requestModel(model: string): string {
    return model;
  }

  requestSize(model: string, aspectRatio?: string | null, imageSize?: string | null): string {
    return openaiSize(model, aspectRatio, imageSize);
  }

  requestBody(args: any): Record<string, any> {
    const model = this.requestModel(args.model);
    const body: Record<string, any> = {
      model,
      prompt: args.prompt,
      size: this.requestSize(model, args.aspectRatio, args.imageSize),
      n: 1,
      response_format: "b64_json",
      ...this.extraBody,
    };
    if (openaiIsGptImageModel(model)) {
      delete body.response_format;
      delete body.n;
    }
    return body;
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    if (!this.apiBase) throw new ImageGenerationError(this.missingBaseMessage);
    const response = await this.httpPost(
      `${this.apiBase}${this.endpointPath()}`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      this.requestBody(args),
    );
    await assertOk(response, this.requestLabel());
    const data = await responseJson(response);
    const images = await imagesFromDataItems(this, data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class OpenAIImageGenerationClient extends OpenAIImagesCompatibleImageGenerationClient {
  static providerName = "openai";
  static override displayName = "OpenAI";
  override providerName = "openai";
  override missingKeyMessage =
    "OpenAI API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://api.openai.com/v1";
  }

  override requestModel(model: string): string {
    return openaiCleanModel(model);
  }

  override requestLabel(): string {
    return "OpenAI";
  }
}

export class CustomImageGenerationClient extends OpenAIImagesCompatibleImageGenerationClient {
  static providerName = "custom";
  static override displayName = "Custom";
  override providerName = "custom";
  override missingKeyMessage =
    "Custom image generation API key is not configured. Set tools.imageGeneration.apiKey.";
  override missingBaseMessage =
    "Custom image generation API base is not configured. Set tools.imageGeneration.apiBase.";

  override requestLabel(): string {
    return "Custom";
  }
}

export class MemmyAccountImageGenerationClient extends ImageGenerationProvider {
  static providerName = "memmy_account";
  static displayName = "Memmy Account";
  providerName = "memmy_account";
  missingKeyMessage =
    "Memmy Account image generation API key is not configured. Set tools.imageGeneration.apiKey.";
  missingBaseMessage =
    "Memmy Account image generation API base is not configured. Set tools.imageGeneration.apiBase.";

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    if (!this.apiBase) throw new ImageGenerationError(this.missingBaseMessage);
    const refs = args.referenceImages ?? [];
    if (refs.length)
      throw new ImageGenerationError(
        "Memmy Account image generation does not support reference images",
      );
    const parameters: Record<string, any> = {
      size: qwenSize(args.model, args.aspectRatio, args.imageSize),
      n: 1,
      watermark: false,
      ...this.extraBody,
    };
    if (args.negativePrompt) parameters.negative_prompt = args.negativePrompt;
    const body = {
      model: args.model,
      input: { messages: [{ role: "user", content: [{ text: args.prompt }] }] },
      parameters,
    };
    const response = await this.httpPost(
      `${this.apiBase}/chat/completions`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Memmy Account");
    const data = await responseJson(response);
    const images = await dashscopeImagesFromPayload(this, data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class VolcEngineImageGenerationClient extends OpenAIImagesCompatibleImageGenerationClient {
  static providerName = "volcengine";
  static override displayName = "VolcEngine";
  override providerName = "volcengine";
  override missingKeyMessage =
    "VolcEngine API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://ark.cn-beijing.volces.com/api/v3";
  }

  override requestLabel(): string {
    return "VolcEngine";
  }
}

export class BytePlusImageGenerationClient extends OpenAIImagesCompatibleImageGenerationClient {
  static providerName = "byteplus";
  static override displayName = "BytePlus";
  override providerName = "byteplus";
  override missingKeyMessage =
    "BytePlus API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://ark.ap-southeast.bytepluses.com/api/v3";
  }

  override requestLabel(): string {
    return "BytePlus";
  }
}

export class NvidiaImageGenerationClient extends OpenAIImagesCompatibleImageGenerationClient {
  static providerName = "nvidia";
  static override displayName = "NVIDIA";
  override providerName = "nvidia";
  override missingKeyMessage =
    "NVIDIA API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://integrate.api.nvidia.com/v1";
  }

  override requestLabel(): string {
    return "NVIDIA";
  }
}

export class MiniMaxImageGenerationClient extends ImageGenerationProvider {
  static providerName = "minimax";
  static displayName = "MiniMax";
  providerName = "minimax";
  missingKeyMessage = "MiniMax API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://api.minimaxi.com/v1";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const refs = args.referenceImages ?? [];
    const aspectRatio = args.aspectRatio;
    const body: Record<string, any> = {
      model: args.model,
      prompt: args.prompt,
      response_format: "base64",
      aspect_ratio: MINIMAX_ASPECT_RATIO_SIZES.has(aspectRatio) ? aspectRatio : "1:1",
      ...this.extraBody,
    };
    if (refs.length)
      body.subject_reference = refs.map((ref: string) => ({
        type: "character",
        image_file: imagePathToDataUrl(ref),
      }));
    const response = await this.httpPost(
      `${this.apiBase}/image_generation`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "MiniMax");
    const data = await responseJson(response);
    const images = (data.data?.image_base64 ?? []).map((b64: string) => b64ImageDataUrl(b64));
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class StepFunImageGenerationClient extends ImageGenerationProvider {
  static providerName = "stepfun";
  static displayName = "StepFun";
  providerName = "stepfun";
  missingKeyMessage = "StepFun API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://api.stepfun.com/v1";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const refs = args.referenceImages ?? [];
    const body: Record<string, any> = {
      model: args.model,
      prompt: args.prompt,
      response_format: "b64_json",
      n: 1,
      size: stepfunSize(args.aspectRatio, args.imageSize),
      ...this.extraBody,
    };
    if (refs.length && String(args.model).includes("1x"))
      body.style_reference = { source_url: imagePathToDataUrl(refs[0]) };
    const response = await this.httpPost(
      `${this.apiBase}/images/generations`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "StepFun");
    const data = await responseJson(response);
    const images = (data.data ?? [])
      .map((item: any) => item?.b64_json)
      .filter(Boolean)
      .map((b64: string) => b64ImageDataUrl(b64));
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

function codexImageResult(result: any, images: string[]): void {
  if (!result) return;
  if (typeof result === "string") {
    images.push(result.startsWith("data:image/") ? result : b64ImageDataUrl(result));
    return;
  }
  if (Array.isArray(result)) {
    for (const item of result) codexImageResult(item, images);
    return;
  }
  if (typeof result !== "object") return;
  const imageUrl = result.image_url ?? result.imageUrl;
  codexImageResult(typeof imageUrl === "object" ? imageUrl?.url : imageUrl, images);
  codexImageResult(result.image ?? result.url ?? result.b64_json, images);
}

function collectCodexImagesFromOutput(output: any, images: string[]): void {
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "image_generation_call") codexImageResult(item.result, images);
  }
}

function collectCodexSseEvent(
  event: Record<string, any>,
  images: string[],
  textParts: string[],
): void {
  if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
    textParts.push(event.delta);
  }
  if (event.type === "response.output_item.done") {
    const item = event.item ?? {};
    if (item.type === "image_generation_call") codexImageResult(item.result, images);
  }
  collectCodexImagesFromOutput(event.output, images);
  collectCodexImagesFromOutput(event.response?.output, images);
}

async function responseLines(response: any): Promise<string[]> {
  if (typeof response?.iterLines === "function") {
    const lines: string[] = [];
    for await (const line of response.iterLines()) lines.push(String(line));
    return lines;
  }
  const text =
    typeof response?.text === "string"
      ? response.text
      : typeof response?.text === "function"
        ? await response.text()
        : Buffer.isBuffer(response?.content) && response.content.length
          ? response.content.toString("utf8")
          : String(response?.text ?? response?.body ?? "");
  return text.split(/\r?\n/);
}

async function parseCodexSseImages(response: any): Promise<[string[], string]> {
  const images: string[] = [];
  const textParts: string[] = [];
  const pending: string[] = [];
  let sawSseData = false;

  const flush = (): boolean => {
    const dataLines = pending
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    pending.length = 0;
    if (!dataLines.length) return true;
    sawSseData = true;
    const raw = dataLines.join("");
    if (!raw || raw === "[DONE]") return raw !== "[DONE]";
    try {
      collectCodexSseEvent(JSON.parse(raw), images, textParts);
    } catch {
      return true;
    }
    return true;
  };

  for (const rawLine of await responseLines(response)) {
    const line = rawLine.trim();
    if (!line) {
      if (!flush()) break;
      continue;
    }
    pending.push(line);
  }
  flush();

  if (!sawSseData) {
    try {
      const payload = await responseJson(response);
      collectCodexImagesFromOutput(payload.output, images);
      collectCodexImagesFromOutput(payload.response?.output, images);
    } catch {
      // Some Response implementations can only be read once; the SSE pass above is authoritative.
    }
  }

  return [images, textParts.join("").trim()];
}

export class CodexImageGenerationClient extends ImageGenerationProvider {
  static providerName = "openai_codex";
  static displayName = "OpenAI Codex";
  static authStrategy: ImageGenerationAuthStrategy = "codex_oauth";
  providerName = "openai_codex";
  missingKeyMessage = "Codex OAuth token is not configured.";

  override defaultBaseUrl(): string {
    return "https://chatgpt.com/backend-api";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    const stored = getCodexStorage().load();
    const access =
      this.apiKey ??
      stored?.access ??
      stored?.accessToken ??
      process.env.OPENAI_CODEX_ACCESS_TOKEN ??
      process.env.CHATGPT_ACCESS_TOKEN ??
      null;
    const accountId =
      this.extraBody.account_id ??
      this.extraBody.accountId ??
      stored?.account_id ??
      stored?.accountId ??
      process.env.OPENAI_CODEX_ACCOUNT_ID ??
      process.env.CHATGPT_ACCOUNT_ID ??
      "";
    if (!access || !accountId) throw new ImageGenerationError(this.missingKeyMessage);
    const model = String(args.model).replace(/^(openai-codex|openai_codex)\//, "");
    const body = {
      model,
      instructions: "Generate an image based on the user's request.",
      input: [{ role: "user", content: args.prompt }],
      tools: [{ type: "image_generation" }],
      tool_choice: "auto",
      stream: true,
      store: false,
      ...this.extraBody,
    };
    delete (body as any).account_id;
    delete (body as any).accountId;
    const response = await this.httpPost(
      `${this.apiBase}/codex/responses`,
      {
        Authorization: `Bearer ${access}`,
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental",
        originator: "memmy-agent",
        "User-Agent": "memmy-agent (typescript)",
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Codex");
    const [images, content] = await parseCodexSseImages(response);
    const raw = { status: "completed" };
    this.requireImages(images, raw);
    return new GeneratedImageResponse({ images, content, raw });
  }
}

export class AzureOpenAIImageGenerationClient extends ImageGenerationProvider {
  static providerName = "azure_openai";
  static displayName = "Azure OpenAI";
  providerName = "azure_openai";
  missingKeyMessage = "Azure OpenAI API key is not configured. Set tools.imageGeneration.apiKey.";

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    if (!this.apiBase)
      throw new ImageGenerationError(
        "Azure OpenAI API base is not configured. Set tools.imageGeneration.apiBase.",
      );
    const apiVersion = String(
      this.extraBody.api_version ?? this.extraBody.apiVersion ?? "preview",
    );
    const body: Record<string, any> = {
      model: args.model,
      prompt: args.prompt,
      size: openaiSize(args.model, args.aspectRatio, args.imageSize),
      ...this.extraBody,
    };
    delete body.api_version;
    delete body.apiVersion;
    const response = await this.httpPost(
      `${this.apiBase}/openai/v1/images/generations?api-version=${encodeURIComponent(apiVersion)}`,
      {
        "api-key": this.apiKey,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Azure OpenAI");
    const data = await responseJson(response);
    const images = await imagesFromDataItems(this, data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class BedrockNovaCanvasImageGenerationClient extends ImageGenerationProvider {
  static providerName = "bedrock";
  static displayName = "Bedrock";
  static authStrategy: ImageGenerationAuthStrategy = "bedrock";
  providerName = "bedrock";

  override async generate(args: any): Promise<GeneratedImageResponse> {
    const refs = args.referenceImages ?? [];
    if (refs.length)
      throw new ImageGenerationError("Bedrock image generation does not support reference images");
    const { region, profile, ...extraBody } = this.extraBody;
    const [width, height] = bedrockNovaDimensions(args.aspectRatio, args.imageSize);
    const imageGenerationConfig = {
      numberOfImages: 1,
      width,
      height,
      cfgScale: 6.5,
      ...(extraBody.imageGenerationConfig ?? {}),
    };
    const body = {
      taskType: "TEXT_IMAGE",
      textToImageParams: { text: args.prompt, ...(extraBody.textToImageParams ?? {}) },
      imageGenerationConfig,
      ...extraBody,
    };
    delete (body as any).imageGenerationConfig;
    delete (body as any).textToImageParams;
    body.textToImageParams = { text: args.prompt, ...(extraBody.textToImageParams ?? {}) };
    body.imageGenerationConfig = imageGenerationConfig;

    const client =
      this.client ??
      new BedrockRuntimeClient({
        ...(region ? { region: String(region) } : {}),
        ...(profile ? { credentials: fromIni({ profile: String(profile) }) } : {}),
      });
    const result = await client.send(
      new InvokeModelCommand({
        modelId: args.model,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(body),
      }),
    );
    const rawBody = result?.body ? Buffer.from(result.body).toString("utf8") : "{}";
    const data = rawBody ? JSON.parse(rawBody) : {};
    const images = (data.images ?? [])
      .filter((value: any) => typeof value === "string")
      .map((value: string) => dataUrlFromB64(value, "image/png"));
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class DashScopeImageGenerationClient extends ImageGenerationProvider {
  static providerName = "dashscope";
  static displayName = "DashScope";
  providerName = "dashscope";
  missingKeyMessage = "DashScope API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1";
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const refs = args.referenceImages ?? [];
    if (refs.length)
      throw new ImageGenerationError("DashScope image generation does not support reference images");
    const parameters: Record<string, any> = {
      size: qwenSize(args.model, args.aspectRatio, args.imageSize),
      n: 1,
      watermark: false,
      ...this.extraBody,
    };
    if (args.negativePrompt) parameters.negative_prompt = args.negativePrompt;
    const body = {
      model: args.model,
      input: { messages: [{ role: "user", content: [{ text: args.prompt }] }] },
      parameters,
    };
    const response = await this.httpPost(
      `${this.apiBase}/services/aigc/multimodal-generation/generation`,
      {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "DashScope");
    const data = await responseJson(response);
    const images = await dashscopeImagesFromPayload(this, data);
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

export class QianfanImageGenerationClient extends ImageGenerationProvider {
  static providerName = "qianfan";
  static displayName = "Qianfan";
  providerName = "qianfan";
  missingKeyMessage = "Qianfan API key is not configured. Set tools.imageGeneration.apiKey.";

  override defaultBaseUrl(): string {
    return "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop";
  }

  async postForm(url: string, body: URLSearchParams): Promise<any> {
    if (this.client?.post) {
      return this.client.post(url, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    }
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });
  }

  async accessToken(): Promise<string> {
    if (!this.apiKey) throw new ImageGenerationError(this.missingKeyMessage);
    const secretKey = this.extraBody.secret_key ?? this.extraBody.secretKey;
    if (!secretKey) return this.apiKey;
    const response = await this.postForm(
      "https://aip.baidubce.com/oauth/2.0/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.apiKey,
        client_secret: String(secretKey),
      }),
    );
    await assertOk(response, "Qianfan OAuth");
    const data = await responseJson(response);
    const token = data.access_token ?? data.accessToken;
    if (typeof token !== "string" || !token) {
      throw new ImageGenerationError("Qianfan OAuth did not return access_token");
    }
    return token;
  }

  override async generate(args: any): Promise<GeneratedImageResponse> {
    const accessToken = await this.accessToken();
    const {
      secret_key,
      secretKey,
      access_token,
      accessToken: accessTokenField,
      ...extraBody
    } = this.extraBody;
    void secret_key;
    void secretKey;
    void access_token;
    void accessTokenField;
    const body = {
      prompt: args.prompt,
      size: qianfanSize(args.aspectRatio, args.imageSize),
      n: 1,
      steps: 20,
      ...extraBody,
    };
    const response = await this.httpPost(
      `${this.apiBase}/text2image/${encodeURIComponent(args.model)}?access_token=${encodeURIComponent(accessToken)}`,
      {
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body,
    );
    await assertOk(response, "Qianfan");
    const data = await responseJson(response);
    const images = (data.data ?? [])
      .map((item: any) => item?.b64_image)
      .filter((value: any) => typeof value === "string")
      .map((value: string) => dataUrlFromB64(value, "image/png"));
    this.requireImages(images, data);
    return new GeneratedImageResponse({ images, content: "", raw: data });
  }
}

for (const cls of [
  OpenAIImageGenerationClient,
  CustomImageGenerationClient,
  MemmyAccountImageGenerationClient,
  AzureOpenAIImageGenerationClient,
  BedrockNovaCanvasImageGenerationClient,
  OpenRouterImageGenerationClient,
  AIHubMixImageGenerationClient,
  OllamaImageGenerationClient,
  GeminiImageGenerationClient,
  MiniMaxImageGenerationClient,
  StepFunImageGenerationClient,
  ZhipuImageGenerationClient,
  CodexImageGenerationClient,
  VolcEngineImageGenerationClient,
  BytePlusImageGenerationClient,
  DashScopeImageGenerationClient,
  QianfanImageGenerationClient,
  NvidiaImageGenerationClient,
]) {
  registerImageGenProvider(cls);
}
