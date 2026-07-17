export type MemmyAccountThinkingStyle = "enable_thinking" | "thinking_type" | "";

export function memmyAccountNoneThinkingStyle(
  providerName: string | null | undefined,
  modelName: string,
  semanticEffort: string | null,
): MemmyAccountThinkingStyle {
  if (providerName !== "memmy_account") return "";
  if (semanticEffort !== "none") return "";

  const name = modelName.toLowerCase();
  if (name.includes("qwen") || name.includes("agent_chat")) return "enable_thinking";
  if (
    name.includes("deepseek") ||
    name.includes("glm") ||
    name.includes("kimi") ||
    name.includes("minimax") ||
    name.includes("mimo")
  ) {
    return "thinking_type";
  }

  return "";
}
