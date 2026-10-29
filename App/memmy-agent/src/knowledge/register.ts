import { KnowledgeRecall, createLocalKnowledgeClient } from "@memmy/knowledge";
import { AgentHook, type AgentHookContext } from "../core/agent-runtime/hook.js";

/** Host adapter: only bridges the public Agent lifecycle into the knowledge module. */
export function createKnowledgeHook(runtimeFile?: string): AgentHook {
  const recall = new KnowledgeRecall(createLocalKnowledgeClient(runtimeFile));
  return new (class extends AgentHook {
    override async beforeRun(context: AgentHookContext): Promise<void> {
      await recall.beforeRun(context);
    }
    override async afterRun(context: AgentHookContext): Promise<void> {
      recall.afterRun(context);
    }
  })();
}
