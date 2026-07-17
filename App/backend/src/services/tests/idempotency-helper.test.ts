/** Idempotency helper tests. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { IdempotencyHit, IdempotencyStore, SaveIdempotencyInput } from "../../infrastructure/idempotency-store/index.js";
import { IdempotencyBodyMismatchError, withIdempotency } from "../idempotency-helper.js";

const ResponseSchema = z.object({
  ok: z.literal(true),
  value: z.string()
});

describe("withIdempotency", () => {
  it("executes and stores the first request", async () => {
    const store = createFakeStore();
    let calls = 0;

    const result = await withIdempotency(
      {
        store,
        adapterId: "cursor/main",
        requestId: "req-1",
        body: { b: 2, a: 1 },
        responseSchema: ResponseSchema
      },
      async () => {
        calls += 1;
        return { ok: true as const, value: "created" };
      }
    );

    expect(result).toEqual({ kind: "executed", response: { ok: true, value: "created" } });
    expect(calls).toBe(1);
    expect(store.lookup("cursor/main", "req-1")).toMatchObject({
      responseJson: "{\"ok\":true,\"value\":\"created\"}",
      statusCode: 200
    });
  });

  it("replays duplicate requests with canonical body key ordering", async () => {
    const store = createFakeStore();
    await withIdempotency(
      {
        store,
        adapterId: "cursor/main",
        requestId: "req-1",
        body: { b: 2, a: 1 },
        responseSchema: ResponseSchema
      },
      async () => ({ ok: true as const, value: "created" })
    );

    const result = await withIdempotency(
      {
        store,
        adapterId: "cursor/main",
        requestId: "req-1",
        body: { a: 1, b: 2 },
        responseSchema: ResponseSchema
      },
      async () => {
        throw new Error("handler should not run");
      }
    );

    expect(result).toEqual({
      kind: "duplicate",
      response: { ok: true, value: "created", duplicate: true }
    });
  });

  it("throws IdempotencyBodyMismatchError for the same key with a different body", async () => {
    const store = createFakeStore();
    await withIdempotency(
      {
        store,
        adapterId: "cursor/main",
        requestId: "req-1",
        body: { value: "first" },
        responseSchema: ResponseSchema
      },
      async () => ({ ok: true as const, value: "created" })
    );

    await expect(
      withIdempotency(
        {
          store,
          adapterId: "cursor/main",
          requestId: "req-1",
          body: { value: "second" },
          responseSchema: ResponseSchema
        },
        async () => ({ ok: true as const, value: "created" })
      )
    ).rejects.toBeInstanceOf(IdempotencyBodyMismatchError);
  });

  it("does not save when the handler throws", async () => {
    const store = createFakeStore();

    await expect(
      withIdempotency(
        {
          store,
          adapterId: "cursor/main",
          requestId: "req-1",
          body: { value: "first" },
          responseSchema: ResponseSchema
        },
        async () => {
          throw new Error("memory down");
        }
      )
    ).rejects.toThrow("memory down");

    expect(store.lookup("cursor/main", "req-1")).toBeNull();
  });
});

function createFakeStore(): IdempotencyStore {
  const rows = new Map<string, IdempotencyHit>();

  return {
    lookup(adapterId, requestId) {
      return rows.get(`${adapterId}:${requestId}`) ?? null;
    },
    save(input: SaveIdempotencyInput) {
      const key = `${input.adapterId}:${input.requestId}`;
      if (rows.has(key)) {
        throw new Error("unique constraint failed");
      }

      rows.set(key, {
        bodyHash: input.bodyHash,
        responseJson: input.responseJson,
        statusCode: input.statusCode,
        createdAt: "2026-05-29T10:00:00.000Z"
      });
    },
    purgeBefore() {
      return 0;
    }
  };
}
