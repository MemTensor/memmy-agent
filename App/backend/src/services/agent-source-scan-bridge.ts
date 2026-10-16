import type { AgentSourceScanInput, AgentSourceScanStatusResponse, MemoryAgentSourceScanState } from "@memmy/local-api-contracts";
import type { AgentSourceScanClient } from "../adapters/outbound/memory-client/types.js";
import { MemoryLayerError, memoryScanUnavailable } from "../adapters/outbound/memory-client/errors.js";
import type { ProgressBus } from "./progress-bus.js";

/** Transport and UI state only. All scan work and task ownership live in Memory. */
export function createAgentSourceScanBridge(client: AgentSourceScanClient | undefined, bus: ProgressBus, intervalMs = 500) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<MemoryAgentSourceScanState> | undefined;
  let lastProgress = "";
  let lastCompletion = "";
  const requireClient = () => {
    if (!client) throw new MemoryLayerError("memory_layer_unavailable", 503, "Memory scanning API is unavailable");
    return client;
  };
  function publish(state: MemoryAgentSourceScanState) {
    if (stopped || !state.jobId || !state.sourceId) return;
    if (state.progress && (state.running || state.progress.phase === "stopped")) {
      const progress = { ...state.progress, jobId: state.jobId };
      const key = JSON.stringify(progress);
      if (key !== lastProgress) {
        lastProgress = key;
        bus.emit("agent_source.scan_progress", progress);
      }
    }
    if (!state.running && state.completedAt && state.jobId !== lastCompletion) {
      lastCompletion = state.jobId;
      const results = state.results?.length ? state.results : [{
        sourceId: state.sourceId, discoveredConversations: 0, emittedMessages: 0, skipped: 0, errors: []
      }];
      if (state.error && !results.some((result) => result.errors.length)) {
        results[0] = { ...results[0]!, errors: [{ conversationId: "scan", reason: state.error }] };
      }
      bus.emit("agent_source.scan_completed", {
        jobId: state.jobId,
        sourceId: state.sourceId,
        results
      });
    }
  }
  async function snapshot() {
    if (!polling) polling = requireClient().status().then((state) => { publish(state); return state; }).finally(() => { polling = undefined; });
    return polling;
  }
  function schedule() {
    if (stopped || !client) return;
    timer = setTimeout(() => {
      // A transport failure must never create a successful completion or start a fallback scanner.
      void snapshot().catch(() => undefined).finally(schedule);
    }, intervalMs);
    timer.unref?.();
  }
  schedule();
  return {
    async start(input: AgentSourceScanInput) {
      const current = await snapshot();
      if (current.running && current.sourceId === input.sourceId && current.mode === (input.mode ?? null) && current.jobId) return { jobId: current.jobId };
      const job = await requireClient().start(input);
      await snapshot();
      return job;
    },
    async status(): Promise<AgentSourceScanStatusResponse> {
      let state: MemoryAgentSourceScanState;
      try {
        state = await snapshot();
      } catch (error) {
        const unavailable = memoryScanUnavailable(error);
        if (!unavailable) throw error;
        // This is an explicit unavailable state, never a successful completion.
        return { active: false, progress: null, unavailable };
      }
      return {
        active: state.running,
        progress: state.jobId && (state.running || state.progress?.phase === "stopped") ? {
          jobId: state.jobId,
          ...(state.progress ?? { sourceId: state.sourceId ?? "all", phase: "scan" as const, current: 0, total: 0 })
        } : null,
        ...(state.jobId && state.sourceId && state.completedAt ? { completion: {
          jobId: state.jobId, sourceId: state.sourceId, succeeded: !state.error, completedAt: state.completedAt
        } } : {})
      };
    },
    results: (jobId: string, cursor: string, limit: number) => requireClient().results(jobId, cursor, limit),
    async pause() { const result = await requireClient().pause(); await snapshot(); return result; },
    async cancel() { const result = await requireClient().cancel(); lastProgress = ""; return result; },
    async dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await polling?.catch(() => undefined);
      // Closing the desktop must not cancel a scan owned by the Memory service.
    }
  };
}

export type { AgentSourceScanClient } from "../adapters/outbound/memory-client/types.js";
