export type ModelInputModality = "text" | "image" | "video";

const TEXT = Object.freeze(["text"] as const);
const TEXT_IMAGE = Object.freeze(["text", "image"] as const);
const TEXT_IMAGE_VIDEO = Object.freeze(["text", "image", "video"] as const);

export const MODEL_INPUT_CAPABILITIES_REVIEWED_AT = "2026-08-24";

export function defineModelInputCapabilities(
  entries: ReadonlyArray<readonly [string, readonly ModelInputModality[]]>,
): Readonly<Record<string, readonly ModelInputModality[]>> {
  const result: Record<string, readonly ModelInputModality[]> = Object.create(null);
  for (const [model, modalities] of entries) {
    if (Object.prototype.hasOwnProperty.call(result, model)) {
      throw new Error(`Duplicate model input capability: ${model}`);
    }
    result[model] = Object.freeze([...modalities]);
  }
  return Object.freeze(result);
}

export const MODEL_INPUT_CAPABILITIES = defineModelInputCapabilities([
  // Memmy. Reviewed 2026-08-13.
  // Source: App/backend/src/infrastructure/memmy-config/index.ts
  ["agent_chat", TEXT],

  // OpenAI / Codex. Reviewed 2026-08-13.
  // Source: https://developers.openai.com/api/docs/models
  ["gpt-5.6", TEXT_IMAGE],
  ["gpt-5.6-sol", TEXT_IMAGE],
  ["gpt-5.6-terra", TEXT_IMAGE],
  ["gpt-5.6-luna", TEXT_IMAGE],
  ["gpt-5.5", TEXT_IMAGE],
  ["gpt-5.5-pro", TEXT_IMAGE],
  ["gpt-5.4", TEXT_IMAGE],
  ["gpt-5.4-pro", TEXT_IMAGE],
  ["gpt-5.4-mini", TEXT_IMAGE],
  ["gpt-5.4-nano", TEXT_IMAGE],
  ["gpt-5.3-codex", TEXT_IMAGE],
  ["gpt-5.2", TEXT_IMAGE],
  ["gpt-5.2-pro", TEXT_IMAGE],
  ["gpt-5.2-codex", TEXT_IMAGE],
  ["gpt-5.1", TEXT_IMAGE],
  ["gpt-5.1-codex", TEXT_IMAGE],
  ["gpt-5", TEXT_IMAGE],
  ["gpt-5-pro", TEXT_IMAGE],
  ["gpt-5-mini", TEXT_IMAGE],
  ["gpt-5-nano", TEXT_IMAGE],
  ["gpt-5-codex", TEXT_IMAGE],
  ["gpt-4.1", TEXT_IMAGE],
  ["gpt-4.1-mini", TEXT_IMAGE],
  ["gpt-4o", TEXT_IMAGE],
  ["gpt-4o-mini", TEXT_IMAGE],

  // Anthropic Claude API IDs. Reviewed 2026-08-13.
  // Source: https://platform.claude.com/docs/en/about-claude/models/overview
  ["claude-fable-5", TEXT_IMAGE],
  ["claude-opus-5", TEXT_IMAGE],
  ["claude-sonnet-5", TEXT_IMAGE],
  ["claude-mythos-5", TEXT_IMAGE],
  ["claude-mythos-preview", TEXT_IMAGE],
  ["claude-opus-4-8", TEXT_IMAGE],
  ["claude-opus-4-7", TEXT_IMAGE],
  ["claude-opus-4-6", TEXT_IMAGE],
  ["claude-sonnet-4-6", TEXT_IMAGE],
  ["claude-haiku-4-5", TEXT_IMAGE],
  ["claude-haiku-4-5-20251001", TEXT_IMAGE],

  // AWS 公布的 Claude model IDs. Reviewed 2026-08-13.
  // Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html
  ["anthropic.claude-fable-5", TEXT_IMAGE],
  ["us.anthropic.claude-fable-5", TEXT_IMAGE],
  ["global.anthropic.claude-fable-5", TEXT_IMAGE],
  ["anthropic.claude-opus-5", TEXT_IMAGE],
  ["anthropic.claude-sonnet-5", TEXT_IMAGE],
  ["us.anthropic.claude-sonnet-5", TEXT_IMAGE],
  ["eu.anthropic.claude-sonnet-5", TEXT_IMAGE],
  ["au.anthropic.claude-sonnet-5", TEXT_IMAGE],
  ["global.anthropic.claude-sonnet-5", TEXT_IMAGE],
  ["anthropic.claude-opus-4-8", TEXT_IMAGE],
  ["us.anthropic.claude-opus-4-8", TEXT_IMAGE],
  ["eu.anthropic.claude-opus-4-8", TEXT_IMAGE],
  ["jp.anthropic.claude-opus-4-8", TEXT_IMAGE],
  ["au.anthropic.claude-opus-4-8", TEXT_IMAGE],
  ["global.anthropic.claude-opus-4-8", TEXT_IMAGE],
  ["anthropic.claude-opus-4-7", TEXT_IMAGE],
  ["global.anthropic.claude-opus-4-7", TEXT_IMAGE],
  ["anthropic.claude-opus-4-6-v1", TEXT_IMAGE],
  ["us.anthropic.claude-opus-4-6-v1", TEXT_IMAGE],
  ["eu.anthropic.claude-opus-4-6-v1", TEXT_IMAGE],
  ["au.anthropic.claude-opus-4-6-v1", TEXT_IMAGE],
  ["global.anthropic.claude-opus-4-6-v1", TEXT_IMAGE],
  ["anthropic.claude-sonnet-4-6", TEXT_IMAGE],
  ["us.anthropic.claude-sonnet-4-6", TEXT_IMAGE],
  ["eu.anthropic.claude-sonnet-4-6", TEXT_IMAGE],
  ["au.anthropic.claude-sonnet-4-6", TEXT_IMAGE],
  ["jp.anthropic.claude-sonnet-4-6", TEXT_IMAGE],
  ["global.anthropic.claude-sonnet-4-6", TEXT_IMAGE],
  ["anthropic.claude-haiku-4-5-20251001-v1:0", TEXT_IMAGE],
  ["us.anthropic.claude-haiku-4-5-20251001-v1:0", TEXT_IMAGE],
  ["eu.anthropic.claude-haiku-4-5-20251001-v1:0", TEXT_IMAGE],
  ["au.anthropic.claude-haiku-4-5-20251001-v1:0", TEXT_IMAGE],
  ["jp.anthropic.claude-haiku-4-5-20251001-v1:0", TEXT_IMAGE],
  ["global.anthropic.claude-haiku-4-5-20251001-v1:0", TEXT_IMAGE],

  // Google Gemini. Reviewed 2026-08-19.
  // Source: https://ai.google.dev/gemini-api/docs/models
  ["gemini-3.7-flash", TEXT_IMAGE_VIDEO],
  ["gemini-3.6-flash", TEXT_IMAGE_VIDEO],
  ["gemini-3.5-flash", TEXT_IMAGE_VIDEO],
  ["gemini-3.5-flash-lite", TEXT_IMAGE_VIDEO],
  ["gemini-3.1-pro-preview", TEXT_IMAGE_VIDEO],
  ["gemini-3.1-pro-preview-customtools", TEXT_IMAGE_VIDEO],
  ["gemini-3.1-flash-lite", TEXT_IMAGE_VIDEO],
  ["gemini-3-flash-preview", TEXT_IMAGE_VIDEO],
  ["gemini-2.5-pro", TEXT_IMAGE_VIDEO],
  ["gemini-2.5-flash", TEXT_IMAGE_VIDEO],
  ["gemini-2.5-flash-lite", TEXT_IMAGE_VIDEO],

  // Amazon Nova. Reviewed 2026-08-13.
  // Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-cards-amazon.html
  ["amazon.nova-micro-v1:0", TEXT],
  ["amazon.nova-premier-v1:0", TEXT_IMAGE_VIDEO],
  ["amazon.nova-pro-v1:0", TEXT_IMAGE_VIDEO],
  ["amazon.nova-lite-v1:0", TEXT_IMAGE_VIDEO],
  ["global.amazon.nova-2-lite-v1:0", TEXT_IMAGE_VIDEO],
  ["us.amazon.nova-2-lite-v1:0", TEXT_IMAGE_VIDEO],

  // Mistral. Reviewed 2026-08-13.
  // Source: https://docs.mistral.ai/models/overview
  ["mistral-medium-3-5", TEXT_IMAGE],
  ["mistral-medium-latest", TEXT_IMAGE],
  ["mistral-small-2603", TEXT_IMAGE],
  ["mistral-small-latest", TEXT_IMAGE],
  ["mistral-large-2512", TEXT_IMAGE],
  ["mistral-large-latest", TEXT_IMAGE],
  ["ministral-14b-2512", TEXT_IMAGE],
  ["ministral-8b-2512", TEXT_IMAGE],
  ["ministral-3b-2512", TEXT_IMAGE],

  // xAI Grok. Reviewed 2026-08-13.
  // Source: https://docs.x.ai/developers/models
  ["grok-build-0.1", TEXT],
  ["grok-4.5", TEXT_IMAGE],
  ["grok-4.5-latest", TEXT_IMAGE],
  ["grok-build-latest", TEXT_IMAGE],
  ["grok-4.3", TEXT_IMAGE],
  ["grok-4.3-latest", TEXT_IMAGE],
  ["grok-latest", TEXT_IMAGE],

  // Meta Llama（AWS 公布的 model IDs）. Reviewed 2026-08-13.
  // Source: https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-4-scout-17b-instruct.html
  ["meta.llama4-scout-17b-instruct-v1:0", TEXT_IMAGE],
  ["us.meta.llama4-scout-17b-instruct-v1:0", TEXT_IMAGE],

  // NVIDIA Nemotron. Reviewed 2026-08-13.
  // Source: https://build.nvidia.com/models?q=nemotron
  ["nvidia/nemotron-3-super-120b-a12b", TEXT],
  ["nvidia/nemotron-3-nano-30b-a3b", TEXT],
  ["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", TEXT_IMAGE_VIDEO],

  // Groq 公布的 model IDs. Reviewed 2026-08-13.
  // Source: https://console.groq.com/docs/models
  ["openai/gpt-oss-120b", TEXT],
  ["openai/gpt-oss-20b", TEXT],
  ["groq/compound", TEXT],
  ["groq/compound-mini", TEXT],
  ["qwen/qwen3.6-27b", TEXT_IMAGE],

  // DeepSeek. Reviewed 2026-08-24.
  // Source: https://api-docs.deepseek.com/updates/
  ["deepseek-v4-pro", TEXT],
  ["deepseek-v4-flash", TEXT],
  ["deepseek-v4-flash-0731", TEXT],
  // Internal experimental route; it is not part of the public DeepSeek model list.
  ["deepseek-v4-flash-vision-exp", TEXT_IMAGE],
  ["deepseek-v3.2", TEXT],

  // Qwen / 百炼. Reviewed 2026-08-19.
  // Source: https://help.aliyun.com/zh/model-studio/token-plan-team-overview
  // Source: https://help.aliyun.com/zh/model-studio/vision-model/
  ["qwen3.7-max", TEXT],
  ["qwen3.7-max-preview", TEXT],
  ["qwen3.7-max-2026-05-20", TEXT],
  ["qwen3.7-max-2026-05-17", TEXT],
  ["qwen3.6-max-preview", TEXT],
  ["qwen3.8-max", TEXT_IMAGE],
  ["qwen3-coder-next", TEXT],
  ["qwen3-coder-plus", TEXT],
  ["qwen3-coder-flash", TEXT],
  ["qwen3.8-max-preview", TEXT_IMAGE],
  ["qwen3.7-max-2026-06-08", TEXT_IMAGE_VIDEO],
  ["qwen3.7-plus", TEXT_IMAGE_VIDEO],
  ["qwen3.7-plus-2026-05-26", TEXT_IMAGE_VIDEO],
  ["qwen3.7-flash", TEXT_IMAGE_VIDEO],
  ["qwen3.7-flash-2026-07-15", TEXT_IMAGE_VIDEO],
  ["qwen3.6-plus", TEXT_IMAGE_VIDEO],
  ["qwen3.6-plus-2026-04-02", TEXT_IMAGE_VIDEO],
  ["qwen3.6-flash", TEXT_IMAGE_VIDEO],
  ["qwen3.6-flash-2026-04-16", TEXT_IMAGE_VIDEO],
  ["qwen3.6-35b-a3b", TEXT_IMAGE_VIDEO],
  ["qwen3.5-plus", TEXT_IMAGE_VIDEO],
  ["qwen3.5-plus-2026-02-15", TEXT_IMAGE_VIDEO],
  ["qwen3.5-flash", TEXT_IMAGE_VIDEO],
  ["qwen3.5-flash-2026-02-23", TEXT_IMAGE_VIDEO],
  ["qwen3.5-397b-a17b", TEXT_IMAGE_VIDEO],
  ["qwen3.5-122b-a10b", TEXT_IMAGE_VIDEO],
  ["qwen3.5-35b-a3b", TEXT_IMAGE_VIDEO],
  ["qwen3.5-27b", TEXT_IMAGE_VIDEO],
  ["qwen3-vl-plus", TEXT_IMAGE_VIDEO],
  ["qwen3-vl-flash", TEXT_IMAGE_VIDEO],
  ["qwen3.5-omni-plus", TEXT_IMAGE_VIDEO],
  ["qwen3.5-omni-plus-2026-03-15", TEXT_IMAGE_VIDEO],
  ["qwen3.5-omni-flash", TEXT_IMAGE_VIDEO],
  ["qwen3.5-omni-flash-2026-03-15", TEXT_IMAGE_VIDEO],
  ["qwen3-omni-flash", TEXT_IMAGE_VIDEO],
  ["qwen3-omni-flash-2025-12-01", TEXT_IMAGE_VIDEO],

  // Kimi / Moonshot. Reviewed 2026-08-13.
  // Source: https://platform.kimi.com/docs/models
  // Source: https://www.kimi.com/code/docs/en/kimi-code/models.html
  ["k3-256k", TEXT_IMAGE],
  ["kimi-k3", TEXT_IMAGE_VIDEO],
  ["k3", TEXT_IMAGE_VIDEO],
  ["kimi-for-coding", TEXT_IMAGE_VIDEO],
  ["kimi-for-coding-highspeed", TEXT_IMAGE_VIDEO],
  ["kimi-k2.7-code", TEXT_IMAGE_VIDEO],
  ["kimi-k2.7-code-highspeed", TEXT_IMAGE_VIDEO],
  ["kimi-k2.6", TEXT_IMAGE_VIDEO],
  ["kimi-k2.5", TEXT_IMAGE_VIDEO],

  // 智谱 GLM. Reviewed 2026-08-13.
  // Source: https://docs.bigmodel.cn/cn/guide/start/model-overview
  ["glm-5.2", TEXT],
  ["glm-5.1", TEXT],
  ["glm-5", TEXT],
  ["glm-5-turbo", TEXT],
  ["glm-4.7", TEXT],
  ["glm-4.7-flashx", TEXT],
  ["glm-4.7-flash", TEXT],
  ["glm-5v-turbo", TEXT_IMAGE_VIDEO],
  ["glm-4.6v", TEXT_IMAGE_VIDEO],
  ["glm-4.6v-flash", TEXT_IMAGE_VIDEO],

  // MiniMax. Reviewed 2026-08-13.
  // Source: https://platform.minimaxi.com/docs/api-reference/api-overview
  // Source: https://www.minimax.io/blog/minimax-m3
  ["MiniMax-M2.7", TEXT],
  ["MiniMax-M2.7-highspeed", TEXT],
  ["MiniMax-M2.5", TEXT],
  ["MiniMax-M2.5-highspeed", TEXT],
  ["MiniMax-M3", TEXT_IMAGE_VIDEO],

  // 豆包 / 火山方舟. Reviewed 2026-08-13.
  // Source: https://www.volcengine.com/product/doubao
  ["doubao-seed-evolving", TEXT_IMAGE],
  ["doubao-seed-2-1-pro", TEXT_IMAGE],
  ["doubao-seed-2-1-turbo", TEXT_IMAGE],
  ["doubao-seed-2-0-pro-260215", TEXT_IMAGE_VIDEO],
  ["doubao-seed-2-0-lite-260215", TEXT_IMAGE_VIDEO],
  ["doubao-seed-2-0-mini-260215", TEXT_IMAGE_VIDEO],

  // 阶跃星辰. Reviewed 2026-08-13.
  // Source: https://platform.stepfun.com/docs/zh/guides/models/overview
  ["step-3.5-flash", TEXT],
  ["step-3.5-flash-2603", TEXT],
  ["step-2-mini", TEXT],
  ["step-router-v1", TEXT],
  ["step-3", TEXT_IMAGE],
  ["step-r1-v-mini", TEXT_IMAGE],
  ["step-1o-vision-32k", TEXT_IMAGE],
  ["step-1v-8k", TEXT_IMAGE],
  ["step-1v-32k", TEXT_IMAGE],
  ["step-gui", TEXT_IMAGE],
  ["step-1o-turbo-vision", TEXT_IMAGE_VIDEO],

  // 小米 MiMo. Reviewed 2026-08-13.
  // Source: https://mimo.mi.com/docs
  ["mimo-v2.5-pro", TEXT],
  ["mimo-v2.5-pro-ultraspeed", TEXT],
  ["mimo-v2.5", TEXT_IMAGE_VIDEO],

  // 美团 LongCat. Reviewed 2026-08-13.
  // Source: https://longcat.chat/platform/docs/api/chat.html
  ["LongCat-2.0", TEXT],

  // 蚂蚁 Ling / Ring / Ming. Reviewed 2026-08-13.
  // Source: https://developer.ant-ling.com/zh-CN/docs/api-reference/
  ["Ling-3.0-flash", TEXT],
  ["Ling-2.6-1T", TEXT],
  ["Ling-2.6-flash", TEXT],
  ["Ring-2.6-1T", TEXT],
  ["Ming-Flash-Omni", TEXT_IMAGE_VIDEO],

  // 昆仑万维 Skywork. Reviewed 2026-08-13.
  // Source: https://skywork.ai/slide/en/skyclaw-ai-code-generation-2064558443047112705
  ["skywork-ai/skyclaw-v1", TEXT],
  ["skywork-ai/skyclaw-v1-lite", TEXT],

  // 百度 ERNIE. Reviewed 2026-08-13.
  // Source: https://qianfan.cloud.baidu.com/qianfandev-docs/
  ["ernie-5.1", TEXT],
  ["ernie-x1.1", TEXT],
  ["ernie-x1.1-preview", TEXT],
  ["ernie-4.5-turbo-128k", TEXT],
  ["ernie-5.0", TEXT_IMAGE_VIDEO],
  ["ernie-5.0-thinking-preview", TEXT_IMAGE_VIDEO],
  ["ernie-5.0-thinking-latest", TEXT_IMAGE_VIDEO],
  ["ernie-4.5-turbo-vl", TEXT_IMAGE_VIDEO],
  ["ernie-4.5-turbo-vl-32k", TEXT_IMAGE_VIDEO],

  // 腾讯混元. Reviewed 2026-08-13.
  // Source: https://cloud.tencent.com/document/product/1823/130051
  ["hy3", TEXT],
  ["hy3-preview", TEXT],

  // 科大讯飞星火 / 星辰 Coding Plan. Reviewed 2026-08-13.
  // Source: https://www.xfyun.cn/doc/spark/CodingPlan.html
  ["xsparkx2agent", TEXT],
  ["xsparkx2", TEXT],
  ["xsparkx2flash", TEXT],
  ["astron-code-latest", TEXT],
  ["xopglm52", TEXT],
  ["xopglm51", TEXT],
  ["xopglm5", TEXT],
  ["xopdeepseekv4pro", TEXT],
  ["xopdeepseekv4flash", TEXT],
  ["xopdeepseekv32", TEXT],
  ["xopkimik26", TEXT],
  ["xopkimik25", TEXT],
  ["xminimaxm25", TEXT],
  ["xopqwen35397b", TEXT],
  ["xopqwen36v35b", TEXT],
  ["xopqwen35v35b", TEXT],
  ["xop3qwencodernext", TEXT],
  ["xopglmv47flash", TEXT],
  ["xopkimi27code", TEXT],

  // 商汤日日新. Reviewed 2026-08-13.
  // Source: https://www.sensecore.cn/help/docs/model-as-a-service/nova/model/fusionllm/FusionLLMs
  // Source: https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/compatible-mode
  ["SenseNova-V6-Pro", TEXT_IMAGE],
  ["SenseNova-V6-Reasoner", TEXT_IMAGE],
  ["SenseNova-V6-5-Pro", TEXT_IMAGE_VIDEO],
  ["SenseNova-V6-5-Turbo", TEXT_IMAGE_VIDEO],
  ["SenseNova-V6-Turbo", TEXT_IMAGE_VIDEO],
]);

export function getModelInputModalities(
  model: string | null | undefined,
): readonly ModelInputModality[] {
  if (typeof model !== "string") return TEXT;
  return MODEL_INPUT_CAPABILITIES[model] ?? TEXT;
}

export function requiredInputModalities(
  messages: readonly Record<string, any>[],
): readonly ModelInputModality[] {
  const hasImage = messages.some((message) =>
    Array.isArray(message?.content)
    && message.content.some((block: any) => block?.type === "image_url"),
  );
  return hasImage ? TEXT_IMAGE : TEXT;
}

export function coversInputModalities(
  supported: readonly ModelInputModality[],
  required: readonly ModelInputModality[],
): boolean {
  return required.every((modality) => supported.includes(modality));
}
