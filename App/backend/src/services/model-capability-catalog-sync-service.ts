import type { ModelCapabilityCatalog } from "@memmy/local-api-contracts";
import type { CloudClient } from "../adapters/outbound/cloud-client/index.js";
import { readModelCapabilityCatalog, writeModelCapabilityCatalog } from "../infrastructure/model-capability-catalog/index.js";

export type ModelCapabilityCatalogSyncResult =
  | { status: "updated" | "not-modified"; catalog: ModelCapabilityCatalog }
  | { status: "failed"; reason: "retries-exhausted" | "unauthenticated" | "stopped"; catalog: ModelCapabilityCatalog | null; error: unknown };

export interface ModelCapabilityCatalogSyncService {
  sync(): Promise<ModelCapabilityCatalogSyncResult>;
  start(): void;
  stop(): Promise<void>;
}

export function createModelCapabilityCatalogSyncService(options: {
  cloudClient: Pick<CloudClient, "getModelCapabilityCatalog">;
  getCloudUuid(): string | null;
  filePath?: string;
  onUpdated?: (catalog: ModelCapabilityCatalog) => void;
}): ModelCapabilityCatalogSyncService {
  let inFlight: Promise<ModelCapabilityCatalogSyncResult> | undefined;
  let started = false;
  let stopped = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cancelRetry: (() => void) | undefined;

  async function attempt(): Promise<ModelCapabilityCatalogSyncResult> {
    try {
      const local = await readModelCapabilityCatalog(options.filePath);
      if (stopped) return failure("stopped", new Error("Model catalog synchronization stopped"));
      const uuid = options.getCloudUuid();
      if (!uuid?.trim()) return failure("unauthenticated", new Error("Model catalog requires an account credential"));
      const result = await options.cloudClient.getModelCapabilityCatalog({
        uuid,
        ...(local ? { catalogVersion: local.catalogVersion } : {})
      });
      if (stopped) return failure("stopped", new Error("Model catalog synchronization stopped"));
      if (result.status === "updated") {
        const catalog = await writeModelCapabilityCatalog(result.catalog, options.filePath);
        options.onUpdated?.(catalog);
        return { status: "updated", catalog };
      }
      // A 304 cannot validate a file removed or replaced while the request was in flight.
      const current = await readModelCapabilityCatalog(options.filePath);
      if (!local || !current || current.catalogVersion !== local.catalogVersion) {
        throw new Error("Model catalog changed locally during conditional retrieval");
      }
      return { status: "not-modified", catalog: current };
    } catch (error) {
      return failure("retries-exhausted", error);
    }
  }

  async function failure(reason: Extract<ModelCapabilityCatalogSyncResult, { status: "failed" }>["reason"], error: unknown): Promise<ModelCapabilityCatalogSyncResult> {
    const catalog = await readModelCapabilityCatalog(options.filePath).catch(() => null);
    return { status: "failed", reason, catalog, error };
  }

  async function synchronize(): Promise<ModelCapabilityCatalogSyncResult> {
    const delays = [5_000, 10_000, 30_000];
    for (let index = 0; ; index++) {
      if (stopped) return failure("stopped", new Error("Model catalog synchronization stopped"));
      const result = await attempt();
      if (result.status !== "failed" || result.reason === "unauthenticated") return result;
      if (stopped) return { ...result, reason: "stopped" };
      const delay = delays[index];
      if (delay === undefined) return result;
      await new Promise<void>((resolve) => {
        cancelRetry = resolve;
        retryTimer = setTimeout(resolve, delay);
      });
      retryTimer = undefined;
      cancelRetry = undefined;
    }
  }

  async function refreshAutomatically(): Promise<void> {
    const result = await service.sync();
    if (result.status === "failed" && result.reason !== "stopped") {
      console.warn(result.catalog
        ? "Model catalog synchronization failed; retaining the valid local catalog"
        : "Model catalog unavailable; continuing without a valid catalog");
    }
    if (!stopped) {
      refreshTimer = setTimeout(() => { void refreshAutomatically(); }, 300_000 + Math.floor(Math.random() * 60_001));
      refreshTimer.unref();
    }
  }

  const service: ModelCapabilityCatalogSyncService = {
    sync() {
      inFlight ??= synchronize().finally(() => { inFlight = undefined; });
      return inFlight;
    },
    start() {
      if (started || stopped) return;
      started = true;
      void refreshAutomatically();
    },
    async stop() {
      stopped = true;
      clearTimeout(refreshTimer);
      clearTimeout(retryTimer);
      cancelRetry?.();
      await inFlight;
    }
  };
  return service;
}
