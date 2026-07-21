import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryHttpServer, type MemoryService } from "../src/index.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe("Memory HTTP startup", () => {
  it("serves health before startup reconciliation begins", async () => {
    let reconciliations = 0;
    const server = createMemoryHttpServer({
      service: stubService(() => {
        reconciliations += 1;
      }),
      workerStartupFallbackMs: 1_000,
      workerPostHealthDelayMs: 250
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/v1/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(reconciliations).toBe(0);
    await waitFor(() => reconciliations === 1);
  });

  it("starts the worker after a fallback delay when no health probe arrives", async () => {
    let reconciliations = 0;
    const server = createMemoryHttpServer({
      service: stubService(() => {
        reconciliations += 1;
      }),
      workerStartupFallbackMs: 20,
      workerPostHealthDelayMs: 0
    });
    servers.push(server);
    await listen(server);

    expect(reconciliations).toBe(0);
    await waitFor(() => reconciliations === 1);
  });

  it("yields to the event loop between startup worker batches", async () => {
    let runs = 0;
    let timerFired = false;
    let timerObservedBeforeSecondRun = false;
    const service = stubService(() => undefined);
    service.runWorkerOnce = async () => {
      runs += 1;
      if (runs === 1) {
        setTimeout(() => {
          timerFired = true;
        }, 0);
        return workerResult(1);
      }
      timerObservedBeforeSecondRun = timerFired;
      return workerResult(0);
    };
    const server = createMemoryHttpServer({
      service,
      workerStartupFallbackMs: 0,
      workerPostHealthDelayMs: 0
    });
    servers.push(server);
    await listen(server);

    await waitFor(() => runs >= 2);
    expect(timerObservedBeforeSecondRun).toBe(true);
  });
});

function stubService(reconcile: () => void): MemoryService {
  return {
    health() {
      return { ok: true };
    },
    reconcileWorkerStartup: reconcile,
    async runWorkerOnce() {
      return workerResult(0);
    },
    nextWorkerRunAt() {
      return undefined;
    }
  } as unknown as MemoryService;
}

function workerResult(leased: number): Awaited<ReturnType<MemoryService["runWorkerOnce"]>> {
  return {
    leased,
    succeeded: 0,
    failed: 0,
    jobs: leased > 0
      ? [{ jobId: "startup-job", jobType: "embedding", status: "succeeded" }]
      : [],
    embeddingRetries: {
      leased: 0,
      succeeded: 0,
      failed: 0,
      items: []
    },
    changeSeq: 0,
    syncCursor: "0",
    serverTime: new Date().toISOString()
  };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
