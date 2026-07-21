/** Agent sources module. */
import {
  AddManualInputSchema,
  AgentSourceAutoInjectResultSchema,
  AgentSourceIdParamsSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceScanStatusResponseSchema,
  AgentSourceViewSchema,
  OkResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { PermissionManager } from "../../../../permission/index.js";
import { withErrorEnvelope } from "../../../../services/error-envelope.js";
import type { AgentSourceAutoInjectService } from "../../../../services/agent-source-auto-inject-service.js";
import type { AgentSourceService } from "../../../../services/agent-source-service.js";
import {
  deletePersistedScanResume,
  readLatestPersistedScanResume
} from "../../../../services/agent-source-scan-journal.js";
import type { ProgressBus } from "../../../../services/progress-bus.js";
import {
  type AgentSourceScanJobState,
  type AgentSourceScanWorkerCommand,
  type AgentSourceScanWorkerData,
  type AgentSourceScanWorkerMessage,
  isScanResumeStateReference,
  type PipelineProgress,
  progressForResume,
  runAgentSourceScanJob,
  type RouteScanResumeState,
  toStoppedProgress
} from "../../../../services/agent-source-scan-runner.js";

/** Contract for register agent source routes options. */
export interface RegisterAgentSourceRoutesOptions {
  agentSources: AgentSourceService;
  agentSourceAutoInject: AgentSourceAutoInjectService;
  progressBus: ProgressBus;
  permissionManager: Pick<PermissionManager, "canScanAgentSource">;
  authenticateRuntimeToken: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  scanWorker?: {
    databasePath: string;
  };
}

/** Registers register agent source routes. */
export function registerAgentSourceRoutes(app: FastifyInstance, options: RegisterAgentSourceRoutesOptions): void {
  type ActiveScanJob = Omit<AgentSourceScanJobState, "resume"> & {
    resume: RouteScanResumeState | null;
    worker?: Worker;
  };

  let activeScanJob: ActiveScanJob | null = null;
  type PausedScanJob = {
    jobId: string;
    sourceId: string;
    mode?: AgentSourceScanJobState["mode"];
    lastProgress: PipelineProgress & { jobId: string };
    resume: RouteScanResumeState | null;
  };
  const restoredScanJob = toPausedScanJob(readLatestPersistedScanResume(options.scanWorker?.databasePath));
  let pausedScanJob: PausedScanJob | null = restoredScanJob;
  let lastScanProgress: (PipelineProgress & { jobId: string }) | null = restoredScanJob?.lastProgress ?? null;
  let lastScanCompletion: {
    jobId: string;
    sourceId: string;
    succeeded: boolean;
    completedAt: string;
  } | null = null;

  app.addHook("onClose", async () => {
    if (!activeScanJob) {
      return;
    }

    const closingJob = activeScanJob;
    activeScanJob = null;
    abortScanJob(closingJob);
    pausedScanJob = null;
    await closingJob.worker?.terminate().catch(() => undefined);
  });

  app.get("/api/agent-sources", { preHandler: options.authenticateRuntimeToken }, async (_request, reply) => {
    const response = AgentSourceViewSchema.array().parse(await options.agentSources.list());
    return reply.send(response);
  });

  app.get(
    "/api/agent-sources/memory-plugin-conflicts",
    { preHandler: options.authenticateRuntimeToken },
    async (_request, reply) => {
      const conflicts = await options.agentSources.detectMemoryPluginConflicts();
      return reply.send(AgentSourceMemoryPluginConflictsResponseSchema.parse({ conflicts }));
    }
  );

  app.post(
    "/api/agent-sources/auto-inject/run",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (_request, reply) => {
      const response = AgentSourceAutoInjectResultSchema.parse(await options.agentSourceAutoInject.runOnce());
      return reply.send(response);
    })
  );

  app.get("/api/agent-sources/scan/status", { preHandler: options.authenticateRuntimeToken }, async (_request, reply) => {
    if (activeScanJob?.controller.signal.aborted) {
      lastScanProgress = toStoppedProgress(activeScanJob.jobId, activeScanJob.lastProgress);
      pausedScanJob = {
        jobId: activeScanJob.jobId,
        sourceId: activeScanJob.sourceId,
        mode: activeScanJob.mode,
        lastProgress: lastScanProgress,
        resume: activeScanJob.resume
      };
      activeScanJob = null;
    }
    const progress = activeScanJob
      ? { jobId: activeScanJob.jobId, ...activeScanJob.lastProgress }
      : lastScanProgress?.phase === "stopped" ? lastScanProgress : null;
    const completion = recentScanCompletion(lastScanCompletion);
    return reply.send(AgentSourceScanStatusResponseSchema.parse({
      active: Boolean(activeScanJob),
      progress,
      ...(completion ? { completion } : {})
    }));
  });

  app.post("/api/agent-sources/scan", { preHandler: options.authenticateRuntimeToken }, async (request, reply) => {
    const input = AgentSourceScanInputSchema.parse(request.body);
    const sourceId = input.sourceId;
    const mode = input.mode;

    if (!(await options.permissionManager.canScanAgentSource({ agentSourceId: sourceId }))) {
      return reply.code(403).send({
        error: {
          code: "scan_not_permitted",
          message: "scan not permitted"
        }
      });
    }

    if (activeScanJob?.controller.signal.aborted) {
      activeScanJob = null;
    }
    if (activeScanJob) {
      return reply.send(AgentSourceScanJobResponseSchema.parse({ jobId: activeScanJob.jobId }));
    }

    const pausedJob = pausedScanJob?.resume && pausedScanJob.sourceId === sourceId && pausedScanJob.mode === mode ? pausedScanJob : null;
    if (!pausedJob) {
      cleanupResumeState(pausedScanJob?.resume ?? null);
      pausedScanJob = null;
    }
    const jobId = pausedJob?.jobId ?? randomUUID();
    lastScanCompletion = null;
    const controller = new AbortController();
    activeScanJob = {
      jobId,
      sourceId,
      mode,
      controller,
      lastProgress: pausedJob?.resume ? progressForResume(pausedJob.resume, pausedJob.lastProgress) : {
        sourceId,
        phase: "scan",
        current: 0,
        total: 0,
        message: "Agent source scan queued"
      },
      resume: pausedJob?.resume ?? null
    };
    lastScanProgress = { jobId, ...activeScanJob.lastProgress };
    if (pausedJob) {
      pausedScanJob = null;
    }
    options.progressBus.emit("agent_source.scan_progress", {
      jobId,
      ...activeScanJob.lastProgress
    });

    const scanJob = activeScanJob;
    setImmediate(() => {
      startScanJob(scanJob);
    });
    return reply.send(AgentSourceScanJobResponseSchema.parse({ jobId }));
  });

  app.post("/api/agent-sources/scan/stop", { preHandler: options.authenticateRuntimeToken }, async (_request, reply) => {
    if (activeScanJob) {
      const stoppedJob = activeScanJob;
      activeScanJob = null;
      abortScanJob(stoppedJob);
      lastScanProgress = toStoppedProgress(stoppedJob.jobId, stoppedJob.lastProgress);
      pausedScanJob = {
        jobId: stoppedJob.jobId,
        sourceId: stoppedJob.sourceId,
        mode: stoppedJob.mode,
        lastProgress: lastScanProgress,
        resume: stoppedJob.resume
      };
      emitStoppedProgress(stoppedJob.jobId, options.progressBus, stoppedJob.lastProgress);
    }
    return reply.send(OkResponseSchema.parse({ ok: true }));
  });

  app.post("/api/agent-sources/scan/cancel", { preHandler: options.authenticateRuntimeToken }, async (_request, reply) => {
    if (activeScanJob) {
      const canceledJob = activeScanJob;
      activeScanJob = null;
      abortScanJob(canceledJob);
      cleanupResumeState(canceledJob.resume);
    }
    cleanupResumeState(pausedScanJob?.resume ?? null);
    pausedScanJob = null;
    lastScanProgress = null;
    return reply.send(OkResponseSchema.parse({ ok: true }));
  });

  app.post("/api/agent-sources/manual", { preHandler: options.authenticateRuntimeToken }, async (request, reply) => {
    const input = AddManualInputSchema.parse(request.body);
    const response = AgentSourceViewSchema.parse(await options.agentSources.addManual(input));
    return reply.send(response);
  });

  app.delete(
    "/api/agent-sources/:sourceId",
    { preHandler: options.authenticateRuntimeToken },
    async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.remove(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    }
  );

  app.post(
    "/api/agent-sources/:sourceId/skill",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.installSkill(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.installPlugin(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.uninstallPlugin(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/skill",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      await options.agentSources.uninstallSkill(params.sourceId);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  function startScanJob(scanJob: ActiveScanJob): void {
    if (scanJob.controller.signal.aborted) {
      if (!options.scanWorker) {
        startInlineScanJob(scanJob);
      }
      return;
    }

    if (activeScanJob?.jobId !== scanJob.jobId) {
      return;
    }

    if (options.scanWorker) {
      startWorkerScanJob(scanJob);
      return;
    }

    startInlineScanJob(scanJob);
  }

  function startInlineScanJob(scanJob: ActiveScanJob): void {
    if (scanJob.resume && isScanResumeStateReference(scanJob.resume)) {
      handleWorkerFailure(scanJob.jobId, new Error("SQLite-backed scan resume requires the scan worker"));
      return;
    }

    const inlineJob: AgentSourceScanJobState = {
      jobId: scanJob.jobId,
      sourceId: scanJob.sourceId,
      mode: scanJob.mode,
      controller: scanJob.controller,
      lastProgress: scanJob.lastProgress,
      resume: scanJob.resume
    };
    void runAgentSourceScanJob(inlineJob, options.agentSources, {
      onProgress(progress) {
        updateActiveProgress(scanJob.jobId, progress);
        options.progressBus.emit("agent_source.scan_progress", {
          jobId: scanJob.jobId,
          ...progress
        });
      },
      onResumeChanged(resume) {
        updateActiveResume(scanJob.jobId, resume);
      },
      onCompleted(results) {
        if (activeScanJob?.jobId !== scanJob.jobId) {
          return;
        }
        lastScanCompletion = scanCompletion(scanJob.jobId, scanJob.sourceId, results);
        options.progressBus.emit("agent_source.scan_completed", {
          jobId: scanJob.jobId,
          sourceId: scanJob.sourceId,
          results
        });
      }
    }).finally(() => {
      finishActiveScanJob(scanJob.jobId);
    });
  }

  function startWorkerScanJob(scanJob: ActiveScanJob): void {
    if (!options.scanWorker) {
      return;
    }

    const workerData: AgentSourceScanWorkerData = {
      databasePath: options.scanWorker.databasePath,
      job: {
        jobId: scanJob.jobId,
        sourceId: scanJob.sourceId,
        mode: scanJob.mode,
        lastProgress: scanJob.lastProgress,
        resume: scanJob.resume
      }
    };
    let worker: Worker;
    try {
      worker = new Worker(resolveAgentSourceScanWorkerUrl(), { workerData });
    } catch (error) {
      handleWorkerFailure(scanJob.jobId, error instanceof Error ? error : new Error("Agent source scan worker failed to start"));
      return;
    }
    scanJob.worker = worker;

    worker.on("message", (message: AgentSourceScanWorkerMessage) => {
      handleWorkerMessage(scanJob.jobId, message);
    });
    worker.on("error", (error) => {
      handleWorkerFailure(scanJob.jobId, error instanceof Error ? error : new Error("Agent source scan worker failed"));
    });
    worker.on("exit", (code) => {
      if (code !== 0 && activeScanJob?.jobId === scanJob.jobId && !scanJob.controller.signal.aborted) {
        handleWorkerFailure(scanJob.jobId, new Error(`Agent source scan worker exited with code ${code}`));
        return;
      }
      finishActiveScanJob(scanJob.jobId);
    });
  }

  function handleWorkerMessage(jobId: string, message: AgentSourceScanWorkerMessage): void {
    if (activeScanJob?.jobId !== jobId && pausedScanJob?.jobId === jobId && message.type === "resume") {
      pausedScanJob.resume = message.resume;
      return;
    }

    if (activeScanJob?.jobId !== jobId) {
      return;
    }

    if (message.type === "progress") {
      updateActiveProgress(jobId, message.progress);
      options.progressBus.emit("agent_source.scan_progress", {
        jobId,
        ...message.progress
      });
      return;
    }

    if (message.type === "resume") {
      updateActiveResume(jobId, message.resume);
      return;
    }

    if (message.type === "completed") {
      lastScanCompletion = scanCompletion(jobId, activeScanJob.sourceId, message.results);
      options.progressBus.emit("agent_source.scan_completed", {
        jobId,
        sourceId: activeScanJob.sourceId,
        results: message.results
      });
      finishActiveScanJob(jobId);
      return;
    }

    handleWorkerFailure(jobId, new Error(message.message));
  }

  function handleWorkerFailure(jobId: string, error: Error): void {
    if (activeScanJob?.jobId !== jobId) {
      return;
    }

    const results = [
      {
        sourceId: activeScanJob.sourceId,
        discoveredConversations: 0,
        emittedMessages: 0,
        skipped: 0,
        errors: [
          {
            conversationId: "scan",
            reason: error.message
          }
        ]
      }
    ];
    lastScanCompletion = scanCompletion(jobId, activeScanJob.sourceId, results);
    options.progressBus.emit("agent_source.scan_completed", {
      jobId,
      sourceId: activeScanJob.sourceId,
      results
    });
    const failedJob = activeScanJob;
    pausedScanJob = {
      jobId: failedJob.jobId,
      sourceId: failedJob.sourceId,
      mode: failedJob.mode,
      lastProgress: toStoppedProgress(failedJob.jobId, failedJob.lastProgress),
      resume: failedJob.resume
    };
    activeScanJob = null;
    lastScanProgress = pausedScanJob.lastProgress;
  }

  function updateActiveProgress(jobId: string, progress: PipelineProgress): void {
    lastScanProgress = { jobId, ...progress };
    if (activeScanJob?.jobId === jobId && !activeScanJob.controller.signal.aborted) {
      activeScanJob.lastProgress = progress;
    }
  }

  function updateActiveResume(jobId: string, resume: RouteScanResumeState | null): void {
    if (activeScanJob?.jobId === jobId) {
      activeScanJob.resume = resume;
    }
  }

  function finishActiveScanJob(jobId: string): void {
    if (activeScanJob?.jobId === jobId) {
      cleanupResumeState(activeScanJob.resume);
      activeScanJob = null;
      lastScanProgress = null;
      pausedScanJob = null;
    }
  }

  function abortScanJob(job: ActiveScanJob): void {
    job.controller.abort();
    const command: AgentSourceScanWorkerCommand = { type: "abort" };
    try {
      job.worker?.postMessage(command);
    } catch {
      // The worker may already have exited while the HTTP stop/cancel request is being handled.
    }
  }

  function cleanupResumeState(resume: RouteScanResumeState | null): void {
    if (!resume || !isScanResumeStateReference(resume)) {
      return;
    }

    deletePersistedScanResume(options.scanWorker?.databasePath, resume.jobId);
  }
}

function toPausedScanJob(
  persisted: ReturnType<typeof readLatestPersistedScanResume>
): {
  jobId: string;
  sourceId: string;
  mode?: AgentSourceScanJobState["mode"];
  lastProgress: PipelineProgress & { jobId: string };
  resume: RouteScanResumeState;
} | null {
  if (!persisted) return null;
  const total = persisted.resume.phase === "add" ? persisted.resume.messageCount : 0;
  return {
    jobId: persisted.jobId,
    sourceId: persisted.sourceId,
    mode: persisted.mode,
    resume: persisted.resume,
    lastProgress: {
      jobId: persisted.jobId,
      sourceId: persisted.sourceId,
      phase: "stopped",
      current: 0,
      total,
      message: "Agent source scan interrupted and ready to resume"
    }
  };
}

function emitStoppedProgress(jobId: string, progressBus: ProgressBus, lastProgress?: PipelineProgress): void {
  progressBus.emit("agent_source.scan_progress", toStoppedProgress(jobId, lastProgress));
}

function scanCompletion(
  jobId: string,
  sourceId: string,
  results: readonly { errors: readonly unknown[] }[]
): { jobId: string; sourceId: string; succeeded: boolean; completedAt: string } {
  return {
    jobId,
    sourceId,
    succeeded: results.every((result) => result.errors.length === 0),
    completedAt: new Date().toISOString()
  };
}

function recentScanCompletion<T extends { completedAt: string }>(completion: T | null): T | null {
  if (!completion) return null;
  return Date.now() - Date.parse(completion.completedAt) <= 60_000 ? completion : null;
}

function resolveAgentSourceScanWorkerUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`../../../../services/agent-source-scan-worker.${extension}`, import.meta.url);
}
