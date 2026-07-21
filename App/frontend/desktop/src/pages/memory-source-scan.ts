import type {
  AgentSourceScanJobResponse,
  AgentSourceScanStatusResponse,
  AgentSourceScanInput,
  AgentSourceView
} from "@memmy/local-api-contracts";
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
}

export async function startAgentSourceScan(input: StartAgentSourceScanInput): Promise<void> {
  const delayMs = input.fallbackDelayMs ?? DEFAULT_SCAN_FALLBACK_DELAY_MS;
  const sourceId = input.sourceId ?? "all";

  input.dispatch(appActions.agentSourceScanStarted(sourceId));

  try {
    await input.ensureScanPermission?.();
    const job = await input.clients.agentSources.startScan({
      sourceId,
      ...(input.mode ? { mode: input.mode } : {})
    });
    input.dispatch(appActions.agentSourceScanProgressReceived(await resolveStartedScanProgress(input.clients, job, sourceId, input.queuedMessage)));

    input.scheduleFallback(() => {
      void reloadSources(input.clients, input.dispatch, input.formatError);
    }, delayMs);
  } catch (error) {
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
