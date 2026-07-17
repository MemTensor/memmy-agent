import {
  type AgentSourceScanMode,
  type ScanPhase,
  type ScanResult,
  ScanResultSchema
} from "@memmy/local-api-contracts";
import type {
  AgentSourceScanOptions,
  AgentSourceService,
  CollectedSourceScan,
  ScanProgress
} from "./agent-source-service.js";

const SCAN_PROGRESS_BATCH_SIZE = 50;
const SCAN_PROGRESS_MIN_INTERVAL_MS = 250;

export interface PipelineProgress {
  sourceId: string;
  phase: ScanPhase;
  current: number;
  total: number;
  message?: string;
}

export type ScanResumeState =
  | {
    phase: "add";
    collected: CollectedSourceScan[];
  }
  | {
    phase: "summarize";
    results: ScanResult[];
  };

export type ScanResumeStateReference =
  | {
    storage: "sqlite";
    phase: "add";
    jobId: string;
    sourceId: string;
    messageCount: number;
    sourceCount: number;
  }
  | {
    storage: "sqlite";
    phase: "summarize";
    jobId: string;
    sourceId: string;
    resultCount: number;
  };

export type RouteScanResumeState = ScanResumeState | ScanResumeStateReference;

export interface AgentSourceScanJobState {
  jobId: string;
  sourceId: string;
  mode?: AgentSourceScanMode;
  controller: AbortController;
  lastProgress: PipelineProgress;
  resume: ScanResumeState | null;
}

export interface AgentSourceScanWorkerData {
  databasePath: string;
  job: Omit<AgentSourceScanJobState, "controller" | "resume"> & {
    resume: RouteScanResumeState | null;
  };
}

export type AgentSourceScanWorkerCommand = {
  type: "abort";
};

export type AgentSourceScanWorkerMessage =
  | {
    type: "progress";
    progress: PipelineProgress;
  }
  | {
    type: "resume";
    resume: ScanResumeStateReference | null;
  }
  | {
    type: "completed";
    results: ScanResult[];
  }
  | {
    type: "failed";
    message: string;
  };

export interface RunAgentSourceScanJobCallbacks {
  onProgress(progress: PipelineProgress): void;
  onResumeChanged(resume: ScanResumeState | null): void;
  onCompleted(results: ScanResult[]): void;
}

export async function runAgentSourceScanJob(
  job: AgentSourceScanJobState,
  agentSources: AgentSourceService,
  callbacks: RunAgentSourceScanJobCallbacks
): Promise<void> {
  try {
    const emitProgress = createThrottledProgressEmitter(callbacks.onProgress);
    const scanOptions: AgentSourceScanOptions = {
      onProgress(progress) {
        if (!job.controller.signal.aborted) {
          emitProgress(progress);
        }
      },
      signal: job.controller.signal,
      progressSourceId: job.sourceId,
      mode: job.mode,
      scanStartedAt: new Date().toISOString()
    };

    let results: ScanResult[];
    if (job.resume?.phase === "summarize") {
      results = job.resume.results;
    } else {
      const collected = job.resume?.phase === "add"
        ? job.resume.collected
        : job.sourceId === "all"
          ? await agentSources.collectAll(scanOptions)
          : [await agentSources.collectOne(job.sourceId, scanOptions)];
      if (job.controller.signal.aborted) {
        return;
      }
      callbacks.onResumeChanged({ phase: "add", collected });
      results = await agentSources.ingestCollected(collected, scanOptions);
      if (job.controller.signal.aborted) {
        return;
      }
    }

    callbacks.onResumeChanged({ phase: "summarize", results });
    await agentSources.processImportSummaries(scanOptions);
    if (job.controller.signal.aborted) {
      return;
    }
    callbacks.onCompleted(ScanResultSchema.array().parse(results));
  } catch (error) {
    if (job.controller.signal.aborted) {
      return;
    }
    callbacks.onCompleted([
      {
        sourceId: job.sourceId,
        discoveredConversations: 0,
        emittedMessages: 0,
        skipped: 0,
        errors: [
          {
            conversationId: "scan",
            reason: error instanceof Error ? error.message : "Agent source scan failed"
          }
        ]
      }
    ]);
  }
}

export function toStoppedProgress(jobId: string, lastProgress?: PipelineProgress): PipelineProgress & { jobId: string } {
  return {
    jobId,
    sourceId: lastProgress?.sourceId ?? "all",
    phase: "stopped",
    current: lastProgress?.current ?? 0,
    total: lastProgress?.total ?? 0,
    message: "Agent source scan stopped"
  };
}

export function progressForResume(resume: RouteScanResumeState, stoppedProgress: PipelineProgress): PipelineProgress {
  if (isScanResumeStateReference(resume)) {
    if (resume.phase === "add") {
      return {
        sourceId: stoppedProgress.sourceId === "all" ? resume.sourceId : stoppedProgress.sourceId,
        phase: "add",
        current: Math.min(stoppedProgress.current, resume.messageCount),
        total: resume.messageCount,
        message: "Resuming raw memory import"
      };
    }

    return {
      sourceId: stoppedProgress.sourceId,
      phase: "summarize",
      current: stoppedProgress.phase === "summarize" ? stoppedProgress.current : 0,
      total: stoppedProgress.phase === "summarize" ? stoppedProgress.total : 0,
      message: "Resuming summaries and index"
    };
  }

  if (resume.phase === "add") {
    const total = resume.collected.reduce((sum, source) => sum + source.messages.length, 0);
    return {
      sourceId: stoppedProgress.sourceId === "all" ? resume.collected[0]?.sourceId ?? "all" : stoppedProgress.sourceId,
      phase: "add",
      current: Math.min(stoppedProgress.current, total),
      total,
      message: "Resuming raw memory import"
    };
  }

  return {
    sourceId: stoppedProgress.sourceId,
    phase: "summarize",
    current: stoppedProgress.phase === "summarize" ? stoppedProgress.current : 0,
    total: stoppedProgress.phase === "summarize" ? stoppedProgress.total : 0,
    message: "Resuming summaries and index"
  };
}

export function isScanResumeStateReference(resume: RouteScanResumeState): resume is ScanResumeStateReference {
  return "storage" in resume && resume.storage === "sqlite";
}

function createThrottledProgressEmitter(
  onProgress: (progress: PipelineProgress) => void
): (progress: ScanProgress) => void {
  const lastProgressBySource = new Map<string, ScanProgress>();
  const lastEmittedAtBySource = new Map<string, number>();

  return (progress) => {
    const now = Date.now();
    const pipelineProgress = toPipelineProgress(progress);
    const lastProgress = lastProgressBySource.get(progress.sourceId) ?? null;
    const lastEmittedAt = lastEmittedAtBySource.get(progress.sourceId) ?? 0;
    if (!shouldEmitScanProgress(progress, lastProgress, now - lastEmittedAt)) {
      return;
    }

    lastProgressBySource.set(progress.sourceId, progress);
    lastEmittedAtBySource.set(progress.sourceId, now);
    onProgress(pipelineProgress);
  };
}

function shouldEmitScanProgress(progress: ScanProgress, lastProgress: ScanProgress | null, elapsedMs: number): boolean {
  if (!lastProgress) {
    return true;
  }

  if (progress.phase === "done") {
    return true;
  }

  if (!isHighFrequencyProgress(progress) && progress.phase !== lastProgress.phase) {
    return true;
  }

  if (progress.current - lastProgress.current >= SCAN_PROGRESS_BATCH_SIZE) {
    return true;
  }

  return elapsedMs >= SCAN_PROGRESS_MIN_INTERVAL_MS;
}

function isHighFrequencyProgress(progress: ScanProgress): boolean {
  return progress.phase === "redact" || progress.phase === "emit" || progress.phase === "add" || progress.phase === "summarize";
}

function toPipelineProgress(progress: ScanProgress): PipelineProgress {
  return {
    sourceId: progress.sourceId,
    phase: toPipelinePhase(progress.phase),
    current: progress.current,
    total: progress.total,
    message: progress.message
  };
}

function toPipelinePhase(phase: ScanProgress["phase"]): ScanPhase {
  if (phase === "add" || phase === "summarize" || phase === "done" || phase === "stopped") {
    return phase;
  }
  return "scan";
}
