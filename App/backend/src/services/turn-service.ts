/** Turn service module. */
import {
  CompleteTurnOutputSchema,
  type CompleteTurnInput,
  type CompleteTurnOutput,
  type StartTurnInput,
  type StartTurnOutput
} from "@memmy/local-api-contracts";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { IdempotencyStore } from "../infrastructure/idempotency-store/index.js";
import { withIdempotency, type WithIdempotencyResult } from "./idempotency-helper.js";
import type { RuntimeContext } from "./runtime-context.js";

export interface TurnService {
  start(input: StartTurnInput, ctx: RuntimeContext): Promise<StartTurnOutput>;
  complete(
    turnId: string,
    input: CompleteTurnInput,
    ctx: RuntimeContext
  ): Promise<WithIdempotencyResult<CompleteTurnOutput>>;
}

export function createTurnService(deps: {
  memoryClient: MemoryClient;
  idempotencyStore: IdempotencyStore;
}): TurnService {
  return {
    async start(input, _ctx) {
      return deps.memoryClient.startTurn(input);
    },

    async complete(turnId, input, ctx) {
      return withIdempotency(
        {
          store: deps.idempotencyStore,
          adapterId: ctx.adapterId,
          requestId: ctx.requestId,
          body: input,
          responseSchema: CompleteTurnOutputSchema
        },
        () => deps.memoryClient.completeTurn({ ...input, turnId })
      );
    }
  };
}
