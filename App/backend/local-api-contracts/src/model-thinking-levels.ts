/** Shared thinking schema and resolution rules; model data comes from the cloud catalog. */
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
