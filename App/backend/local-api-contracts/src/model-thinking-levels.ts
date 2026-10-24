/**
 * 模型思考强度配置表。Reviewed: 2026-09-29
 *
 * 三个字段决定前端渲染与新 session 默认状态：
 * - switchable: true  → 渲染思考开关（用户可关闭思考）
 *                false → 不渲染开关（thinking always-on）
 * - defaultEnabled: 新 session 默认开关状态（仅 switchable:true 时有意义，当前恒为 true）
 * - levels: 强度档位列表（不含表示关闭的 "off"）。空数组 = 无档位选择器。
 *
 * 档位命名（统一 i18n key）：low=低, medium=中, high=高, xhigh=超高, max=最强
 */
import { z } from "zod";

/** 思考强度档位。前端 i18n key 由 `home.thinking.levelValue.${level}` 拼出，须为字面量联合。 */
export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelThinkingConfig {
  switchable: boolean;
  defaultEnabled: boolean;
  levels: readonly ThinkingLevel[];
  defaultLevel?: ThinkingLevel;
}

export const ModelThinkingConfigSchema = z.object({
  switchable: z.boolean(),
  defaultEnabled: z.boolean(),
  levels: z.array(z.enum(THINKING_LEVELS)),
  defaultLevel: z.enum(THINKING_LEVELS).optional()
});
export type ModelThinkingConfigDto = z.infer<typeof ModelThinkingConfigSchema>;

export const MODEL_THINKING_REVIEWED_AT = "2026-09-29";

const ALWAYS_ON_FIVE: ModelThinkingConfig = {
  switchable: false,
  defaultEnabled: true,
  levels: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "high"
};

const SWITCHABLE_FIVE: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "high"
};

/** GPT-6 Sol / Luna: `none` turns reasoning off; omitted effort is `medium`. */
const SWITCHABLE_FIVE_MEDIUM: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "medium"
};

/**
 * Thinking cannot be disabled. Five effort levels, default `medium`.
 * GPT-6 Astra rejects `none`. Claude Opus 5.5 documents `medium` as its API default.
 * OpenAI's reasoning guide does not publish a separate omit-effort default for Astra;
 * `medium` is the default it documents for the other GPT-6 models and for most workloads.
 */
const ALWAYS_ON_FIVE_MEDIUM: ModelThinkingConfig = {
  switchable: false,
  defaultEnabled: true,
  levels: ["low", "medium", "high", "xhigh", "max"],
  defaultLevel: "medium"
};

const SWITCHABLE_FOUR: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "medium", "high", "xhigh"],
  defaultLevel: "medium"
};

const SWITCHABLE_THREE: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "medium", "high"],
  defaultLevel: "medium"
};

const SWITCHABLE_LOW_HIGH_MAX: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "high", "max"],
  defaultLevel: "high"
};

const SWITCHABLE_LOW_HIGH: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: ["low", "high"],
  defaultLevel: "high"
};

const TOGGLE_ONLY: ModelThinkingConfig = {
  switchable: true,
  defaultEnabled: true,
  levels: []
};

export const MODEL_THINKING_CONFIGS: Readonly<Record<string, ModelThinkingConfig>> = Object.freeze({
  // Anthropic. Reviewed 2026-09-10.
  "claude-fable-5-1": ALWAYS_ON_FIVE,
  "claude-fable-5": ALWAYS_ON_FIVE,
  "claude-mythos-5-1": ALWAYS_ON_FIVE,
  "claude-mythos-5": ALWAYS_ON_FIVE,
  "claude-mythos-preview": ALWAYS_ON_FIVE,
  "claude-opus-5-5": ALWAYS_ON_FIVE_MEDIUM,
  "claude-opus-5": SWITCHABLE_FIVE,
  "claude-sonnet-5": SWITCHABLE_FIVE,
  "claude-opus-4-8": SWITCHABLE_FIVE,
  "claude-opus-4-7": SWITCHABLE_FIVE,
  "claude-opus-4-6": SWITCHABLE_FIVE,
  "claude-sonnet-4-6": SWITCHABLE_FIVE,
  "claude-opus-4-5-20251101": {
    switchable: true,
    defaultEnabled: true,
    levels: ["low", "medium", "high", "max"],
    defaultLevel: "high"
  },
  "claude-haiku-4-5": TOGGLE_ONLY,
  "claude-haiku-4-5-20251001": TOGGLE_ONLY,
  "anthropic.claude-opus-5-5": ALWAYS_ON_FIVE_MEDIUM,
  "anthropic.claude-opus-5": SWITCHABLE_FIVE,
  "anthropic.claude-sonnet-5": SWITCHABLE_FIVE,
  "anthropic.claude-opus-4-8": SWITCHABLE_FIVE,
  "anthropic.claude-opus-4-7": SWITCHABLE_FIVE,
  "anthropic.claude-haiku-4-5": TOGGLE_ONLY,

  // OpenAI. GPT-6 reviewed 2026-09-29; GPT-5.6 and earlier reviewed 2026-09-10.
  "gpt-6-astra": ALWAYS_ON_FIVE_MEDIUM,
  "gpt-6-sol": SWITCHABLE_FIVE_MEDIUM,
  "gpt-6-luna": SWITCHABLE_FIVE_MEDIUM,
  "gpt-5.6": SWITCHABLE_FIVE,
  "gpt-5.6-sol": SWITCHABLE_FIVE,
  "gpt-5.6-terra": SWITCHABLE_FIVE,
  "gpt-5.6-luna": SWITCHABLE_FIVE,
  "gpt-5.5": SWITCHABLE_FOUR,
  "gpt-5.5-pro": SWITCHABLE_FOUR,
  "gpt-5.4": SWITCHABLE_THREE,
  "gpt-5.4-pro": SWITCHABLE_THREE,
  "gpt-5.4-mini": SWITCHABLE_THREE,
  "gpt-5.4-nano": SWITCHABLE_THREE,
  "gpt-5.3-codex": SWITCHABLE_THREE,
  "gpt-5.2": SWITCHABLE_THREE,
  "gpt-5.2-pro": SWITCHABLE_THREE,
  "gpt-5.2-codex": SWITCHABLE_THREE,
  "gpt-5.1": SWITCHABLE_THREE,
  "gpt-5.1-codex": SWITCHABLE_THREE,

  // Gemini. 3.8 Flash reviewed 2026-09-29; 2.5 reviewed 2026-09-10.
  "gemini-3.8-flash": {
    switchable: false,
    defaultEnabled: true,
    levels: ["low", "medium", "high"],
    defaultLevel: "medium"
  },
  "gemini-2.5-flash": TOGGLE_ONLY,
  "gemini-2.5-flash-lite": TOGGLE_ONLY,

  // DeepSeek. V4.1 Flash reviewed 2026-09-29; earlier V4 ids reviewed 2026-09-10.
  "deepseek-flash": SWITCHABLE_LOW_HIGH_MAX,
  "deepseek-v4.1-flash": SWITCHABLE_LOW_HIGH_MAX,
  "deepseek-v4-pro": SWITCHABLE_LOW_HIGH_MAX,
  "deepseek-v4-flash": SWITCHABLE_LOW_HIGH_MAX,
  "deepseek-v4-flash-0731": SWITCHABLE_LOW_HIGH_MAX,
  "deepseek-v4-flash-vision-exp": SWITCHABLE_LOW_HIGH_MAX,
  "deepseek-v3.2": TOGGLE_ONLY,

  // Zhipu GLM. Reviewed 2026-09-10.
  "glm-5.3": {
    switchable: false,
    defaultEnabled: true,
    levels: ["low", "high", "max"],
    defaultLevel: "high"
  },
  "glm-5.2": TOGGLE_ONLY,
  "glm-5.1": TOGGLE_ONLY,
  "glm-5": TOGGLE_ONLY,
  "glm-5-turbo": TOGGLE_ONLY,
  "glm-4.7": TOGGLE_ONLY,

  // Kimi / Moonshot. Reviewed 2026-09-10.
  "kimi-k3": SWITCHABLE_LOW_HIGH_MAX,
  "k3": SWITCHABLE_LOW_HIGH_MAX,
  "k3-256k": SWITCHABLE_LOW_HIGH_MAX,
  "kimi-k2.6": TOGGLE_ONLY,
  "kimi-k2.5": TOGGLE_ONLY,

  // MiniMax. Reviewed 2026-09-10.
  "MiniMax-M3": TOGGLE_ONLY,

  // Qwen. Reviewed 2026-09-10.
  "qwen3.8-max": TOGGLE_ONLY,
  "qwen3.8-max-preview": TOGGLE_ONLY,
  "qwen3.7-max": TOGGLE_ONLY,
  "qwen3.7-max-2026-05-20": TOGGLE_ONLY,
  "qwen3.7-max-2026-06-08": TOGGLE_ONLY,
  "qwen3.7-plus": TOGGLE_ONLY,
  "qwen3.7-plus-2026-05-26": TOGGLE_ONLY,
  "qwen3.7-flash": TOGGLE_ONLY,
  "qwen3.7-flash-2026-07-15": TOGGLE_ONLY,
  "qwen3.6-max-preview": TOGGLE_ONLY,
  "qwen3.6-plus": TOGGLE_ONLY,
  "qwen3.6-plus-2026-04-02": TOGGLE_ONLY,
  "qwen3.6-flash": TOGGLE_ONLY,
  "qwen3.6-flash-2026-04-16": TOGGLE_ONLY,
  "qwen3.5-plus": TOGGLE_ONLY,
  "qwen3.5-plus-2026-02-15": TOGGLE_ONLY,
  "qwen3.5-flash": TOGGLE_ONLY,
  "qwen3.5-flash-2026-02-23": TOGGLE_ONLY,
  "qwen3-coder-plus": TOGGLE_ONLY,
  "qwen3-coder-flash": TOGGLE_ONLY,

  // Doubao. Reviewed 2026-09-10.
  "doubao-seed-evolving": TOGGLE_ONLY,
  "doubao-seed-2-1-pro": TOGGLE_ONLY,
  "doubao-seed-2-1-turbo": TOGGLE_ONLY,
  "doubao-seed-2-0-pro-260215": TOGGLE_ONLY,
  "doubao-seed-2-0-lite-260215": TOGGLE_ONLY,
  "doubao-seed-2-0-mini-260215": TOGGLE_ONLY,

  // Xiaomi MiMo. Reviewed 2026-09-10.
  "mimo-v2.5-pro": TOGGLE_ONLY,
  "mimo-v2.5-pro-ultraspeed": TOGGLE_ONLY,
  "mimo-v2.5": TOGGLE_ONLY,

  // StepFun. Reviewed 2026-09-10.
  "step-3.7-flash": SWITCHABLE_THREE,
  "step-3.5-flash": SWITCHABLE_LOW_HIGH,
  "step-3.5-flash-2603": SWITCHABLE_LOW_HIGH,

  // Baidu ERNIE. Reviewed 2026-09-10.
  "ernie-5.1": TOGGLE_ONLY,
  "ernie-5.0": TOGGLE_ONLY,
  "ernie-5.0-thinking-preview": TOGGLE_ONLY,
  "ernie-5.0-thinking-latest": TOGGLE_ONLY,
  "ernie-x1.1": TOGGLE_ONLY,
  "ernie-x1.1-preview": TOGGLE_ONLY
});

export function getModelThinkingConfig(model: string | null | undefined): ModelThinkingConfig | null {
  if (typeof model !== "string") return null;
  return MODEL_THINKING_CONFIGS[model] ?? null;
}

/** 是否只有开关无档位（情况2）：可开关且无强度档位。 */
export function isThinkingToggleOnly(config: ModelThinkingConfig | null): boolean {
  if (!config) return false;
  return config.switchable && config.levels.length === 0;
}

/** 解析当前生效的思考档位：会话选择优先，否则回退表中默认档，再退首个档位。 */
export function resolveThinkingLevel(
  config: ModelThinkingConfig,
  sessionLevel: string | null | undefined
): ThinkingLevel | null {
  if (sessionLevel && config.levels.includes(sessionLevel as ThinkingLevel)) {
    return sessionLevel as ThinkingLevel;
  }
  return config.defaultLevel ?? config.levels[0] ?? null;
}

/** 解析当前生效的开关状态：always-on 恒 true，其余用会话选择，缺省取 defaultEnabled。 */
export function resolveThinkingEnabled(
  config: ModelThinkingConfig,
  sessionEnabled: boolean | undefined
): boolean {
  if (!config.switchable) return true;
  return sessionEnabled ?? config.defaultEnabled;
}

/**
 * 从档位列表取默认档（"中档"）：优先 medium，否则取中间项（偶数个时偏下，避免默认落到最高档）。
 */
export function defaultThinkingLevel(levels: readonly ThinkingLevel[]): ThinkingLevel | undefined {
  if (levels.length === 0) return undefined;
  if (levels.includes("medium")) return "medium";
  return levels[Math.floor((levels.length - 1) / 2)];
}
