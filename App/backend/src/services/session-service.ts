/** Session service module. */
import {
  CloseSessionOutputSchema,
  OpenSessionOutputSchema,
  type CloseSessionInput,
  type CloseSessionOutput,
  type OpenSessionInput,
  type OpenSessionOutput
} from "@memmy/local-api-contracts";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { IdempotencyStore } from "../infrastructure/idempotency-store/index.js";
import { withIdempotency, type WithIdempotencyResult } from "./idempotency-helper.js";
import type { RuntimeContext } from "./runtime-context.js";

export interface SessionService {
  open(input: OpenSessionInput, ctx: RuntimeContext): Promise<WithIdempotencyResult<OpenSessionOutput>>;
  close(
    sessionId: string,
    input: CloseSessionInput,
    ctx: RuntimeContext
  ): Promise<WithIdempotencyResult<CloseSessionOutput>>;
}

export function createSessionService(deps: {
  memoryClient: MemoryClient;
  idempotencyStore: IdempotencyStore;
}): SessionService {
  return {
    async open(input, ctx) {
      return withIdempotency(
        {
          store: deps.idempotencyStore,
          adapterId: ctx.adapterId,
          requestId: ctx.requestId,
          body: input,
          responseSchema: OpenSessionOutputSchema
        },
        () => deps.memoryClient.openSession(input)
      );
    },

    async close(sessionId, input, ctx) {
      return withIdempotency(
        {
          store: deps.idempotencyStore,
          adapterId: ctx.adapterId,
          requestId: ctx.requestId,
          body: input,
          responseSchema: CloseSessionOutputSchema
        },
        () => deps.memoryClient.closeSession({ ...input, sessionId })
      );
    }
  };
}
