import type { TaskPlanState } from "../session/task-plan-state.js";

// A model's claim about a guard is not a runtime stop signal. Correct the
// specific premature handoff without turning every active checklist into a Goal.
const PREMATURE_HANDOFF = /连续调用守卫|停止重复调用|运行时保护.{0,20}(?:停止|要求)|(?:回|回复|说)[^\n。]{0,16}[「“"']继续|(?:reply|say)[^\n.]{0,24}["']?continue|(?:consecutive|repeated)[ -](?:tool[ -])?call guard/i;

export function createTaskPlanContinuation(getPlan: () => TaskPlanState | null) {
  let previousProgress = "";
  let correctionsWithoutProgress = 0;
  return ({ finalContent, messages }: {
    finalContent: string;
    messages: Record<string, any>[];
  }): string | null => {
    const plan = getPlan();
    if (!plan || plan.status !== "active" || !PREMATURE_HANDOFF.test(finalContent)) return null;
    if (plan.items.some(item => item.status === "blocked")) return null;
    const pending = plan.items.filter(item => item.status !== "completed");
    if (!pending.length) return null;

    // Only durable artifact hashes and item states count as progress. Calls,
    // timestamps, fresh IDs, and repeated status reads cannot reset this bound.
    const hashes = new Set<string>();
    for (const message of messages) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      for (const match of message.content.matchAll(/sha256:[a-f0-9]{64}/g)) hashes.add(match[0]);
    }
    const progress = JSON.stringify([plan.planId, plan.items.map(item => [item.id, item.status]), [...hashes].sort()]);
    if (progress !== previousProgress) correctionsWithoutProgress = 0;
    previousProgress = progress;
    if (++correctionsWithoutProgress > 2) return null;
    return "The execution checklist still has authorized unfinished work. This response has not been stopped by a consecutive-call guard. "
      + "Checkpointed writing, bounded repairs, and moving to the next stage are normal progress, even when they reuse a tool. "
      + "Do not ask the user to say continue just to proceed. Inspect saved results, update the checklist, and execute the next unfinished item. "
      + "Respect actual tool errors, cancellation, approval requirements, and user decisions. If genuinely blocked or awaiting a decision, mark the item blocked and explain the concrete reason; do not invent a runtime guard. "
      + `Unfinished items: ${JSON.stringify(pending.map(item => ({ id: item.id, content: item.content })))}`;
  };
}
