/** Agent sources module. */
import {
  AddManualInputSchema,
  AgentSourceAutoInjectResultSchema,
  AgentSourceIdParamsSchema,
  AgentSourceMemoryPluginConflictsResponseSchema,
  AgentSourcePluginActionInputSchema,
  AgentSourceScanInputSchema,
  AgentSourceScanJobResponseSchema,
  AgentSourceScanStatusResponseSchema,
  AgentSourceViewSchema,
  ManagedAgentSourceImportInputSchema,
  ManagedAgentSourceImportResultSchema,
  ManagedAgentSourceUpdateInputSchema,
  OkResponseSchema
} from "@memmy/local-api-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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
  type AgentSourceScanProcessCommand,
  type AgentSourceScanProcessData,
  type AgentSourceScanProcessMessage,
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
  scanProcess?: {
    databasePath: string;
  };
}

/** Registers register agent source routes. */
export function registerAgentSourceRoutes(app: FastifyInstance, options: RegisterAgentSourceRoutesOptions): void {
  type ActiveScanJob = Omit<AgentSourceScanJobState, "resume"> & {
    resume: RouteScanResumeState | null;
    process?: ChildProcess;
  };

  let activeScanJob: ActiveScanJob | null = null;
  type PausedScanJob = {
    jobId: string;
    sourceId: string;
    mode?: AgentSourceScanJobState["mode"];
    lastProgress: PipelineProgress & { jobId: string };
    resume: RouteScanResumeState | null;
  };
  const restoredScanJob = toPausedScanJob(readLatestPersistedScanResume(options.scanProcess?.databasePath));
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
    closingJob.process?.kill();
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

  app.post(
    "/api/agent-sources/:sourceId/managed/import",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const input = ManagedAgentSourceImportInputSchema.parse(request.body);
      const response = await options.agentSources.importManaged(params.sourceId, input);
      return reply.send(ManagedAgentSourceImportResultSchema.parse(response));
    })
  );

  app.post(
    "/api/agent-sources/:sourceId/managed/sync",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      if (!(await options.permissionManager.canScanAgentSource({ agentSourceId: params.sourceId }))) {
        return reply.code(403).send({
          error: {
            code: "scan_not_permitted",
            message: "scan not permitted"
          }
        });
      }
      const response = await options.agentSources.syncManaged(params.sourceId);
      return reply.send(ManagedAgentSourceImportResultSchema.parse(response));
    })
  );

  app.patch(
    "/api/agent-sources/:sourceId/managed",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const input = ManagedAgentSourceUpdateInputSchema.parse(request.body);
      const response = await options.agentSources.updateManaged(params.sourceId, input);
      return reply.send(AgentSourceViewSchema.parse(response));
    })
  );

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
      const action = AgentSourcePluginActionInputSchema.parse(request.body ?? {});
      await options.agentSources.installPlugin(params.sourceId, action);
      return reply.send(OkResponseSchema.parse({ ok: true }));
    })
  );

  app.delete(
    "/api/agent-sources/:sourceId/plugin",
    { preHandler: options.authenticateRuntimeToken },
    withErrorEnvelope(async (request, reply) => {
      const params = AgentSourceIdParamsSchema.parse(request.params);
      const action = AgentSourcePluginActionInputSchema.parse(request.body ?? {});
      await options.agentSources.uninstallPlugin(params.sourceId, action);
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
      if (!options.scanProcess) {
        startInlineScanJob(scanJob);
      }
      return;
    }

    if (activeScanJob?.jobId !== scanJob.jobId) {
      return;
    }

    if (options.scanProcess) {
      startProcessScanJob(scanJob);
      return;
    }

    startInlineScanJob(scanJob);
  }

  function startInlineScanJob(scanJob: ActiveScanJob): void {
    if (scanJob.resume && isScanResumeStateReference(scanJob.resume)) {
      handleProcessFailure(scanJob.jobId, new Error("SQLite-backed scan resume requires the scan process"));
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

  function startProcessScanJob(scanJob: ActiveScanJob): void {
    if (!options.scanProcess) {
      return;
    }

    const processData: AgentSourceScanProcessData = {
      databasePath: options.scanProcess.databasePath,
      job: {
        jobId: scanJob.jobId,
        sourceId: scanJob.sourceId,
        mode: scanJob.mode,
        lastProgress: scanJob.lastProgress,
        resume: scanJob.resume
      }
    };
    let child: ChildProcess;
    try {
      child = fork(fileURLToPath(resolveAgentSourceScanProcessUrl()), [], {
        env: createScanProcessEnvironment(process.env)
      });
    } catch (error) {
      handleProcessFailure(scanJob.jobId, error instanceof Error ? error : new Error("Agent source scan process failed to start"));
      return;
    }
    scanJob.process = child;

    child.on("message", (message) => {
      handleProcessMessage(scanJob.jobId, message as AgentSourceScanProcessMessage);
    });
    child.on("error", (error) => {
      handleProcessFailure(scanJob.jobId, error instanceof Error ? error : new Error("Agent source scan process failed"));
    });
    child.on("exit", (code, signal) => {
      if (code !== 0 && activeScanJob?.jobId === scanJob.jobId && !scanJob.controller.signal.aborted) {
        handleProcessFailure(
          scanJob.jobId,
          new Error(`Agent source scan process exited with ${signal ? `signal ${signal}` : `code ${code}`}`)
        );
        return;
      }
      finishActiveScanJob(scanJob.jobId);
    });

    const startCommand: AgentSourceScanProcessCommand = { type: "start", data: processData };
    child.send(startCommand, (error) => {
      if (error) handleProcessFailure(scanJob.jobId, error);
    });
  }

  function handleProcessMessage(jobId: string, message: AgentSourceScanProcessMessage): void {
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

    handleProcessFailure(jobId, new Error(message.message));
  }

  function handleProcessFailure(jobId: string, error: Error): void {
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
    const command: AgentSourceScanProcessCommand = { type: "abort" };
    try {
      if (job.process?.connected) job.process.send(command);
    } catch {
      // The process may already have exited while the HTTP stop/cancel request is being handled.
    }
  }

  function cleanupResumeState(resume: RouteScanResumeState | null): void {
    if (!resume || !isScanResumeStateReference(resume)) {
      return;
    }

    deletePersistedScanResume(options.scanProcess?.databasePath, resume.jobId);
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

function resolveAgentSourceScanProcessUrl(): URL {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return new URL(`../../../../services/agent-source-scan-process.${extension}`, import.meta.url);
}

function createScanProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return process.versions.electron
    ? { ...env, ELECTRON_RUN_AS_NODE: "1" }
    : env;
}
