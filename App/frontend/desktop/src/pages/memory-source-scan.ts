import type {
  AgentSourceScanJobResponse,
  AgentSourceScanStatusResponse,
  AgentSourceScanInput,
  AgentSourceView
} from "@memmy/local-api-contracts";
import {
  buildMemorySourceScanFailedEvent,
  buildMemorySourceScanStartedEvent,
  recordScanStarted,
  trackMemoryUiEvent,
  type MemoryUiSubPage
} from "../analytics/memory-ui-analytics.js";
import { appActions, type AppAction } from "../state/app-actions.js";

const DEFAULT_SCAN_FALLBACK_DELAY_MS = 12_000;

export interface ScanAgentSourceClient {
  startScan(input?: AgentSourceScanInput): Promise<AgentSourceScanJobResponse>;
  getScanStatus?(): Promise<AgentSourceScanStatusResponse>;
  listSources(): Promise<AgentSourceView[]>;
}

export interface ScanAppClients {
  agentSources: ScanAgentSourceClient;
}

export interface StartAgentSourceScanInput {
  clients: ScanAppClients;
  dispatch: (action: AppAction) => void;
  ensureScanPermission?: () => Promise<void>;
  sourceId?: string;
  mode?: AgentSourceScanInput["mode"];
  queuedMessage: string;
  formatError?: (error: unknown) => string;
  scheduleFallback: (callback: () => void, delayMs: number) => unknown;
  fallbackDelayMs?: number;
  analyticsContext?: {
    pagePath: string;
    subPage: MemoryUiSubPage;
  };
}

export async function startAgentSourceScan(input: StartAgentSourceScanInput): Promise<void> {
  const delayMs = input.fallbackDelayMs ?? DEFAULT_SCAN_FALLBACK_DELAY_MS;
  const sourceId = input.sourceId ?? "all";
  const analyticsContext = input.analyticsContext ?? {
    pagePath: "/memory/sources",
    subPage: "sources" as const
  };

  input.dispatch(appActions.agentSourceScanStarted(sourceId));

  try {
    await input.ensureScanPermission?.();
    const job = await input.clients.agentSources.startScan({
      sourceId,
      ...(input.mode ? { mode: input.mode } : {})
    });
    recordScanStarted(job.jobId, {
      sourceId,
      scanMode: input.mode,
      pagePath: analyticsContext.pagePath,
      subPage: analyticsContext.subPage
    });
    trackMemoryUiEvent(buildMemorySourceScanStartedEvent({
      pagePath: analyticsContext.pagePath,
      subPage: analyticsContext.subPage,
      sourceId,
      scanMode: input.mode
    }));
    input.dispatch(appActions.agentSourceScanProgressReceived(await resolveStartedScanProgress(input.clients, job, sourceId, input.queuedMessage)));

    input.scheduleFallback(() => {
      void reloadSources(input.clients, input.dispatch, input.formatError);
    }, delayMs);
  } catch (error) {
    trackMemoryUiEvent(buildMemorySourceScanFailedEvent({
      pagePath: analyticsContext.pagePath,
      subPage: analyticsContext.subPage,
      sourceId,
      scanMode: input.mode,
      durationMs: 0
    }));
    input.dispatch(appActions.agentSourcesFailed(formatScanError(error, input.formatError)));
  }
}

async function resolveStartedScanProgress(
  clients: ScanAppClients,
  job: AgentSourceScanJobResponse,
  sourceId: string,
  queuedMessage: string
) {
  const queuedProgress = {
    jobId: job.jobId,
    sourceId,
    phase: "scan" as const,
    current: 0,
    total: 0,
    message: queuedMessage
  };

  if (!clients.agentSources.getScanStatus) {
    return queuedProgress;
  }

  try {
    const status = await clients.agentSources.getScanStatus();
    return status.progress ?? queuedProgress;
  } catch {
    return queuedProgress;
  }
}

async function reloadSources(
  clients: ScanAppClients,
  dispatch: (action: AppAction) => void,
  formatError?: (error: unknown) => string
): Promise<void> {
  try {
    const sources = await clients.agentSources.listSources();
    dispatch(appActions.agentSourcesRefreshed(sources));
  } catch (error) {
    dispatch(appActions.agentSourcesFailed(formatScanError(error, formatError)));
  }
}

function formatScanError(error: unknown, formatter?: (error: unknown) => string): string {
  return formatter?.(error) ?? (error instanceof Error ? error.message : String(error));
}
