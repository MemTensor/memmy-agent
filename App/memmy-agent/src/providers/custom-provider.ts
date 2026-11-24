const MAX_COMPLETION_TOKEN_MARKERS = ["gpt-5", "gpt-6", "o1", "o3", "o4"] as const;

export function customModelUsesMaxCompletionTokens(modelName: string): boolean {
  const name = modelName.toLowerCase();
  return MAX_COMPLETION_TOKEN_MARKERS.some((marker) => name.includes(marker));
}
