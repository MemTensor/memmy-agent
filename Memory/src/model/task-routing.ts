import { AsyncLocalStorage } from "node:async_hooks";
import { embeddingIdentity, rememberEmbeddingIdentity } from "./embedding-identity.js";
import type { MemmyConfig } from "../config/index.js";
import { providerDescriptor, type WorkerConcurrencyController } from "../service/worker/worker-concurrency.js";
import { observeWorker, type WorkerObserver } from "../service/worker/worker-observability.js";
import type {
  Embedder,
  LlmClient,
  LlmCompletionOptions,
  LlmMessage,
  ModelStatus
} from "./types.js";

export type MemoryModelRole = "summary" | "evolution";

export interface MemoryModelTaskContext {
  config: MemmyConfig;
  summary: LlmClient;
  evolution: LlmClient;
  embedding: Embedder;
}

export class MemoryModelTaskRouter {
  private readonly storage = new AsyncLocalStorage<MemoryModelTaskContext>();
  private readonly lifecycle = new AsyncLocalStorage<object>();
  private readonly activeTasks = new Set<object>();
  private closing = false;
  private stopped?: Promise<void>;
  private resolveStopped?: () => void;

  constructor(
    private readonly resolveContext: () => MemoryModelTaskContext,
    private readonly concurrency?: WorkerConcurrencyController,
    private readonly observer?: WorkerObserver
  ) {}

  client(role: MemoryModelRole): LlmClient {
    return new TaskRoutedLlmClient(role, this);
  }

  embedder(): Embedder {
    return new TaskRoutedEmbedder(this);
  }

  currentOrResolve(): MemoryModelTaskContext {
    return this.storage.getStore() ?? this.resolveContext();
  }

  /** Resolve once before admission; execution must use precisely these delegates. */
  snapshot(): MemoryModelTaskContext {
    return Object.freeze({ ...this.resolveContext() });
  }

  runWith<T>(context: MemoryModelTaskContext, operation: () => T): T {
    // A worker may already own a claim while its execution microtask is queued.
    if (this.closing && !this.concurrency?.hasActiveWorkerPermit()) throw new Error("Model task router is closing");
    return this.track(() => this.storage.run(context, operation));
  }

  request<T>(config: LlmClient["config"] | Embedder["config"], operation: () => Promise<T>, embedding = false,
    kind: "summary" | "evolution" | "embedding" = embedding ? "embedding" : "summary", batchSize?: number): Promise<T> {
    if (!this.concurrency && !this.observer) return operation();
    const descriptor = providerDescriptor(config, this.concurrency?.limits);
    const measured = this.observer ? async () => {
      // Called only after actual request admission, never while waiting for a
      // provider permit. Delegate retries remain part of this logical request.
      const started = performance.now();
      let failure: "429" | "timeout" | "other" | undefined;
      try { return await operation(); }
      catch (error) {
        const status = error && typeof error === "object" && "httpStatus" in error ? error.httpStatus : undefined;
        const name = error instanceof Error ? error.name : "";
        failure = status === 429 ? "429" : /^(?:AbortError|TimeoutError)$/.test(name) ? "timeout" : "other";
        throw error;
      } finally {
        observeWorker(this.observer, { type: "model_request", kind,
          providerKey: descriptor.providers[0]!.key, modelKey: descriptor.providers.at(-1)!.key,
          durationMs: performance.now() - started, outcome: failure ? "failed" : "succeeded", failure, batchSize });
      }
    } : operation;
    return this.concurrency
      ? this.concurrency.runRequest(descriptor, measured, embedding)
      : measured();
  }

  embeddingBatchSize(): number {
    return this.concurrency?.limits.embeddingBatchSize ?? 16;
  }

  run<T>(operation: () => T): T {
    if (this.storage.getStore() && this.isActiveTask()) return operation();
    if (this.closing) throw new Error("Model task router is closing");
    const start = () => this.storage.run(this.resolveContext(), operation);
    return this.track(() => this.concurrency ? this.concurrency.runNewForegroundTask(start) : start());
  }

  assertCanStop(): void {
    // An admitted worker's reentry is checked by WorkerRunner first. A foreground
    // task must not await its own completion through service.stop either.
    if (this.isActiveTask() && !this.concurrency?.hasActiveWorkerPermit()) {
      throw new Error("Cannot stop Memory service from an active foreground model task");
    }
  }

  stop(): Promise<void> {
    this.assertCanStop();
    if (this.stopped) return this.stopped;
    this.closing = true;
    this.stopped = new Promise<void>(resolve => { this.resolveStopped = resolve; });
    if (this.activeTasks.size === 0) this.resolveStopped?.();
    return this.stopped;
  }

  private track<T>(operation: () => T): T {
    const token = {};
    this.activeTasks.add(token);
    const finish = () => {
      this.activeTasks.delete(token);
      if (this.closing && this.activeTasks.size === 0) this.resolveStopped?.();
    };
    try {
      const result = this.lifecycle.run(token, operation);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).then(finish, finish);
      } else finish();
      return result;
    } catch (error) { finish(); throw error; }
  }

  private isActiveTask(): boolean {
    const token = this.lifecycle.getStore();
    return token !== undefined && this.activeTasks.has(token);
  }
}

class TaskRoutedEmbedder implements Embedder {
  constructor(private readonly router: MemoryModelTaskRouter) {}

  get config() {
    return this.delegate().config;
  }

  isRemote(): boolean {
    return this.delegate().isRemote();
  }

  embed(texts: string[], role?: "query" | "document"): Promise<number[][]> {
    return this.router.run(async () => {
      if (texts.length === 0) return [];
      const delegate = this.delegate();
      const identity = embeddingIdentity(delegate.config);
      const batchSize = this.router.embeddingBatchSize();
      const vectors: number[][] = [];
      // A business task may generate many texts internally (for example Work
      // Memory retrieval). Limit actual requests without charging extra jobs.
      for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize);
        vectors.push(...await this.router.request(delegate.config, () => delegate.embed(batch, role), true, "embedding", batch.length));
      }
      return vectors.map(vector => rememberEmbeddingIdentity(vector, identity));
    });
  }

  embedOne(text: string, role?: "query" | "document"): Promise<number[]> {
    return this.router.run(async () => {
      const delegate = this.delegate();
      const identity = embeddingIdentity(delegate.config);
      const vector = await this.router.request(delegate.config, () => delegate.embedOne(text, role), true, "embedding", 1);
      return rememberEmbeddingIdentity(vector, identity);
    });
  }

  status(): ModelStatus {
    return this.delegate().status();
  }

  private delegate(): Embedder {
    return this.router.currentOrResolve().embedding;
  }
}

class TaskRoutedLlmClient implements LlmClient {
  constructor(
    private readonly role: MemoryModelRole,
    private readonly router: MemoryModelTaskRouter
  ) {}

  get config() {
    return this.delegate().config;
  }

  isConfigured(): boolean {
    return this.delegate().isConfigured();
  }

  complete(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<string> {
    return this.router.run(() => {
      const delegate = this.delegate();
      return this.router.request(delegate.config, () => delegate.complete(messages, options), false, this.role);
    });
  }

  completeJson<T extends Record<string, unknown>>(
    messages: LlmMessage[],
    options: LlmCompletionOptions
  ): Promise<T> {
    return this.router.run(() => {
      const delegate = this.delegate();
      return this.router.request(delegate.config, () => delegate.completeJson<T>(messages, options), false, this.role);
    });
  }

  status(): ModelStatus {
    return this.delegate().status();
  }

  private delegate(): LlmClient {
    return this.router.currentOrResolve()[this.role];
  }
}
