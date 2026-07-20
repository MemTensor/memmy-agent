type Dict<T = any> = Record<string, T>;

// Memmy Account gateway API base: the gateway domain comes only from MEMMY_CLOUD_SERVICE in the repository root .env.
// Resolution is deferred to actual memmy_account usage (see memmyAccountApiBase below) instead of module
// evaluation, so importing this module never throws for BYOK users who don't configure it.
/**
 * Resolve the Memmy Account gateway API base from MEMMY_CLOUD_SERVICE.
 *
 * Call this only where the memmy_account provider is genuinely about to be used (e.g. building a real
 * request). Throws the same clear error as before when the env var is missing.
 */
export function memmyAccountApiBase(): string {
  const cloudService = process.env.MEMMY_CLOUD_SERVICE?.trim();
  if (!cloudService) {
    throw new Error(
      "MEMMY_CLOUD_SERVICE 未配置:网关地址唯一来源是仓库根 .env,请确认入口已加载该文件。",
    );
  }
  return `${cloudService}/api/agentExternal/v1`;
}

// Safe, non-throwing variant for generic provider metadata/listing (onboarding, settings API, status),
// which enumerate every provider spec regardless of which one is actually in use.
function safeMemmyAccountApiBase(): string {
  try {
    return memmyAccountApiBase();
  } catch {
    return "";
  }
}

export type ProviderBackend =
  | "openai_compat"
  | "anthropic"
  | "azure_openai"
  | "openai_codex"
  | "github_copilot"
  | "bedrock";

export class ProviderSpec {
  name: string;
  keywords: string[];
  envKey: string;
  displayName: string;
  backend: ProviderBackend;
  envExtras: Array<[string, string]>;
  isGateway: boolean;
  isLocal: boolean;
  detectByKeyPrefix: string;
  detectByBaseKeyword: string;
  defaultApiBase: string;
  stripModelPrefix: boolean;
  supportsMaxCompletionTokens: boolean;
  modelOverrides: Array<[string, Dict]>;
  isOauth: boolean;
  isDirect: boolean;
  supportsPromptCaching: boolean;
  thinkingStyle: string;
  gatewayReasoningStyle: string;
  reasoningAsContent: boolean;
  aliases: string[];
  baseUrl?: string;

  constructor(init: {
    name: string;
    keywords?: string[];
    envKey?: string;
    displayName?: string;
    backend?: ProviderBackend;
    envExtras?: Array<[string, string]>;
    isGateway?: boolean;
    isLocal?: boolean;
    detectByKeyPrefix?: string;
    detectByBaseKeyword?: string;
    defaultApiBase?: string;
    stripModelPrefix?: boolean;
    supportsMaxCompletionTokens?: boolean;
    modelOverrides?: Array<[string, Dict]>;
    isOauth?: boolean;
    isDirect?: boolean;
    supportsPromptCaching?: boolean;
    thinkingStyle?: string;
    gatewayReasoningStyle?: string;
    reasoningAsContent?: boolean;
    aliases?: string[];
    baseUrl?: string;
  }) {
    this.name = init.name;
    this.keywords = init.keywords ?? init.aliases ?? [];
    this.envKey = init.envKey ?? "";
    this.displayName = init.displayName ?? "";
    this.backend = init.backend ?? "openai_compat";
    this.envExtras = init.envExtras ?? [];
    this.isGateway = init.isGateway ?? false;
    this.isLocal = init.isLocal ?? false;
    this.detectByKeyPrefix = init.detectByKeyPrefix ?? "";
    this.detectByBaseKeyword = init.detectByBaseKeyword ?? "";
    this.defaultApiBase = init.defaultApiBase ?? init.baseUrl ?? "";
    this.stripModelPrefix = init.stripModelPrefix ?? false;
    this.supportsMaxCompletionTokens = init.supportsMaxCompletionTokens ?? false;
    this.modelOverrides = init.modelOverrides ?? [];
    this.isOauth = init.isOauth ?? false;
    this.isDirect = init.isDirect ?? false;
    this.supportsPromptCaching = init.supportsPromptCaching ?? false;
    this.thinkingStyle = init.thinkingStyle ?? "";
    this.gatewayReasoningStyle = init.gatewayReasoningStyle ?? "";
    this.reasoningAsContent = init.reasoningAsContent ?? false;
    this.aliases = init.aliases ?? this.keywords;
    this.baseUrl = this.defaultApiBase || undefined;
  }

  get label(): string {
    return this.displayName || titleCase(this.name);
  }
}

export function normalizeProviderName(name: string): string {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function titleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export const PROVIDERS: ProviderSpec[] = [
  new ProviderSpec({ name: "custom", displayName: "Custom", isDirect: true }),
  new ProviderSpec({
    name: "azure_openai",
    keywords: ["azure", "azure-openai"],
    displayName: "Azure OpenAI",
    backend: "azure_openai",
    isDirect: true,
  }),
  new ProviderSpec({
    name: "bedrock",
    keywords: [
      "bedrock",
      "anthropic.claude",
      "amazon.nova",
      "meta.",
      "mistral.",
      "cohere.",
      "qwen.",
      "deepseek.",
      "openai.gpt-oss",
      "ai21.",
      "moonshot.",
      "writer.",
      "zai.",
    ],
    envKey: "AWS_BEARER_TOKEN_BEDROCK",
    displayName: "AWS Bedrock",
    backend: "bedrock",
    isDirect: true,
  }),
  new ProviderSpec({
    name: "openrouter",
    keywords: ["openrouter"],
    envKey: "OPENROUTER_API_KEY",
    displayName: "OpenRouter",
    isGateway: true,
    detectByKeyPrefix: "sk-or-",
    detectByBaseKeyword: "openrouter",
    defaultApiBase: "https://openrouter.ai/api/v1",
    supportsPromptCaching: true,
    gatewayReasoningStyle: "reasoning_effort",
  }),
  new ProviderSpec({
    name: "huggingface",
    keywords: ["huggingface", "hugging-face"],
    envKey: "HF_TOKEN",
    displayName: "Hugging Face",
    isGateway: true,
    detectByKeyPrefix: "hf_",
    detectByBaseKeyword: "huggingface",
    defaultApiBase: "https://router.huggingface.co/v1",
  }),
  new ProviderSpec({
    name: "skywork",
    keywords: ["skywork", "skyclaw", "apifree"],
    envKey: "SKYWORK_API_KEY",
    displayName: "Skywork",
    envExtras: [["APIFREE_API_KEY", "{apiKey}"]],
    isGateway: true,
    detectByBaseKeyword: "apifree.ai",
    defaultApiBase: "https://api.apifree.ai/agent/v1",
  }),
  new ProviderSpec({
    name: "aihubmix",
    keywords: ["aihubmix"],
    envKey: "OPENAI_API_KEY",
    displayName: "AiHubMix",
    isGateway: true,
    detectByBaseKeyword: "aihubmix",
    defaultApiBase: "https://aihubmix.com/v1",
    stripModelPrefix: true,
  }),
  new ProviderSpec({
    name: "siliconflow",
    keywords: ["siliconflow"],
    envKey: "OPENAI_API_KEY",
    displayName: "SiliconFlow",
    isGateway: true,
    detectByBaseKeyword: "siliconflow",
    defaultApiBase: "https://api.siliconflow.cn/v1",
  }),
  new ProviderSpec({
    name: "novita",
    keywords: ["novita"],
    envKey: "NOVITA_API_KEY",
    displayName: "Novita AI",
    isGateway: true,
    detectByBaseKeyword: "novita",
    defaultApiBase: "https://api.novita.ai/openai",
  }),
  new ProviderSpec({
    name: "volcengine",
    keywords: ["volcengine", "volces", "ark"],
    envKey: "OPENAI_API_KEY",
    displayName: "VolcEngine",
    isGateway: true,
    detectByBaseKeyword: "volces",
    defaultApiBase: "https://ark.cn-beijing.volces.com/api/v3",
    thinkingStyle: "thinking_type",
    supportsMaxCompletionTokens: true,
  }),
  new ProviderSpec({
    name: "volcengine_coding_plan",
    keywords: ["volcengine-plan"],
    envKey: "OPENAI_API_KEY",
    displayName: "VolcEngine Coding Plan",
    isGateway: true,
    defaultApiBase: "https://ark.cn-beijing.volces.com/api/coding/v3",
    stripModelPrefix: true,
    thinkingStyle: "thinking_type",
    supportsMaxCompletionTokens: true,
  }),
  new ProviderSpec({
    name: "byteplus",
    keywords: ["byteplus"],
    envKey: "OPENAI_API_KEY",
    displayName: "BytePlus",
    isGateway: true,
    detectByBaseKeyword: "bytepluses",
    defaultApiBase: "https://ark.ap-southeast.bytepluses.com/api/v3",
    stripModelPrefix: true,
    thinkingStyle: "thinking_type",
  }),
  new ProviderSpec({
    name: "byteplus_coding_plan",
    keywords: ["byteplus-plan"],
    envKey: "OPENAI_API_KEY",
    displayName: "BytePlus Coding Plan",
    isGateway: true,
    defaultApiBase: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    stripModelPrefix: true,
    thinkingStyle: "thinking_type",
  }),
  new ProviderSpec({
    name: "anthropic",
    keywords: ["anthropic", "claude"],
    envKey: "ANTHROPIC_API_KEY",
    displayName: "Anthropic",
    backend: "anthropic",
    supportsPromptCaching: true,
  }),
  new ProviderSpec({
    name: "openai",
    keywords: ["openai", "gpt"],
    envKey: "OPENAI_API_KEY",
    displayName: "OpenAI",
    supportsMaxCompletionTokens: true,
  }),
  new ProviderSpec({
    name: "memmy_account",
    keywords: ["memmy-account", "memmy_account"],
    displayName: "Memmy Account",
    defaultApiBase: safeMemmyAccountApiBase(),
  }),
  new ProviderSpec({
    name: "openai_codex",
    keywords: ["openai-codex"],
    displayName: "OpenAI Codex",
    backend: "openai_codex",
    detectByBaseKeyword: "codex",
    defaultApiBase: "https://chatgpt.com/backend-api",
    isOauth: true,
  }),
  new ProviderSpec({
    name: "github_copilot",
    keywords: ["github_copilot", "github-copilot", "copilot"],
    displayName: "Github Copilot",
    backend: "github_copilot",
    defaultApiBase: "https://api.githubcopilot.com",
    stripModelPrefix: true,
    isOauth: true,
    supportsMaxCompletionTokens: true,
  }),
  new ProviderSpec({
    name: "deepseek",
    keywords: ["deepseek"],
    envKey: "DEEPSEEK_API_KEY",
    displayName: "DeepSeek",
    defaultApiBase: "https://api.deepseek.com",
    thinkingStyle: "thinking_type",
  }),
  new ProviderSpec({
    name: "gemini",
    keywords: ["gemini", "gemma"],
    envKey: "GEMINI_API_KEY",
    displayName: "Gemini",
    defaultApiBase: "https://generativelanguage.googleapis.com/v1beta/openai/",
  }),
  new ProviderSpec({
    name: "zhipu",
    keywords: ["zhipu", "glm", "zai"],
    envKey: "ZAI_API_KEY",
    displayName: "Zhipu AI",
    envExtras: [["ZHIPUAI_API_KEY", "{apiKey}"]],
    defaultApiBase: "https://open.bigmodel.cn/api/paas/v4",
  }),
  new ProviderSpec({
    name: "dashscope",
    keywords: ["qwen", "dashscope"],
    envKey: "DASHSCOPE_API_KEY",
    displayName: "DashScope",
    defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    thinkingStyle: "enable_thinking",
  }),
  new ProviderSpec({
    name: "moonshot",
    keywords: ["moonshot", "kimi"],
    envKey: "MOONSHOT_API_KEY",
    displayName: "Moonshot",
    defaultApiBase: "https://api.moonshot.ai/v1",
  }),
  new ProviderSpec({
    name: "minimax",
    keywords: ["minimax"],
    envKey: "MINIMAX_API_KEY",
    displayName: "MiniMax",
    defaultApiBase: "https://api.minimax.io/v1",
    thinkingStyle: "reasoning_split",
  }),
  new ProviderSpec({
    name: "minimax_anthropic",
    keywords: ["minimax_anthropic"],
    envKey: "MINIMAX_API_KEY",
    displayName: "MiniMax (Anthropic)",
    backend: "anthropic",
    defaultApiBase: "https://api.minimax.io/anthropic",
  }),
  new ProviderSpec({
    name: "mistral",
    keywords: ["mistral"],
    envKey: "MISTRAL_API_KEY",
    displayName: "Mistral",
    defaultApiBase: "https://api.mistral.ai/v1",
  }),
  new ProviderSpec({
    name: "stepfun",
    keywords: ["stepfun", "step"],
    envKey: "STEPFUN_API_KEY",
    displayName: "Step Fun",
    defaultApiBase: "https://api.stepfun.com/v1",
    reasoningAsContent: true,
  }),
  new ProviderSpec({
    name: "xiaomi_mimo",
    keywords: ["xiaomi_mimo", "mimo"],
    envKey: "XIAOMIMIMO_API_KEY",
    displayName: "Xiaomi MIMO",
    defaultApiBase: "https://api.xiaomimimo.com/v1",
    thinkingStyle: "thinking_type",
  }),
  new ProviderSpec({
    name: "longcat",
    keywords: ["longcat"],
    envKey: "LONGCAT_API_KEY",
    displayName: "LongCat",
    defaultApiBase: "https://api.longcat.chat/openai/v1",
  }),
  new ProviderSpec({
    name: "ant_ling",
    keywords: ["ant_ling", "ant-ling", "ling-", "ring-"],
    envKey: "ANT_LING_API_KEY",
    displayName: "Ant Ling",
    detectByBaseKeyword: "ant-ling.com",
    defaultApiBase: "https://api.ant-ling.com/v1",
  }),
  new ProviderSpec({
    name: "vllm",
    keywords: ["vllm"],
    envKey: "HOSTED_VLLM_API_KEY",
    displayName: "vLLM",
    isLocal: true,
  }),
  new ProviderSpec({
    name: "ollama",
    keywords: ["ollama", "nemotron"],
    envKey: "OLLAMA_API_KEY",
    displayName: "Ollama",
    isLocal: true,
    detectByBaseKeyword: "11434",
    defaultApiBase: "http://localhost:11434/v1",
  }),
  new ProviderSpec({
    name: "lm_studio",
    keywords: ["lm-studio", "lmstudio", "lm_studio"],
    envKey: "LM_STUDIO_API_KEY",
    displayName: "LM Studio",
    isLocal: true,
    detectByBaseKeyword: "1234",
    defaultApiBase: "http://localhost:1234/v1",
  }),
  new ProviderSpec({
    name: "atomic_chat",
    keywords: ["atomic-chat", "atomic_chat", "atomicchat"],
    envKey: "ATOMIC_CHAT_API_KEY",
    displayName: "Atomic Chat",
    isLocal: true,
    detectByBaseKeyword: "1337",
    defaultApiBase: "http://localhost:1337/v1",
  }),
  new ProviderSpec({
    name: "ovms",
    keywords: ["openvino", "ovms"],
    displayName: "OpenVINO Model Server",
    isDirect: true,
    isLocal: true,
    defaultApiBase: "http://localhost:8000/v3",
  }),
  new ProviderSpec({
    name: "nvidia",
    keywords: ["nvidia", "nemotron", "nvapi"],
    envKey: "NVIDIA_NIM_API_KEY",
    displayName: "NVIDIA NIM",
    detectByKeyPrefix: "nvapi-",
    detectByBaseKeyword: "nvidia.com",
    defaultApiBase: "https://integrate.api.nvidia.com/v1",
  }),
  new ProviderSpec({
    name: "groq",
    keywords: ["groq"],
    envKey: "GROQ_API_KEY",
    displayName: "Groq",
    defaultApiBase: "https://api.groq.com/openai/v1",
  }),
  new ProviderSpec({
    name: "qianfan",
    keywords: ["qianfan", "ernie"],
    envKey: "QIANFAN_API_KEY",
    displayName: "Qianfan",
    defaultApiBase: "https://qianfan.baidubce.com/v2",
  }),
];

export function findByName(name: string | null | undefined): ProviderSpec | null {
  if (!name) return null;
  const normalized = normalizeProviderName(name);
  return (
    PROVIDERS.find(
      (p) =>
        p.name === normalized ||
        p.aliases.some((alias) => normalizeProviderName(alias) === normalized),
    ) ?? null
  );
}
