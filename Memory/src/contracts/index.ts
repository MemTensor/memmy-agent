export type UserMode = "unset" | "byok" | "account";
export type ModelCapability =
  | "agent"
  | "memory_summary"
  | "memory_evolution"
  | "embedding"
  | "asr"
  | "image_generation";
export type ModelSource = "account" | "byok";
export type ModelEndpointProtocol =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content"
  | "openai-embeddings"
  | "dashscope-input-audio-chat"
  | "openai-images"
  | "dashscope-multimodal-generation"
  | "memmy-account";

export * from "./memory-canonical-json.js";
export * from "./memory-workspace-identity.js";
export * from "./memory-l3-world-model.js";
export * from "./memory-runtime.js";
export * from "./model-catalog-resolver.js";
export * from "./desktop-runtime-manifest.js";
