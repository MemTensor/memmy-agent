import type { TaskPlanState } from "../session/task-plan-state.js";

// A model's claim about a guard is not a runtime stop signal. Correct the
// specific premature handoff without turning every active checklist into a Goal.
const PREMATURE_HANDOFF = /连续调用守卫|停止重复(?:同一|相同)?调用|(?:不要|不能|禁止)以相同参数重复调用|运行时(?:保护|约束).{0,20}(?:停止|要求|重复)|(?:回|回复|说)[^\n。]{0,16}[「“"']继续|(?:reply|say)[^\n.]{0,24}["']?continue|(?:consecutive|repeated)[ -](?:tool[ -])?call guard/i;

function checkpointedWork(messages: Record<string, any>[]): { progress: string; taskId: string; pending: string[] } | null {
  const toolIndex = messages.findLastIndex(message => message.role === "tool");
  if (toolIndex < messages.findLastIndex(message => message.role === "user" && !message.internal_context)) return null;
  const latest = messages[toolIndex];
  if (typeof latest?.content !== "string") return null;
  let result: any;
  try { result = JSON.parse(latest.content); } catch { return null; }
  // review_resume wraps the resumed capability's data under data.result.
  const data = result?.data?.generation ? result.data : result?.data?.result;
  const generation = data?.generation;
  if (result?.ok !== true || data?.persisted !== true || typeof result.taskId !== "string"
    || generation?.mode !== "partial-host-model" || generation.checkpointed !== true || generation.safeToResume !== true
    || !Array.isArray(generation.pendingOutlineNodeIds) || !generation.pendingOutlineNodeIds.length
    || !generation.pendingOutlineNodeIds.every((id: unknown) => typeof id === "string")
    || generation.exhaustedFallbackOutlineNodeIds?.length || result.missingInputs?.some((item: any) => item.required)) return null;
  // Count saved work and bounded repair counters, never timestamps, call IDs,
  // or artifact hashes that can change merely because metadata was re-saved.
  const progress = JSON.stringify([result.taskId, generation.completedOutlineNodeIds, generation.pendingOutlineNodeIds,
    generation.paragraphProgress?.map((item: any) => [item.outlineNodeId, item.savedModelParagraphs, item.completed,
      item.pendingParagraphIds, item.continuityPassed, item.continuityAcceptedWithWarnings, item.retryBudget])]);
  return { progress, taskId: result.taskId, pending: generation.pendingOutlineNodeIds };
}

export function createTaskPlanContinuation(getPlan: () => TaskPlanState | null) {
  let previousProgress = "";
  let correctionsWithoutProgress = 0;
  return ({ finalContent, messages }: {
    finalContent: string;
    messages: Record<string, any>[];
  }): string | null => {
    const plan = getPlan();
    if (!PREMATURE_HANDOFF.test(finalContent)) return null;
    if (!plan) {
      const work = checkpointedWork(messages);
      if (!work) return null;
      if (work.progress !== previousProgress) correctionsWithoutProgress = 0;
      previousProgress = work.progress;
      if (++correctionsWithoutProgress > 2) return null;
      return "The latest successful tool result reports durable checkpointed work that is safe to resume. Identical tool arguments can advance saved state. "
        + "Reconcile the pending work with the user's requested scope; if finishing it is still authorized, continue from the checkpoint without asking for a routine 'continue'. "
        + "Reusing a tool for a new section or bounded repair is normal progress. Do not regenerate completed paragraphs or expand the user's scope. "
        + "Respect actual errors, cancellation, exhausted retries, approvals, and decisions reserved for the user. "
        + `Checkpoint: ${JSON.stringify({ taskId: work.taskId, pending: work.pending })}`;
    }
    if (plan.status !== "active") return null;
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
    const work = checkpointedWork(messages);
    const progress = JSON.stringify([plan.planId, plan.items.map(item => [item.id, item.status]), work?.progress, [...hashes].sort()]);
    if (progress !== previousProgress) correctionsWithoutProgress = 0;
    previousProgress = progress;
    if (++correctionsWithoutProgress > 2) return null;
    return "The execution checklist still has authorized unfinished work. Identical tool arguments can advance a durable checkpoint; compare semantic progress before treating repetition as a loop. "
      + "Checkpointed writing, bounded repairs, and moving to the next stage are normal progress, even when they reuse a tool. "
      + "Do not ask the user to say continue just to proceed. Inspect saved results, update the checklist, and execute the next unfinished item. "
      + "Respect actual tool errors, cancellation, approval requirements, and user decisions. If genuinely blocked or awaiting a decision, mark the item blocked and explain the concrete reason; do not invent a runtime guard. "
      + `Unfinished items: ${JSON.stringify(pending.map(item => ({ id: item.id, content: item.content })))}`;
  };
}
