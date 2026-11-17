import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { RESOURCE_CLASSES, type ResourceClass } from "./job-policy-registry.js";
import { observeWorker, type AdmissionRejectReason, type WorkerObserver } from "./worker-observability.js";

export interface WorkerConcurrencyOptions {
  maxActiveJobs?: number;
  resourceLimits?: Partial<Readonly<Record<ResourceClass, number>>>;
  localModelConcurrency?: number;
  cloudModelConcurrency?: number;
  embeddingRequestConcurrency?: number;
  embeddingBatchSize?: number;
}
export interface WorkerConcurrencyLimits {
  readonly maxActiveJobs: number;
  readonly maxBackgroundJobs: number;
  readonly interactiveReservedSlots: number;
  readonly resourceLimits: Readonly<Record<ResourceClass, number>>;
  readonly localModelConcurrency: number;
  readonly cloudModelConcurrency: number;
  readonly embeddingRequestConcurrency: number;
  readonly embeddingBatchSize: number;
}
export interface ProviderRequirement { key: string; limit: number }
/** Opaque, process-local keys used only to wake the waiters of a changed capacity. */
export function workerCapacityKey(kind: "global" | "background" | "resource" | "scope" | "embedding_request" | "provider", key?: string): string {
  return JSON.stringify([kind, key ?? null]);
}
export interface WorkerRequirements {
  resourceClass: ResourceClass;
  providers: readonly ProviderRequirement[];
  scopeKeys: readonly string[];
  embedding?: boolean;
  /** Persisted scheduling lane; only interactive may use the reserved slot. */
  queueLane?: string;
}
export interface WorkerPermit {
  release(): void;
  run<T>(operation: () => T): T;
}
export interface PreparedWorkerExecution {
  providers: readonly ProviderRequirement[];
  embedding?: boolean;
  /** Opaque fingerprint of the entire model snapshot; never log credentials. */
  batchKey?: string;
  run<T>(operation: () => T): T;
}
export interface WorkerProviderDescriptor {
  readonly providers: readonly ProviderRequirement[];
  readonly local: boolean;
}
interface ReservationGroup {
  providers: readonly ProviderRequirement[];
  embedding: boolean;
  resourceClass: ResourceClass;
  members: number;
  logicalJobs: number;
  activeRequests: number;
  serial: Map<string, Promise<unknown>>;
}
interface PermitState {
  requirements: WorkerRequirements;
  logicalJobs: number;
  released: boolean;
  group: ReservationGroup;
}
const defaults: WorkerConcurrencyLimits = Object.freeze({
  maxActiveJobs: 4, maxBackgroundJobs: 3, interactiveReservedSlots: 1,
  resourceLimits: Object.freeze({ summary: 4, embedding: 4, evolution_llm: 4, database: 1, scan: 1 }),
  localModelConcurrency: 1, cloudModelConcurrency: 2, embeddingRequestConcurrency: 1, embeddingBatchSize: 16
});
function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 1024) {
    throw new RangeError(`${name} must be an integer between 1 and 1024`);
  }
  return Number(value);
}
export function resolveWorkerConcurrencyOptions(
  options: WorkerConcurrencyOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env
): WorkerConcurrencyLimits {
  const number = (key: Exclude<keyof WorkerConcurrencyOptions, "resourceLimits">, name: string) => {
    const raw = options[key] ?? (env[name] === undefined ? defaults[key] : Number(env[name]));
    return positive(raw, key);
  };
  let resources: unknown = options.resourceLimits;
  if (resources === undefined && env.MEMMY_WORKER_RESOURCE_LIMITS !== undefined) {
    try { resources = JSON.parse(env.MEMMY_WORKER_RESOURCE_LIMITS); }
    catch { throw new TypeError("MEMMY_WORKER_RESOURCE_LIMITS must be a JSON object"); }
  }
  if (resources !== undefined && (!resources || typeof resources !== "object" || Array.isArray(resources))) {
    throw new TypeError("resourceLimits must be an object");
  }
  const resourceLimits = { ...defaults.resourceLimits };
  for (const [key, value] of Object.entries(resources ?? {})) {
    if (!(RESOURCE_CLASSES as readonly string[]).includes(key)) throw new TypeError(`Unknown resource class: ${key}`);
    resourceLimits[key as ResourceClass] = positive(value, `resourceLimits.${key}`);
  }
  const maxActiveJobs = number("maxActiveJobs", "MEMMY_WORKER_MAX_ACTIVE_JOBS");
  // A single-slot configuration must still permit background progress.
  const interactiveReservedSlots = maxActiveJobs > 1 ? 1 : 0;
  return Object.freeze({
    maxActiveJobs, interactiveReservedSlots, maxBackgroundJobs: maxActiveJobs - interactiveReservedSlots,
    resourceLimits: Object.freeze(resourceLimits),
    localModelConcurrency: number("localModelConcurrency", "MEMMY_WORKER_LOCAL_MODEL_CONCURRENCY"),
    cloudModelConcurrency: number("cloudModelConcurrency", "MEMMY_WORKER_CLOUD_MODEL_CONCURRENCY"),
    embeddingRequestConcurrency: number("embeddingRequestConcurrency", "MEMMY_WORKER_EMBEDDING_REQUEST_CONCURRENCY"),
    embeddingBatchSize: number("embeddingBatchSize", "MEMMY_WORKER_EMBEDDING_BATCH_SIZE")
  });
}

/** Provider identity omits credentials, query parameters, headers and user text. */
export function providerDescriptor(config: {
  provider?: string; sourceProvider?: string; endpoint?: string; model?: string; mode?: string;
  actualModelContext?: { source?: string };
}, limits: Pick<WorkerConcurrencyLimits, "localModelConcurrency" | "cloudModelConcurrency"> = defaults): WorkerProviderDescriptor {
  const source = (config.sourceProvider || config.provider || "unknown").trim().toLowerCase();
  const defaultEndpoints: Readonly<Record<string, string>> = {
    openai_compatible: "https://api.openai.com/v1", openai_responses: "https://api.openai.com/v1", gemini: "https://generativelanguage.googleapis.com/v1beta",
    anthropic: "https://api.anthropic.com/v1/messages", cohere: "https://api.cohere.com/v2/embed",
    voyage: "https://api.voyageai.com/v1/embeddings", mistral: "https://api.mistral.ai/v1/embeddings"
  };
  let endpoint = (config.endpoint || defaultEndpoints[config.provider ?? ""] || "").trim().replace(/\/+$/, "");
  // Mirror HttpLlmClient's actual URL construction before deriving the root:
  // a bare Anthropic base and its default /v1/messages endpoint send to the
  // same place, while an explicit /v1 base actually sends /v1/v1/messages.
  if (config.provider === "anthropic" && !endpoint.endsWith("/v1/messages")) endpoint += "/v1/messages";
  let hostname = "";
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      hostname = url.hostname.toLowerCase();
      if (hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname)) url.hostname = "localhost";
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      if (config.provider === "openai_compatible") url.pathname = url.pathname.replace(/\/(?:chat\/completions|embeddings)\/?$/, "");
      if (config.provider === "openai_responses") url.pathname = url.pathname.replace(/\/responses\/?$/, "");
      // Native Mistral embeddings share the API service with compatible chat.
      // Keep the host and preceding base path so independent proxies stay separate.
      if (config.provider === "mistral") url.pathname = url.pathname.replace(/\/embeddings\/?$/, "");
      if (config.provider === "anthropic") url.pathname = url.pathname.replace(/\/messages\/?$/, "");
      endpoint = url.toString().replace(/\/+$/, "");
    } catch { throw new TypeError("Invalid model provider endpoint"); }
  }
  const local = config.actualModelContext?.source !== "account" && (config.mode === "local"
    || ["local", "local_only", "lmstudio", "lm_studio", "ollama"].includes(source)
    || hostname === "localhost" || hostname === "[::1]" || hostname === "::1" || /^127\./.test(hostname));
  const limit = local ? limits.localModelConcurrency : limits.cloudModelConcurrency;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const root = `provider:${hash(endpoint || source)}`;
  return Object.freeze({ local, providers: Object.freeze([
    Object.freeze({ key: root, limit }),
    Object.freeze({ key: `${root}:model:${hash(config.model ?? "default")}`, limit })
  ]) });
}

/** Unlike bounded audit hashes, batching identity must include every config byte. */
export function workerModelBatchKey(configs: readonly unknown[]): string {
  const serialized = JSON.stringify(configs, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, (value as Record<string, unknown>)[key]]));
  });
  return createHash("sha256").update(serialized).digest("hex");
}

/** In-process admission only: failed acquisition never holds any partial permit. */
export class WorkerConcurrencyController {
  readonly limits: WorkerConcurrencyLimits;
  private activeJobs = 0;
  private backgroundActiveJobs = 0;
  private readonly resources = new Map<ResourceClass, number>();
  private readonly providers = new Map<string, Map<ReservationGroup, number>>();
  private readonly scopes = new Set<string>();
  private embeddingRequests = 0;
  private readonly states = new WeakMap<WorkerPermit, PermitState>();
  private readonly context = new AsyncLocalStorage<PermitState | undefined>();
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(resources: readonly string[]) => void>();
  private readonly groups = new Set<ReservationGroup>();
  private readonly observers = new Set<WorkerObserver>();
  private closing = false;
  private closed?: Promise<void>;
  private resolveClosed?: () => void;

  constructor(options: WorkerConcurrencyOptions = {}, env: Readonly<Record<string, string | undefined>> = process.env) {
    this.limits = resolveWorkerConcurrencyOptions(options, env);
  }
  availableJobs(): number { return Math.max(0, this.limits.maxActiveJobs - this.activeJobs); }
  observe(observer: WorkerObserver): () => void {
    this.observers.add(observer);
    this.observeConcurrency();
    return () => { this.observers.delete(observer); };
  }
  hasActivePermit(): boolean {
    const state = this.context.getStore();
    return state !== undefined && !state.released;
  }
  hasActiveWorkerPermit(): boolean {
    const state = this.context.getStore();
    return state !== undefined && !state.released && state.logicalJobs > 0;
  }
  /** Only a new router business boundary may discard a completed foreground
   * request's inherited ALS. Released worker permits remain fenced, including
   * their late callbacks; an active foreground reservation is never discarded. */
  runNewForegroundTask<T>(operation: () => T): T {
    const state = this.context.getStore();
    return state?.released && state.logicalJobs === 0
      ? this.context.run(undefined, operation)
      : operation();
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    this.closed = new Promise<void>(resolve => { this.resolveClosed = resolve; });
    this.notifyReleased();
    return this.closed;
  }
  subscribe(listener: (resources: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  snapshot() {
    return {
      activeJobs: this.activeJobs, availableJobs: this.availableJobs(),
      backgroundActiveJobs: this.backgroundActiveJobs, maxBackgroundJobs: this.limits.maxBackgroundJobs,
      interactiveReservedSlots: this.limits.interactiveReservedSlots,
      resources: Object.fromEntries(this.resources),
      providers: Object.fromEntries([...this.providers].map(([key, groups]) => [key, groups.size])),
      scopeKeys: [...this.scopes], embeddingRequests: this.embeddingRequests
    };
  }
  tryAcquire(requirements: WorkerRequirements, logicalJobs = 1, shareWith?: WorkerPermit,
    onBlocked?: (resource: string) => void): WorkerPermit | undefined {
    positive(logicalJobs, "logicalJobs");
    return this.acquire(requirements, logicalJobs, shareWith, onBlocked);
  }
  private acquire(input: WorkerRequirements, logicalJobs: number, shareWith?: WorkerPermit,
    onBlocked?: (resource: string) => void): WorkerPermit | undefined {
    const reject = (reason: AdmissionRejectReason, resource?: string): undefined => {
      if (resource) onBlocked?.(resource);
      for (const observer of this.observers) observeWorker(observer, { type: "admission_rejected", reason });
      return undefined;
    };
    if (this.closing) return reject("closing");
    if (!(RESOURCE_CLASSES as readonly string[]).includes(input.resourceClass)) throw new TypeError("Unknown resource class");
    const providerMap = new Map<string, number>();
    for (const provider of input.providers) {
      if (!provider.key?.trim()) throw new TypeError("Provider key is required");
      const limit = positive(provider.limit, "provider limit");
      providerMap.set(provider.key, Math.min(providerMap.get(provider.key) ?? limit, limit));
    }
    const providers = [...providerMap].sort(([a], [b]) => a.localeCompare(b)).map(([key, limit]) => ({ key, limit }));
    const scopeKeys = [...new Set(input.scopeKeys)];
    if (scopeKeys.some(key => typeof key !== "string" || !key.trim())) throw new TypeError("Scope keys must be nonempty strings");
    const requirements: WorkerRequirements = { resourceClass: input.resourceClass, providers, scopeKeys, embedding: input.embedding === true, queueLane: input.queueLane };
    const parent = shareWith ? this.states.get(shareWith) : undefined;
    if (shareWith && (!parent || parent.released || parent.group.resourceClass !== "embedding" || input.resourceClass !== "embedding"
      || !parent.group.embedding || !input.embedding || JSON.stringify(parent.group.providers) !== JSON.stringify(providers))) return reject("share_invalid");
    if (input.resourceClass === "embedding" && input.embedding &&
      logicalJobs + (parent?.group.logicalJobs ?? 0) > this.limits.embeddingBatchSize) return reject("batch");
    if (logicalJobs > this.availableJobs()) return reject("global", workerCapacityKey("global"));
    // Charge every logical member independently, including shared embedding batches.
    // Missing/unknown lanes do not gain interactive privilege; foreground calls charge zero.
    const backgroundJobs = input.queueLane === "interactive" ? 0 : logicalJobs;
    if (this.backgroundActiveJobs + backgroundJobs > this.limits.maxBackgroundJobs) return reject("background", workerCapacityKey("background"));
    if ((this.resources.get(input.resourceClass) ?? 0) + logicalJobs > this.limits.resourceLimits[input.resourceClass]) return reject("resource", workerCapacityKey("resource", input.resourceClass));
    const heldScope = scopeKeys.find(key => this.scopes.has(key));
    if (heldScope) return reject("scope", workerCapacityKey("scope", heldScope));
    if (!parent) {
      if (requirements.embedding && this.embeddingRequests >= this.limits.embeddingRequestConcurrency) return reject("embedding_request", workerCapacityKey("embedding_request"));
      for (const provider of providers) {
        const active = this.providers.get(provider.key);
        const cap = Math.min(provider.limit, ...active?.values() ?? []);
        if ((active?.size ?? 0) >= cap) return reject("provider", workerCapacityKey("provider", provider.key));
      }
    }
    const group: ReservationGroup = parent?.group ?? { providers, embedding: requirements.embedding === true,
      resourceClass: input.resourceClass, members: 0, logicalJobs: 0, activeRequests: 0, serial: new Map() };
    if (!parent) {
      this.groups.add(group);
      for (const provider of providers) {
        const active = this.providers.get(provider.key) ?? new Map<ReservationGroup, number>();
        active.set(group, provider.limit); this.providers.set(provider.key, active);
      }
      if (group.embedding) this.embeddingRequests++;
    }
    group.members++;
    group.logicalJobs += logicalJobs;
    this.activeJobs += logicalJobs;
    this.backgroundActiveJobs += backgroundJobs;
    this.resources.set(input.resourceClass, (this.resources.get(input.resourceClass) ?? 0) + logicalJobs);
    for (const key of scopeKeys) this.scopes.add(key);
    const state: PermitState = { requirements, logicalJobs, released: false, group };
    const permit: WorkerPermit = {
      run: operation => { if (state.released) throw new Error("Worker permit already released"); return this.context.run(state, operation); },
      release: () => {
        if (state.released) return;
        state.released = true;
        group.logicalJobs -= logicalJobs;
        this.activeJobs -= logicalJobs;
        this.backgroundActiveJobs -= backgroundJobs;
        const count = (this.resources.get(input.resourceClass) ?? 0) - logicalJobs;
        if (count) this.resources.set(input.resourceClass, count); else this.resources.delete(input.resourceClass);
        for (const key of scopeKeys) this.scopes.delete(key);
        group.members--;
        const freed = scopeKeys.map(key => workerCapacityKey("scope", key));
        if (logicalJobs > 0) freed.push(workerCapacityKey("global"), workerCapacityKey("resource", input.resourceClass));
        if (backgroundJobs > 0) freed.push(workerCapacityKey("background"));
        this.notifyReleased([...freed, ...this.releaseGroupIfIdle(group)]);
      }
    };
    this.states.set(permit, state);
    this.observeConcurrency();
    return permit;
  }

  private observeConcurrency(): void {
    if (this.observers.size === 0) return;
    const state = {
      activeJobs: this.activeJobs, maxActiveJobs: this.limits.maxActiveJobs,
      backgroundActiveJobs: this.backgroundActiveJobs, maxBackgroundJobs: this.limits.maxBackgroundJobs,
      interactiveReservedSlots: this.limits.interactiveReservedSlots,
      resources: Object.fromEntries(this.resources), resourceLimits: this.limits.resourceLimits,
      providers: [...this.providers].map(([key, groups]) => ({ key, active: groups.size, limit: Math.min(...groups.values()) })),
      embeddingRequests: this.embeddingRequests, embeddingRequestLimit: this.limits.embeddingRequestConcurrency
    };
    for (const observer of this.observers) observeWorker(observer, { type: "concurrency", state });
  }

  private releaseGroupIfIdle(group: ReservationGroup): string[] {
    if (group.members || group.activeRequests || !this.groups.delete(group)) return [];
    for (const provider of group.providers) {
      const active = this.providers.get(provider.key)!;
      active.delete(group); if (active.size === 0) this.providers.delete(provider.key);
    }
    if (group.embedding) this.embeddingRequests--;
    return [...group.providers.map(provider => workerCapacityKey("provider", provider.key)),
      ...(group.embedding ? [workerCapacityKey("embedding_request")] : [])];
  }

  private notifyReleased(resources: readonly string[] = []): void {
    this.observeConcurrency();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    for (const listener of this.listeners) {
      try { listener(resources); } catch { /* Observers cannot prevent resource release. */ }
    }
    if (this.closing && this.activeJobs === 0 && this.groups.size === 0) this.resolveClosed?.();
  }

  /** Reserve once per task; serialize internal calls using the shared group, never acquire our own slot twice. */
  async runRequest<T>(descriptor: WorkerProviderDescriptor, operation: () => Promise<T>, embedding = false): Promise<T> {
    const state = this.context.getStore();
    if (state) {
      const owned = new Set(state.group.providers.map(provider => provider.key));
      if (state.released || descriptor.providers.some(provider => !owned.has(provider.key)) || (embedding && !state.group.embedding)) {
        throw new Error("Model provider request was not admitted by the worker permit");
      }
      const keys = descriptor.providers.map(provider => provider.key);
      if (embedding) keys.push("embedding-request");
      const previous = [...new Set(keys.map(key => state.group.serial.get(key)).filter(Boolean))];
      const request = Promise.all(previous.map(promise => promise!.catch(() => {}))).then(async () => {
        if (state.released) throw new Error("Worker permit released before model request started");
        state.group.activeRequests++;
        try { return await operation(); }
        finally {
          state.group.activeRequests--;
          if (state.group.members === 0) {
            this.notifyReleased(this.releaseGroupIfIdle(state.group));
          }
        }
      });
      const settled = request.then(() => {}, () => {});
      for (const key of keys) state.group.serial.set(key, settled);
      try { return await request; }
      finally { for (const key of keys) if (state.group.serial.get(key) === settled) state.group.serial.delete(key); }
    }
    // Foreground operations share provider/request caps but consume no background job slots.
    const requirements: WorkerRequirements = { resourceClass: embedding ? "embedding" : "summary", providers: descriptor.providers, scopeKeys: [], embedding };
    for (;;) {
      if (this.closing) throw new Error("Model request admission is closed");
      const permit = this.acquire(requirements, 0);
      if (permit) {
        try { return await permit.run(operation); } finally { permit.release(); }
      }
      await new Promise<void>(resolve => this.waiters.add(resolve));
    }
  }
}
