import fs from "node:fs";
import path from "node:path";
import { Tool } from "./base.js";
import { getMediaDir } from "../../../config/paths.js";
import { ImageGenerationToolConfig } from "../../../config/schema.js";
import {
  ImageGenerationError,
  ImageGenerationProvider,
  getImageGenProvider,
  imageGenProviderConfigured,
} from "../../../providers/image-generation.js";
import {
  ArtifactError,
  generatedImageToolResult,
  storeGeneratedImageArtifact,
} from "../../../utils/artifacts.js";
import { detectImageMime } from "../../../utils/helpers.js";

function isRelativeTo(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathIfExists(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export { ImageGenerationToolConfig };

export class ImageGenerationTool extends Tool {
  static configKey = "imageGeneration";

  workspace: string;
  config: ImageGenerationToolConfig;
  private generatedImagesThisTurn = 0;

  static configCls(): typeof ImageGenerationToolConfig {
    return ImageGenerationToolConfig;
  }

  static enabled(ctx: any): boolean {
    const cfg = ctx?.config?.imageGeneration ?? ctx?.config?.tools?.imageGeneration;
    if (!cfg?.enabled) return false;
    const config = cfg instanceof ImageGenerationToolConfig ? cfg : new ImageGenerationToolConfig(cfg);
    if (!config.profileMode) return true;
    if (!config.hasCompleteEffectiveProfile()) return false;
    const effective = config.effectiveImageGenerationConfig();
    return imageGenProviderConfigured(effective.provider, effective as any);
  }

  static create(ctx: any): Tool {
    const rawConfig = ctx?.config?.imageGeneration ?? new ImageGenerationToolConfig();
    const parsedConfig =
      rawConfig instanceof ImageGenerationToolConfig ? rawConfig : new ImageGenerationToolConfig(rawConfig);
    const config = parsedConfig.profileMode ? parsedConfig.effectiveImageGenerationConfig() : parsedConfig;
    return new ImageGenerationTool({
      workspace: ctx?.workspace ?? process.cwd(),
      config,
    });
  }

  constructor({
    workspace = process.cwd(),
    config = new ImageGenerationToolConfig(),
  }: {
    workspace?: string;
    config?: ImageGenerationToolConfig;
  } = {}) {
    super();
    this.workspace = path.resolve(workspace);
    this.config =
      config instanceof ImageGenerationToolConfig ? config : new ImageGenerationToolConfig(config);
  }

  get name(): string {
    return "generate_image";
  }

  get description(): string {
    return "Generate or edit images and store them as persistent artifacts. Returns artifact ids and local paths.";
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1 },
        reference_images: { type: "array", items: { type: "string" } },
        referenceImages: { type: "array", items: { type: "string" } },
        aspect_ratio: { type: "string" },
        aspectRatio: { type: "string" },
        image_size: { type: "string" },
        imageSize: { type: "string" },
        count: { type: "integer", minimum: 1, maximum: 8 },
      },
      required: ["prompt"],
    };
  }

  providerClient(): ImageGenerationProvider | null {
    const cls = getImageGenProvider(this.config.provider);
    if (!cls) return null;
    return new cls({
      apiKey: this.config.apiKey || null,
      apiBase: this.config.apiBase || null,
      extraHeaders: this.config.extraHeaders,
      extraBody: this.config.extraBody,
    });
  }

  resolveReferenceImage(value: string): string {
    const raw = value.startsWith("~") ? path.join(process.env.HOME ?? "", value.slice(1)) : value;
    const candidate = path.isAbsolute(raw) ? raw : path.join(this.workspace, raw);
    const resolved = fs.realpathSync(candidate);
    const allowedRoots = [this.workspace, getMediaDir()].map((root) => realpathIfExists(root));
    if (!allowedRoots.some((root) => isRelativeTo(resolved, root))) {
      throw new ImageGenerationError(
        "reference_images must be inside the workspace or memmy-agent media directory",
      );
    }
    if (!fs.statSync(resolved).isFile())
      throw new ImageGenerationError(`reference image is not a file: ${value}`);
    const mime = detectImageMime(fs.readFileSync(resolved));
    if (!mime) throw new ImageGenerationError(`unsupported reference image: ${value}`);
    return resolved;
  }

  resolveReferenceImages(values?: string[] | null): string[] {
    return (values ?? []).filter(Boolean).map((value) => this.resolveReferenceImage(value));
  }

  async execute(
    params: {
      prompt?: string;
      reference_images?: string[];
      referenceImages?: string[];
      aspect_ratio?: string | null;
      aspectRatio?: string | null;
      image_size?: string | null;
      imageSize?: string | null;
      count?: number | null;
    } = {},
  ): Promise<string> {
    if (!params.prompt) return "Error: missing prompt";
    if (!this.config.model.trim()) return "Error: tools.imageGeneration.model is required";
    const client = this.providerClient();
    if (!client) return `Error: unsupported image generation provider '${this.config.provider}'`;
    const requested = params.count ?? 1;
    const max = this.config.maxImagesPerTurn;
    if (max !== null) {
      const remaining = max - this.generatedImagesThisTurn;
      if (remaining <= 0) {
        return `Error: image generation quota is exhausted for this turn (${this.generatedImagesThisTurn}/${max} images generated).`;
      }
      if (requested > remaining) {
        return `Error: count ${requested} exceeds the remaining image quota for this turn (${remaining} remaining of ${max}).`;
      }
    }
    try {
      const refs = this.resolveReferenceImages(
        params.reference_images ?? params.referenceImages ?? [],
      );
      const artifacts: Record<string, any>[] = [];
      while (artifacts.length < requested) {
        const response = await client.generate({
          prompt: params.prompt,
          model: this.config.model,
          referenceImages: refs,
          aspectRatio: params.aspect_ratio ?? params.aspectRatio ?? this.config.defaultAspectRatio,
          imageSize: params.image_size ?? params.imageSize ?? this.config.defaultImageSize,
        });
        for (const imageDataUrl of response.images) {
          const artifact = storeGeneratedImageArtifact(imageDataUrl, {
            prompt: params.prompt,
            model: this.config.model,
            sourceImages: refs,
            saveDir: this.config.saveDir,
            provider: this.config.provider,
          });
          artifacts.push(artifact);
          this.generatedImagesThisTurn += 1;
          if (artifacts.length >= requested) break;
        }
      }
      return generatedImageToolResult(artifacts);
    } catch (error) {
      if (
        error instanceof ArtifactError ||
        error instanceof ImageGenerationError ||
        error instanceof Error
      ) {
        return `Error: ${error.message}`;
      }
      return `Error: ${String(error)}`;
    }
  }
}
