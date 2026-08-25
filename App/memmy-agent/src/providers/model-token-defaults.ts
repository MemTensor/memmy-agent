import { CONTEXT_SAFETY_BUFFER_TOKENS } from "../token-budget.js";

export type ModelTokenDefaults = Readonly<{
  contextWindowTokens: number;
  maxTokens: number;
}>;

export type ModelTokenDefaultGroup = Readonly<{
  models: readonly string[];
  contextWindowTokens: number;
  maxTokens: number;
}>;

export const MODEL_TOKEN_DEFAULTS_REVIEWED_AT = "2026-08-24";

function assertPositiveSafeInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

export function defineModelTokenDefaults(
  groups: readonly ModelTokenDefaultGroup[],
): Readonly<Record<string, ModelTokenDefaults>> {
  const result: Record<string, ModelTokenDefaults> = Object.create(null);

  for (const group of groups) {
    const models = Object.freeze(group.models);
    assertPositiveSafeInteger("contextWindowTokens", group.contextWindowTokens);
    assertPositiveSafeInteger("maxTokens", group.maxTokens);
    if (group.maxTokens >= group.contextWindowTokens) {
      throw new Error("maxTokens must be less than contextWindowTokens");
    }
    if (group.contextWindowTokens - group.maxTokens - CONTEXT_SAFETY_BUFFER_TOKENS <= 0) {
      throw new Error("model token defaults must leave a positive input budget");
    }

    const value = Object.freeze({
      contextWindowTokens: group.contextWindowTokens,
      maxTokens: group.maxTokens,
    });
    for (const model of models) {
      if (!model || model.trim() !== model) {
        throw new Error(`Invalid model token default key: ${JSON.stringify(model)}`);
      }
      if (Object.prototype.hasOwnProperty.call(result, model)) {
        throw new Error(`Duplicate model token default: ${model}`);
      }
      result[model] = value;
    }
  }

  return Object.freeze(result);
}

export const MODEL_TOKEN_DEFAULTS = defineModelTokenDefaults([
  // OpenAI. Reviewed 2026-08-19.
  // Source: https://developers.openai.com/api/docs/models
  {
    models: ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    contextWindowTokens: 1_050_000,
    maxTokens: 128_000,
  },
  {
    models: ["gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-pro"],
    contextWindowTokens: 1_050_000,
    maxTokens: 128_000,
  },
  {
    models: ["gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3-codex"],
    contextWindowTokens: 400_000,
    maxTokens: 128_000,
  },
  {
    models: ["gpt-5.2", "gpt-5.2-pro", "gpt-5.2-codex", "gpt-5.1", "gpt-5.1-codex"],
    contextWindowTokens: 400_000,
    maxTokens: 128_000,
  },
  {
    models: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-codex"],
    contextWindowTokens: 400_000,
    maxTokens: 128_000,
  },
  { models: ["gpt-5-pro"], contextWindowTokens: 400_000, maxTokens: 272_000 },
  { models: ["gpt-4.1", "gpt-4.1-mini"], contextWindowTokens: 1_047_576, maxTokens: 32_768 },
  { models: ["gpt-4o", "gpt-4o-mini"], contextWindowTokens: 128_000, maxTokens: 16_384 },

  // Anthropic and official AWS transport IDs. Reviewed 2026-08-19.
  // Sources: https://platform.claude.com/docs/en/about-claude/models/overview
  //          https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html
  {
    models: [
      "claude-fable-5",
      "anthropic.claude-fable-5",
      "us.anthropic.claude-fable-5",
      "global.anthropic.claude-fable-5",
      "claude-opus-5",
      "anthropic.claude-opus-5",
      "claude-sonnet-5",
      "anthropic.claude-sonnet-5",
      "us.anthropic.claude-sonnet-5",
      "eu.anthropic.claude-sonnet-5",
      "au.anthropic.claude-sonnet-5",
      "global.anthropic.claude-sonnet-5",
      "claude-mythos-5",
      "claude-mythos-preview",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 128_000,
  },
  {
    models: [
      "claude-opus-4-8",
      "anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-4-8",
      "eu.anthropic.claude-opus-4-8",
      "jp.anthropic.claude-opus-4-8",
      "au.anthropic.claude-opus-4-8",
      "global.anthropic.claude-opus-4-8",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 128_000,
  },
  {
    models: ["claude-opus-4-7", "anthropic.claude-opus-4-7", "global.anthropic.claude-opus-4-7"],
    contextWindowTokens: 1_000_000,
    maxTokens: 128_000,
  },
  {
    models: [
      "claude-opus-4-6",
      "anthropic.claude-opus-4-6-v1",
      "us.anthropic.claude-opus-4-6-v1",
      "eu.anthropic.claude-opus-4-6-v1",
      "au.anthropic.claude-opus-4-6-v1",
      "global.anthropic.claude-opus-4-6-v1",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 128_000,
  },
  {
    models: [
      "claude-sonnet-4-6",
      "anthropic.claude-sonnet-4-6",
      "us.anthropic.claude-sonnet-4-6",
      "eu.anthropic.claude-sonnet-4-6",
      "au.anthropic.claude-sonnet-4-6",
      "jp.anthropic.claude-sonnet-4-6",
      "global.anthropic.claude-sonnet-4-6",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 64_000,
  },
  {
    models: [
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "anthropic.claude-haiku-4-5-20251001-v1:0",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      "au.anthropic.claude-haiku-4-5-20251001-v1:0",
      "jp.anthropic.claude-haiku-4-5-20251001-v1:0",
      "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    ],
    contextWindowTokens: 200_000,
    maxTokens: 64_000,
  },

  // Google Gemini. Reviewed 2026-08-19.
  // Source: https://ai.google.dev/gemini-api/docs/models
  {
    models: [
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-pro-preview",
      "gemini-3.1-pro-preview-customtools",
      "gemini-3.1-flash-lite",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ],
    contextWindowTokens: 1_048_576,
    maxTokens: 65_536,
  },

  // Amazon Nova. Reviewed 2026-08-19.
  // Source: https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html
  { models: ["amazon.nova-micro-v1:0"], contextWindowTokens: 128_000, maxTokens: 10_000 },
  { models: ["amazon.nova-premier-v1:0"], contextWindowTokens: 1_000_000, maxTokens: 25_000 },
  {
    models: ["amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0"],
    contextWindowTokens: 300_000,
    maxTokens: 10_000,
  },
  {
    models: ["global.amazon.nova-2-lite-v1:0", "us.amazon.nova-2-lite-v1:0"],
    contextWindowTokens: 1_000_000,
    maxTokens: 64_000,
  },

  // Mistral. Reviewed 2026-08-19. Output is undisclosed; use the system safe default.
  // Source: https://docs.mistral.ai/models
  {
    models: [
      "mistral-medium-3-5",
      "mistral-medium-latest",
      "mistral-small-2603",
      "mistral-small-latest",
      "mistral-large-2512",
      "mistral-large-latest",
      "ministral-14b-2512",
      "ministral-8b-2512",
      "ministral-3b-2512",
    ],
    contextWindowTokens: 256_000,
    maxTokens: 65_536,
  },

  // xAI. Reviewed 2026-08-19. Output is undisclosed; use the system safe default.
  // Source: https://docs.x.ai/developers/models
  { models: ["grok-build-0.1"], contextWindowTokens: 256_000, maxTokens: 65_536 },
  {
    models: ["grok-4.5", "grok-4.5-latest", "grok-build-latest"],
    contextWindowTokens: 500_000,
    maxTokens: 65_536,
  },
  {
    models: ["grok-4.3", "grok-4.3-latest", "grok-latest"],
    contextWindowTokens: 1_000_000,
    maxTokens: 65_536,
  },

  // Meta Llama on AWS. Reviewed 2026-08-19.
  // Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-4-scout-17b-instruct.html
  {
    models: ["meta.llama4-scout-17b-instruct-v1:0", "us.meta.llama4-scout-17b-instruct-v1:0"],
    contextWindowTokens: 10_000_000,
    maxTokens: 8_192,
  },

  // NVIDIA Nemotron. Reviewed 2026-08-19.
  // Source: https://build.nvidia.com/models?q=nemotron
  {
    models: ["nvidia/nemotron-3-super-120b-a12b"],
    contextWindowTokens: 1_000_000,
    maxTokens: 32_768,
  },
  { models: ["nvidia/nemotron-3-nano-30b-a3b"], contextWindowTokens: 262_144, maxTokens: 16_384 },
  {
    models: ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"],
    contextWindowTokens: 210_000,
    maxTokens: 20_480,
  },

  // Groq official IDs. Reviewed 2026-08-19.
  // Source: https://console.groq.com/docs/models
  {
    models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"],
    contextWindowTokens: 131_072,
    maxTokens: 65_536,
  },
  {
    models: ["groq/compound", "groq/compound-mini"],
    contextWindowTokens: 131_072,
    maxTokens: 8_192,
  },
  { models: ["qwen/qwen3.6-27b"], contextWindowTokens: 131_072, maxTokens: 16_384 },

  // DeepSeek. Reviewed 2026-08-24.
  // Source: https://api-docs.deepseek.com/updates
  {
    models: [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "deepseek-v4-flash-0731",
      // The experimental vision route inherits the V4 Flash limits.
      "deepseek-v4-flash-vision-exp",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 384_000,
  },
  { models: ["deepseek-v3.2"], contextWindowTokens: 131_072, maxTokens: 65_536 },

  // Qwen / Model Studio. Reviewed 2026-08-19.
  // Sources: https://help.aliyun.com/zh/model-studio/text-generation-model
  //          https://help.aliyun.com/zh/model-studio/vision-model
  {
    models: ["qwen3.8-max", "qwen3.8-max-preview"],
    contextWindowTokens: 1_000_000,
    maxTokens: 65_536,
  },
  {
    models: [
      "qwen3.7-max",
      "qwen3.7-max-preview",
      "qwen3.7-max-2026-05-20",
      "qwen3.7-max-2026-05-17",
      "qwen3.7-max-2026-06-08",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 65_536,
  },
  { models: ["qwen3.6-max-preview"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  {
    models: ["qwen3-coder-plus", "qwen3-coder-flash"],
    contextWindowTokens: 1_000_000,
    maxTokens: 65_536,
  },
  { models: ["qwen3-coder-next"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  {
    models: [
      "qwen3.7-plus",
      "qwen3.7-plus-2026-05-26",
      "qwen3.7-flash",
      "qwen3.7-flash-2026-07-15",
      "qwen3.6-plus",
      "qwen3.6-plus-2026-04-02",
      "qwen3.6-flash",
      "qwen3.6-flash-2026-04-16",
      "qwen3.5-plus",
      "qwen3.5-plus-2026-02-15",
      "qwen3.5-flash",
      "qwen3.5-flash-2026-02-23",
    ],
    contextWindowTokens: 1_000_000,
    maxTokens: 65_536,
  },
  { models: ["qwen3.6-35b-a3b"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  {
    models: ["qwen3.5-397b-a17b", "qwen3.5-122b-a10b", "qwen3.5-35b-a3b", "qwen3.5-27b"],
    contextWindowTokens: 32_768,
    maxTokens: 8_192,
  },
  { models: ["qwen3-vl-plus", "qwen3-vl-flash"], contextWindowTokens: 262_144, maxTokens: 32_768 },
  {
    models: [
      "qwen3.5-omni-plus",
      "qwen3.5-omni-plus-2026-03-15",
      "qwen3.5-omni-flash",
      "qwen3.5-omni-flash-2026-03-15",
      "qwen3-omni-flash",
      "qwen3-omni-flash-2025-12-01",
    ],
    contextWindowTokens: 65_536,
    maxTokens: 16_384,
  },

  // Kimi / Moonshot. Reviewed 2026-08-19.
  // Sources: https://platform.kimi.com/docs/api/chat
  //          https://www.kimi.com/code/docs/en/kimi-code/models.html
  { models: ["k3-256k"], contextWindowTokens: 262_144, maxTokens: 131_072 },
  { models: ["kimi-k3", "k3"], contextWindowTokens: 1_048_576, maxTokens: 131_072 },
  {
    models: [
      "kimi-for-coding",
      "kimi-for-coding-highspeed",
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
    ],
    contextWindowTokens: 262_144,
    maxTokens: 65_536,
  },
  { models: ["kimi-k2.6", "kimi-k2.5"], contextWindowTokens: 262_144, maxTokens: 65_536 },

  // Zhipu GLM. Reviewed 2026-08-19.
  // Source: https://docs.bigmodel.cn/cn/guide/start/model-overview
  { models: ["glm-5.2"], contextWindowTokens: 1_000_000, maxTokens: 128_000 },
  {
    models: ["glm-5.1", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.7-flashx", "glm-4.7-flash"],
    contextWindowTokens: 200_000,
    maxTokens: 128_000,
  },
  { models: ["glm-5v-turbo"], contextWindowTokens: 200_000, maxTokens: 128_000 },
  { models: ["glm-4.6v", "glm-4.6v-flash"], contextWindowTokens: 128_000, maxTokens: 32_768 },

  // MiniMax. Reviewed 2026-08-19.
  // Source: https://platform.minimaxi.com/docs/api-reference/api-overview
  {
    models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed"],
    contextWindowTokens: 204_800,
    maxTokens: 65_536,
  },
  { models: ["MiniMax-M3"], contextWindowTokens: 1_000_000, maxTokens: 131_072 },

  // Doubao / Volcengine. Reviewed 2026-08-19.
  // Source: https://console.volcengine.com/ark/experience
  { models: ["doubao-seed-evolving"], contextWindowTokens: 1_000_000, maxTokens: 65_536 },
  {
    models: ["doubao-seed-2-1-pro", "doubao-seed-2-1-turbo"],
    contextWindowTokens: 256_000,
    maxTokens: 32_000,
  },
  {
    models: [
      "doubao-seed-2-0-pro-260215",
      "doubao-seed-2-0-lite-260215",
      "doubao-seed-2-0-mini-260215",
    ],
    contextWindowTokens: 256_000,
    maxTokens: 32_000,
  },

  // StepFun. Reviewed 2026-08-19.
  // Sources: https://platform.stepfun.com/docs/zh/guides/models/overview
  //          https://platform.stepfun.com/docs/zh/guides/models/model-lab
  {
    models: ["step-3.5-flash", "step-3.5-flash-2603"],
    contextWindowTokens: 262_144,
    maxTokens: 65_536,
  },
  { models: ["step-2-mini"], contextWindowTokens: 32_768, maxTokens: 8_192 },
  { models: ["step-router-v1"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  { models: ["step-3"], contextWindowTokens: 65_536, maxTokens: 16_384 },
  { models: ["step-r1-v-mini"], contextWindowTokens: 102_400, maxTokens: 32_768 },
  {
    models: ["step-1o-vision-32k", "step-1v-32k", "step-1o-turbo-vision"],
    contextWindowTokens: 32_768,
    maxTokens: 8_192,
  },
  { models: ["step-1v-8k"], contextWindowTokens: 8_192, maxTokens: 2_048 },
  // Model Lab does not disclose limits; retain the generic system defaults explicitly.
  { models: ["step-gui"], contextWindowTokens: 200_000, maxTokens: 65_536 },

  // Xiaomi MiMo. Reviewed 2026-08-19.
  // Source: https://mimo.mi.com/docs/zh-CN/quick-start/summary/model
  {
    models: ["mimo-v2.5-pro", "mimo-v2.5-pro-ultraspeed", "mimo-v2.5"],
    contextWindowTokens: 1_048_576,
    maxTokens: 131_072,
  },

  // Meituan LongCat. Reviewed 2026-08-19.
  // Source: https://longcat.chat/platform/docs/zh/
  { models: ["LongCat-2.0"], contextWindowTokens: 1_000_000, maxTokens: 128_000 },

  // Ant Ling / Ring / Ming. Reviewed 2026-08-19.
  // Source: https://developer.ant-ling.com/zh-CN/docs/faq/
  { models: ["Ling-3.0-flash"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  { models: ["Ling-2.6-1T"], contextWindowTokens: 1_048_576, maxTokens: 131_072 },
  { models: ["Ling-2.6-flash", "Ring-2.6-1T"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  { models: ["Ming-Flash-Omni"], contextWindowTokens: 32_768, maxTokens: 8_192 },

  // Skywork SkyClaw. Reviewed 2026-08-19.
  // Source: https://skyworkai.github.io/skyclaw/
  {
    models: ["skywork-ai/skyclaw-v1", "skywork-ai/skyclaw-v1-lite"],
    contextWindowTokens: 1_000_000,
    maxTokens: 65_536,
  },

  // Baidu ERNIE. Reviewed 2026-08-19.
  // Source: https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j
  {
    models: ["ernie-5.1", "ernie-5.0", "ernie-5.0-thinking-preview", "ernie-5.0-thinking-latest"],
    contextWindowTokens: 131_072,
    maxTokens: 65_536,
  },
  { models: ["ernie-x1.1", "ernie-x1.1-preview"], contextWindowTokens: 65_536, maxTokens: 32_768 },
  { models: ["ernie-4.5-turbo-128k"], contextWindowTokens: 131_072, maxTokens: 12_288 },
  { models: ["ernie-4.5-turbo-vl"], contextWindowTokens: 131_072, maxTokens: 16_384 },
  { models: ["ernie-4.5-turbo-vl-32k"], contextWindowTokens: 32_768, maxTokens: 12_288 },

  // Tencent Hunyuan. Reviewed 2026-08-19.
  // Source: https://github.com/Tencent-Hunyuan/Hy3
  { models: ["hy3", "hy3-preview"], contextWindowTokens: 262_144, maxTokens: 65_536 },

  // iFlytek Spark and official aliases. Reviewed 2026-08-19.
  // Sources: https://www.xfyun.cn/doc/spark/TokenPlan.html
  //          https://www.xfyun.cn/doc/spark/CodingPlan.html
  { models: ["xsparkx2agent"], contextWindowTokens: 262_144, maxTokens: 131_072 },
  { models: ["xsparkx2"], contextWindowTokens: 196_608, maxTokens: 131_072 },
  { models: ["xsparkx2flash"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  { models: ["astron-code-latest"], contextWindowTokens: 92_160, maxTokens: 32_768 },
  { models: ["xopglm52"], contextWindowTokens: 1_000_000, maxTokens: 128_000 },
  {
    models: ["xopglm51", "xopglm5", "xopglmv47flash"],
    contextWindowTokens: 200_000,
    maxTokens: 128_000,
  },
  {
    models: ["xopdeepseekv4pro", "xopdeepseekv4flash"],
    contextWindowTokens: 1_000_000,
    maxTokens: 384_000,
  },
  { models: ["xopdeepseekv32"], contextWindowTokens: 131_072, maxTokens: 65_536 },
  {
    models: ["xopkimik26", "xopkimik25", "xopkimi27code"],
    contextWindowTokens: 262_144,
    maxTokens: 65_536,
  },
  { models: ["xminimaxm25"], contextWindowTokens: 204_800, maxTokens: 65_536 },
  { models: ["xopqwen35397b", "xopqwen35v35b"], contextWindowTokens: 32_768, maxTokens: 8_192 },
  { models: ["xopqwen36v35b"], contextWindowTokens: 262_144, maxTokens: 65_536 },
  { models: ["xop3qwencodernext"], contextWindowTokens: 262_144, maxTokens: 65_536 },

  // SenseNova. Reviewed 2026-08-19.
  // Source: https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs
  {
    models: ["SenseNova-V6-Pro", "SenseNova-V6-Reasoner", "SenseNova-V6-Turbo"],
    contextWindowTokens: 32_768,
    maxTokens: 16_384,
  },
  {
    models: ["SenseNova-V6-5-Pro", "SenseNova-V6-5-Turbo"],
    contextWindowTokens: 131_072,
    maxTokens: 16_384,
  },
]);

export function getModelTokenDefaults(model: string | null | undefined): ModelTokenDefaults | null {
  if (typeof model !== "string") return null;
  return MODEL_TOKEN_DEFAULTS[model] ?? null;
}
