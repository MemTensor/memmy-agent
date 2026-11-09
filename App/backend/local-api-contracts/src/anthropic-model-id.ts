/** Match the model ID sent by the Anthropic Messages runtime.
 * Only the leading provider marker is removed; gateway paths remain intact.
 * Call this for Anthropic Messages, never for OpenAI-compatible gateway IDs.
 */
export function anthropicRequestModelId(model: string): string {
  return model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
}
