import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG, MemoryDb, MemoryService } from "../../src/index.js";
import { closeMemoryHttpServer, createMemoryHttpServer } from "../../src/server/http.js";
import { byokRuntimeConfig, createMemoryServiceFixture } from "../fixtures/memory-service-fixture.js";

const fixture = createMemoryServiceFixture();

afterEach(() => {
  fixture.cleanup();
});

describe("MemoryService budget reconcile lifecycle", () => {
  it("does not write or reject after stop when the constructor fetch is still pending", async () => {
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number }>();
    const { service, db } = createService(() => pending.promise);
    const closedAccesses = watchClosedDbAccess(db);
    const rejections = captureUnhandledRejections();

    await service.stop();
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);
    db.close();
    pending.resolve({ dailyUsed: 123, lifetimeUsed: 456 });
    await delay(20);

    expect(closedAccesses()).toBe(0);
    expect(rejections.splice(0)).toEqual([]);
    rejections.stop();
  });

  it("aborts the in-flight App fetch when stop is called", async () => {
    let seen: AbortSignal | undefined;
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number }>();
    const { service, db } = createService((signal) => {
      seen = signal;
      return pending.promise;
    });

    await service.stop();
    expect(seen?.aborted).toBe(true);
    db.close();
    pending.resolve({ dailyUsed: 1, lifetimeUsed: 1 });
    await delay(20);
  });

  it("does not write or wake after stop when reloadConfig fetch is still pending", async () => {
    let fetchImpl: (signal?: AbortSignal) => Promise<{ dailyUsed: number; lifetimeUsed: number } | null> = async () => null;
    const config = byokRuntimeConfig();
    const { service, db } = createService((signal) => fetchImpl(signal), {
      config,
      configLoader: () => ({ config })
    });
    await delay(0);
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number } | null>();
    fetchImpl = () => pending.promise;
    let settled = 0;
    service.setAppBudgetReconcileListener(() => {
      settled += 1;
    });

    const closedAccesses = watchClosedDbAccess(db);
    service.reloadConfig();
    await service.stop();
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(0);
    const rejections = captureUnhandledRejections();
    db.close();
    pending.resolve({ dailyUsed: 20_000_000, lifetimeUsed: 600_000_000 });
    await delay(20);

    expect(closedAccesses()).toBe(0);
    expect(settled).toBe(0);
    expect(rejections.splice(0)).toEqual([]);
    rejections.stop();
  });

  it("does not start another App fetch after stop", async () => {
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number } | null>();
    let fetches = 0;
    const config = byokRuntimeConfig();
    const { service, db } = createService(() => {
      fetches += 1;
      return pending.promise;
    }, {
      config,
      configLoader: () => ({ config })
    });

    await delay(0);
    expect(fetches).toBe(1);
    await service.stop();
    service.reloadConfig();
    expect(fetches).toBe(1);
    expect(service.nextWorkerRunAt()).toBeUndefined();
    pending.resolve(null);
    await service.stop();
    db.close();
  });

  it("keeps a completed reconcile and treats a second stop as a no-op", async () => {
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number }>();
    const { service, db } = createService(() => pending.promise);

    pending.resolve({ dailyUsed: 11, lifetimeUsed: 22 });
    await delay(20);
    expect(service.memoryTokenBudget()).toMatchObject({
      dailyUsed: 11,
      lifetimeUsed: 22
    });

    await service.stop();
    await service.stop();
    expect(service.memoryTokenBudget().lifetimeUsed).toBe(22);
    db.close();
  });

  it("does not reject when the pending fetch fails after stop", async () => {
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number }>();
    const { service, db } = createService(() => pending.promise);
    const closedAccesses = watchClosedDbAccess(db);
    const rejections = captureUnhandledRejections();

    await service.stop();
    db.close();
    pending.reject(new Error("injected budget fetch failure"));
    await delay(20);

    expect(closedAccesses()).toBe(0);
    expect(rejections.splice(0)).toEqual([]);
    rejections.stop();
  });

  it("closes HTTP, then service, then storage without writing a late budget response", async () => {
    const pending = deferred<{ dailyUsed: number; lifetimeUsed: number }>();
    const { service, db } = createService(() => pending.promise);
    const server = createMemoryHttpServer({
      service,
      workerStartupFallbackMs: 60_000,
      workerPostHealthDelayMs: 60_000
    });
    const closedAccesses = watchClosedDbAccess(db);
    const rejections = captureUnhandledRejections();
    await listen(server);

    await closeMemoryHttpServer(server);
    await service.stop();
    db.close();
    pending.resolve({ dailyUsed: 9, lifetimeUsed: 10 });
    await delay(20);

    expect(closedAccesses()).toBe(0);
    expect(rejections.splice(0)).toEqual([]);
    rejections.stop();
  });
});

function createService(
  fetchAppMemoryBudget: (signal?: AbortSignal) => Promise<{ dailyUsed: number; lifetimeUsed: number } | null>,
  options: {
    config?: typeof DEFAULT_MEMMY_CONFIG;
    configLoader?: ConstructorParameters<typeof MemoryService>[0]["configLoader"];
  } = {}
): {
  service: MemoryService;
  db: MemoryDb;
} {
  const root = fixture.createTestRoot();
  const db = new MemoryDb({ path: `${root}/memory.sqlite` });
  const service = fixture.createTestMemoryService({
    db,
    mode: "dev",
    config: options.config,
    configLoader: options.configLoader,
    fetchAppMemoryBudget
  });
  return { service, db };
}

function watchClosedDbAccess(db: MemoryDb): () => number {
  let closedDbAccesses = 0;
  db.db.prepare = new Proxy(db.db.prepare, {
    apply(prepare, receiver, args) {
      if (!db.db.open) {
        closedDbAccesses += 1;
      }
      return Reflect.apply(prepare, receiver, args);
    }
  });
  return () => closedDbAccesses;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function captureUnhandledRejections(): string[] & { stop(): void } {
  const errors: string[] & { stop(): void } = Object.assign([] as string[], {
    stop() {
      process.off("unhandledRejection", onRejection);
    }
  });
  const onRejection = (error: unknown) => {
    errors.push(error instanceof Error ? error.message : String(error));
  };
  process.on("unhandledRejection", onRejection);
  return errors;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}
