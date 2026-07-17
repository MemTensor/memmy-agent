import type { LLMProvider } from "../providers/base.js";
import { renderTemplate } from "./prompt-templates.js";

export const EVALUATE_TOOL = [
  {
    type: "function",
    function: {
      name: "evaluate_notification",
      description: "Decide whether the user should be notified about this background task result.",
      parameters: {
        type: "object",
        properties: {
          should_notify: {
            type: "boolean",
            description: "true = result contains actionable/important info the user should see; false = routine or empty, safe to suppress",
          },
          reason: { type: "string", description: "One-sentence reason for the decision" },
        },
        required: ["should_notify"],
      },
    },
  },
];

export async function evaluateResponse(
  response: string,
  taskContext = "",
  provider?: LLMProvider | null,
  model = "",
): Promise<boolean> {
  if (!provider) return Boolean(response?.trim());
  try {
    const llmResponse = await provider.chatWithRetry({
      messages: [
        { role: "system", content: renderTemplate("agent/evaluator.md", { part: "system" }) },
        {
          role: "user",
          content: renderTemplate("agent/evaluator.md", {
            part: "user",
            task_context: taskContext,
            response,
          }),
        },
      ],
      tools: EVALUATE_TOOL,
      model,
      maxTokens: 256,
      temperature: 0,
    });
    if (!llmResponse.shouldExecuteTools) return true;
    const args = llmResponse.toolCalls[0]?.arguments ?? {};
    return Boolean(args.should_notify ?? true);
  } catch {
    return true;
  }
}
