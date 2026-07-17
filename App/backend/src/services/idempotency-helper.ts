/** Idempotency helper module. */
import { createHash } from "node:crypto";
import type { ApiErrorCode } from "@memmy/local-api-contracts";
import type { ZodType } from "zod";
import type { IdempotencyStore } from "../infrastructure/idempotency-store/index.js";

/** Type definition for duplicate response. */
export type DuplicateResponse<T> = T & { duplicate: true };

/** Contract for with idempotency options. */
export interface WithIdempotencyOptions<Input, Output> {
  store: IdempotencyStore;
  adapterId: string;
  requestId?: string;
  body: Input;
  responseSchema: ZodType<Output>;
}

/** Type definition for with idempotency result. */
export type WithIdempotencyResult<Output> =
  | { kind: "executed"; response: Output }
  | { kind: "duplicate"; response: DuplicateResponse<Output> };

/** Implementation of idempotency body mismatch error. */
export class IdempotencyBodyMismatchError extends Error {
  public readonly code: ApiErrorCode = "idempotency_body_mismatch";

  constructor() {
    super("idempotency body mismatch");
    this.name = "IdempotencyBodyMismatchError";
  }
}

/** Implementation of missing idempotency key error. */
export class MissingIdempotencyKeyError extends Error {
  public readonly code: ApiErrorCode = "missing_idempotency_key";

  constructor() {
    super("missing idempotency key");
    this.name = "MissingIdempotencyKeyError";
  }
}

/** Handles with idempotency. */
export async function withIdempotency<Input, Output>(
  opts: WithIdempotencyOptions<Input, Output>,
  handler: () => Promise<Output>
): Promise<WithIdempotencyResult<Output>> {
  if (!opts.adapterId || !opts.requestId) {
    const result = await handler();
    const parsed = opts.responseSchema.parse(result);
    return {
      kind: "executed",
      response: parsed
    };
  }

  const bodyHash = createHash("sha256").update(canonicalJson(opts.body)).digest("hex");
  const hit = opts.store.lookup(opts.adapterId, opts.requestId);

  if (hit && hit.bodyHash === bodyHash) {
    const response = opts.responseSchema.parse(JSON.parse(hit.responseJson));
    return {
      kind: "duplicate",
      response: {
        ...response,
        duplicate: true
      }
    };
  }

  if (hit && hit.bodyHash !== bodyHash) {
    throw new IdempotencyBodyMismatchError();
  }

  const result = await handler();
  const parsed = opts.responseSchema.parse(result);
  opts.store.save({
    adapterId: opts.adapterId,
    requestId: opts.requestId,
    bodyHash,
    responseJson: JSON.stringify(parsed),
    statusCode: 200
  });

  return {
    kind: "executed",
    response: parsed
  };
}

/** Checks canonical json. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** Handles sort value. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)])
    );
  }

  return value;
}
