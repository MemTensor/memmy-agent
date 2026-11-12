import { acceptsScanUpdate, type ScanControlInput, agentSourceScanExecutionKey } from "@memmy/local-api-contracts";
import type { AgentSourceScanInput, AgentSourceScanStatusResponse, MemoryAgentSourceScanState } from "@memmy/local-api-contracts";
import type { AgentSourceScanClient } from "../adapters/outbound/memory-client/types.js";
import { MemoryLayerError, memoryScanUnavailable } from "../adapters/outbound/memory-client/errors.js";
import type { ProgressBus } from "./progress-bus.js";

/** Transport and UI state only. All scan work and task ownership live in Memory. */
export function createAgentSourceScanBridge(client: AgentSourceScanClient | undefined, bus: ProgressBus, intervalMs = 500) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<MemoryAgentSourceScanState> | undefined;
  let latest: MemoryAgentSourceScanState | undefined;
  let lastProgress = "";
  let lastCompletion = "";
  const requireClient = () => {
    if (!client) throw new MemoryLayerError("memory_layer_unavailable", 503, "Memory scanning API is unavailable");
    return client;
  };
  function identity(state: MemoryAgentSourceScanState) {
    return { version: state.version, status: state.status, jobId: state.jobId!, ...(state.attemptId ? { attemptId: state.attemptId } : {}),
      ...(state.startedAt ? { attemptStartedAt: state.startedAt } : {}) };
  }
  function desktopProgress(progress: NonNullable<MemoryAgentSourceScanState["progress"]>) {
    const phase = ["discover", "read", "redact", "emit", "prepare"].includes(progress.phase)
      ? "scan" as const : progress.phase as "scan" | "add" | "summarize" | "done" | "stopped";
    return { ...progress, phase };
  }
  function succeeded(state: MemoryAgentSourceScanState) {
    return !state.error && (state.results ?? []).every((result) => (result.errorCount ?? result.errors.length) === 0 && result.errors.length === 0);
  }
  function publish(state: MemoryAgentSourceScanState) {
    if (stopped || !state.jobId || !state.sourceId) return;
    if (state.progress && !state.completedAt && (state.running || state.progress.phase === "stopped")) {
      const progress = { ...desktopProgress(state.progress), ...identity(state), requestedSourceId: state.sourceId, ...(state.mode ? { mode: state.mode } : {}) };
      const key = JSON.stringify(progress);
      if (key !== lastProgress) {
        lastProgress = key;
        bus.emit("agent_source.scan_progress", progress);
      }
    }
    if (!state.running && state.completedAt && agentSourceScanExecutionKey(identity(state)) !== lastCompletion) {
      lastCompletion = agentSourceScanExecutionKey(identity(state));
      const results = state.results?.length ? state.results : [{
        sourceId: state.sourceId, discoveredConversations: 0, emittedMessages: 0, skipped: 0, errors: []
      }];
      if (state.error && !results.some((result) => result.errors.length)) {
        results[0] = { ...results[0]!, errors: [{ conversationId: "scan", reason: state.error }] };
      }
      bus.emit("agent_source.scan_completed", {
        ...identity(state),
        succeeded: succeeded(state),
        sourceId: state.sourceId,
        results
      });
    }
  }
  function receive(state: MemoryAgentSourceScanState) {
    if (latest?.version && !acceptsScanUpdate(latest, state)) return latest;
    latest = state;
    publish(state);
    return state;
  }
  async function snapshot(fresh = false) {
    if (!polling || fresh) {
      const pending = requireClient().status().then(receive).finally(() => { if (polling === pending) polling = undefined; });
      polling = pending;
    }
    return polling;
  }
  function desktopState(state: MemoryAgentSourceScanState): AgentSourceScanStatusResponse {
    return {
      version: state.version, status: state.status,
      ...(state.jobId ? { execution: { ...identity(state) } } : {}),
      active: state.running,
      progress: state.jobId && !state.completedAt && (state.running || state.progress?.phase === "stopped") ? {
        ...identity(state),
        requestedSourceId: state.sourceId ?? undefined,
        ...(state.mode ? { mode: state.mode } : {}),
        ...desktopProgress(state.progress ?? { sourceId: state.sourceId ?? "all", phase: "scan" as const, current: 0, total: 0 })
      } : null,
      ...(state.jobId && state.sourceId && state.completedAt ? { completion: {
        ...identity(state), sourceId: state.sourceId, succeeded: succeeded(state), completedAt: state.completedAt
      } } : {})
    };
  }
  async function control(kind: "pause" | "cancel", input?: ScanControlInput) {
    const result = await requireClient()[kind](input);
    const state = result.snapshot ? receive(result.snapshot) : await snapshot(true);
    return { ...result, snapshot: desktopState(state) };
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
      if (!input.expectedExecution && !input.expectedVersion && current.running && current.sourceId === input.sourceId && current.mode === (input.mode ?? null) && current.jobId) return identity(current);
      const job = await requireClient().start(input);
      await snapshot(true);
      return job;
    },
    async status(): Promise<AgentSourceScanStatusResponse> {
      let state: MemoryAgentSourceScanState;
      try {
        // Explicit reads may follow a Memory restart; never reuse a pre-restart poll.
        state = await snapshot(true);
      } catch (error) {
        const unavailable = memoryScanUnavailable(error);
        if (!unavailable) throw error;
        // This is an explicit unavailable state, never a successful completion.
        return { active: false, progress: null, unavailable };
      }
      return desktopState(state);
    },
    results: (jobId: string, cursor: string, limit: number) => requireClient().results(jobId, cursor, limit),
    pause: (input?: ScanControlInput) => control("pause", input),
    cancel: (input?: ScanControlInput) => control("cancel", input),
    async dispose() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await polling?.catch(() => undefined);
      // Closing the desktop must not cancel a scan owned by the Memory service.
    }
  };
}

export type { AgentSourceScanClient } from "../adapters/outbound/memory-client/types.js";
