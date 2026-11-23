import { z } from "zod";

export const MODEL_CAPABILITY_CATALOG_MAX_SAFE_INTEGER = 9_007_199_254_740_991;
export const MODEL_CAPABILITY_CATALOG_MAX_TOKENS = 4_294_967_295;
export const MODEL_CAPABILITY_CATALOG_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

const modelNameSchema = z.string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim() && /^[\x20-\x7e]+$/.test(value), "invalid model name");

const thinkingLevelSchema = z.enum(MODEL_CAPABILITY_CATALOG_LEVELS);

export const CloudModelThinkingConfigSchema = z.object({
  switchable: z.boolean(),
  defaultEnabled: z.boolean(),
  levels: z.array(thinkingLevelSchema),
  defaultLevel: thinkingLevelSchema.optional()
}).strict().superRefine((thinking, context) => {
  if (!thinking.switchable && !thinking.defaultEnabled) {
    context.addIssue({ code: "custom", path: ["defaultEnabled"], message: "always-on thinking must be enabled" });
  }
  if (thinking.defaultLevel !== undefined && !thinking.levels.includes(thinking.defaultLevel)) {
    context.addIssue({ code: "custom", path: ["defaultLevel"], message: "default level must be listed" });
  }
});
export type CloudModelThinkingConfig = z.infer<typeof CloudModelThinkingConfigSchema>;

export const CloudModelCapabilitySchema = z.object({
  inputModalities: z.array(z.enum(["text", "image", "video"])).min(1),
  contextWindowTokens: z.number().int().min(1).max(MODEL_CAPABILITY_CATALOG_MAX_TOKENS),
  maxTokens: z.number().int().min(1).max(MODEL_CAPABILITY_CATALOG_MAX_TOKENS),
  thinking: CloudModelThinkingConfigSchema.optional()
}).strict().superRefine((model, context) => {
  if (model.maxTokens >= model.contextWindowTokens) {
    context.addIssue({ code: "custom", path: ["maxTokens"], message: "max tokens must be below the context window" });
  }
});
export type CloudModelCapability = z.infer<typeof CloudModelCapabilitySchema>;

export const ModelCapabilityCatalogSchema = z.object({
  catalogVersion: z.number().int().min(1).max(MODEL_CAPABILITY_CATALOG_MAX_SAFE_INTEGER),
  models: z.record(modelNameSchema, CloudModelCapabilitySchema)
}).strict();
export type ModelCapabilityCatalog = z.infer<typeof ModelCapabilityCatalogSchema>;

export const ModelCapabilityCatalogRefreshResultSchema = z.object({
  status: z.enum(["synced", "retries-exhausted", "unauthenticated", "stopped"]),
  hasValidCatalog: z.boolean(),
  catalogVersion: z.number().int().min(1).max(MODEL_CAPABILITY_CATALOG_MAX_SAFE_INTEGER).optional()
}).strict().superRefine((result, context) => {
  if (result.hasValidCatalog !== (result.catalogVersion !== undefined)
    || (result.status === "synced" && !result.hasValidCatalog)) {
    context.addIssue({ code: "custom", message: "catalog availability must match the version and sync status" });
  }
});
export type ModelCapabilityCatalogRefreshResult = z.infer<typeof ModelCapabilityCatalogRefreshResultSchema>;
