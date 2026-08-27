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
import type { ResolvedModelSelection } from "../../../providers/model-catalog.js";

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
  modelSelection: ResolvedModelSelection | null;
  private readonly catalogSelectionRequired: boolean;
  private generatedImagesThisTurn = 0;

  static configCls(): typeof ImageGenerationToolConfig {
    return ImageGenerationToolConfig;
  }

  static enabled(ctx: any): boolean {
    const cfg = ctx?.config?.imageGeneration ?? ctx?.config?.tools?.imageGeneration;
    if (!cfg?.enabled) return false;
    if (ctx?.modelSelectionResolver) {
      try {
        return Boolean(ctx.modelSelectionResolver({ capability: "image_generation" }));
      } catch {
        return false;
      }
    }
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
    const catalogSelectionRequired = typeof ctx?.modelSelectionResolver === "function";
    const modelSelection = ctx?.modelSelectionResolver?.({ capability: "image_generation" }) ?? null;
    return new ImageGenerationTool({
      workspace: ctx?.workspace ?? process.cwd(),
      config,
      modelSelection,
      catalogSelectionRequired,
    });
  }

  constructor({
    workspace = process.cwd(),
    config = new ImageGenerationToolConfig(),
    modelSelection = null,
    catalogSelectionRequired = false,
  }: {
    workspace?: string;
    config?: ImageGenerationToolConfig;
    modelSelection?: ResolvedModelSelection | null;
    catalogSelectionRequired?: boolean;
  } = {}) {
    super();
    this.workspace = path.resolve(workspace);
    this.config =
      config instanceof ImageGenerationToolConfig ? config : new ImageGenerationToolConfig(config);
    this.modelSelection = modelSelection;
    this.catalogSelectionRequired = catalogSelectionRequired;
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
    const provider = this.modelSelection?.provider ?? this.config.provider;
    const providerConfig = this.modelSelection?.providerConfig;
    const cls = getImageGenProvider(provider);
    if (!cls) return null;
    return new cls({
      apiKey: (providerConfig?.apiKey ?? this.config.apiKey) || null,
      apiBase: (providerConfig?.apiBase ?? this.config.apiBase) || null,
      extraHeaders: providerConfig ? { ...providerConfig.extraHeaders } : this.config.extraHeaders,
      extraBody: providerConfig ? { ...providerConfig.extraBody } : this.config.extraBody,
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
    if (this.catalogSelectionRequired && !this.modelSelection) {
      return "Error: model_selection_unavailable";
    }
    const model = this.modelSelection?.model ?? this.config.model;
    const provider = this.modelSelection?.provider ?? this.config.provider;
    if (!model.trim()) return "Error: image generation model selection is required";
    const client = this.providerClient();
    if (!client) return `Error: unsupported image generation provider '${provider}'`;
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
          model,
          referenceImages: refs,
          aspectRatio: params.aspect_ratio ?? params.aspectRatio ?? this.config.defaultAspectRatio,
          imageSize: params.image_size ?? params.imageSize ?? this.config.defaultImageSize,
        });
        for (const imageDataUrl of response.images) {
          const artifact = storeGeneratedImageArtifact(imageDataUrl, {
            prompt: params.prompt,
            model,
            sourceImages: refs,
            saveDir: this.config.saveDir,
            provider,
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
        if (error instanceof ImageGenerationError && error.errorCategory && this.modelSelection) {
          return `Error: ${error.message}\nmodel_error: ${JSON.stringify({
            category: error.errorCategory,
            presetId: this.modelSelection.presetId,
            source: this.modelSelection.source,
            provider: this.modelSelection.provider,
            model: this.modelSelection.model,
            capability: this.modelSelection.capability,
          })}`;
        }
        return `Error: ${error.message}`;
      }
      return `Error: ${String(error)}`;
    }
  }
}
