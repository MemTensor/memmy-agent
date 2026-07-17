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

      const modelId = resolveModelId(ctx);
      const provider = resolveProviderName(ctx, modelId, this.options.resolveProviderName);
      if (provider === ACCOUNT_PROVIDER) return;

      const event: ByokTokenUsageEvent = {
        id: randomUUID(),
        kind: "agent_chat",
        source: "agent",
        operationId: turnId,
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

function resolveModelId(ctx: AgentHookContext): string | null {
  return (
    stringOrNull(ctx.spec?.model) ??
    stringOrNull(ctx.spec?.provider?.getDefaultModel?.()) ??
    null
  );
}

function resolveProviderName(
  ctx: AgentHookContext,
  modelId: string | null,
  resolver: ((modelId: string | null) => string | null) | undefined,
): string {
  return stringOrNull(ctx.spec?.provider?.spec?.name) ?? stringOrNull(resolver?.(modelId)) ?? "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
