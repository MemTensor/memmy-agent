import { randomUUID } from "node:crypto";
import { AgentHook, AgentHookContext } from "../../core/agent-runtime/hook.js";
import { normalizeByokTokenUsage } from "./normalizer.js";
import type { ByokTokenUsageEvent, ByokTokenUsageHookOptions } from "./types.js";

const ACCOUNT_PROVIDER = "memmy_account";

export class ByokTokenUsageHook extends AgentHook {
  private readonly options: ByokTokenUsageHookOptions;
  private readonly turnIdBySessionKey = new Map<string, string>();

  constructor(options: ByokTokenUsageHookOptions) {
    super(false);
    this.options = options;
  }

  override async beforeRun(ctx: AgentHookContext): Promise<void> {
    const sessionKey = sessionKeyFromContext(ctx);
    if (!sessionKey) return;
    this.turnIdBySessionKey.set(sessionKey, randomUUID());
  }

  override async afterRun(ctx: AgentHookContext, result: any): Promise<void> {
    const sessionKey = sessionKeyFromContext(ctx);
    if (!sessionKey) return;

    try {
      const turnId = this.turnIdBySessionKey.get(sessionKey);
      if (!turnId) return;

      const usage = normalizeByokTokenUsage(result?.usage ?? ctx.usage);
      if (!usage) return;

      const context = ctx.spec?.actualModelContext;
      if (!context || context.source !== "byok") return;
      const modelId = context.model;
      const provider = context.provider;
      if (!provider || provider === ACCOUNT_PROVIDER) return;

      const event: ByokTokenUsageEvent = {
        id: randomUUID(),
        kind: "agent_chat",
        source: "agent",
        operationId: turnId,
        presetId: context.presetId,
        provider,
        model: modelId,
        capability: "agent",
        ...usage,
        metadata: {
          sessionKey,
          turnId,
          provider,
          modelId,
        },
        createdAt: new Date().toISOString(),
      };

      await this.options.client.recordEvent(event);
    } catch (error) {
      console.error("BYOK token usage hook failed:", error);
    } finally {
      this.turnIdBySessionKey.delete(sessionKey);
    }
  }
}

function sessionKeyFromContext(ctx: AgentHookContext): string | null {
  return stringOrNull(ctx.spec?.sessionKey) ?? stringOrNull(ctx.sessionKey) ?? stringOrNull(ctx.session?.key);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
