/** Definition for memory layer paths. */

export const MEMORY_LAYER_PATHS = Object.freeze({
  health: "/api/v1/health",
  reloadConfig: "/api/v1/admin/reload-config",
  openSession: "/api/v1/sessions/open",
  closeSession: "/api/v1/sessions/:sessionId/close",
  startTurn: "/api/v1/turns/start",
  completeTurn: "/api/v1/turns/:turnId/complete",
  search: "/api/v1/memory/search",
  addMemory: "/api/v1/memory/add",
  getMemory: "/api/v1/memory/:id",
  deleteMemory: "/api/v1/memory/:id",
  runWorker: "/api/v1/worker/run",
  enqueueImportSummaries: "/api/v1/worker/import-summaries/enqueue",
  memoryProcessingStatus: "/api/v1/memory/processing/status",
  retryMemoryProcessing: "/api/v1/memory/:id/processing/retry",
  memoryApiLogs: "/api/v1/memory/logs",
  panelOverview: "/api/v1/panel/overview",
  panelAnalysis: "/api/v1/panel/analysis",
  panelItems: "/api/v1/panel/items",
  panelTasks: "/api/v1/panel/tasks",
  deletePanelTask: "/api/v1/panel/tasks/:id"
} as const);

/** Builds build memory layer url. */
export function buildMemoryLayerUrl(
  baseUrl: string,
  pathKey: keyof typeof MEMORY_LAYER_PATHS,
  params: Readonly<Record<string, string>> = {}
): string {
  const path = MEMORY_LAYER_PATHS[pathKey].replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (!value) {
      throw new Error(`Missing path param: ${key}`);
    }

    return encodeURIComponent(value);
  });

  return new URL(path, normalizeBaseUrl(baseUrl)).toString();
}

/**
 * Normalizes the base URL.
 *
 * @param baseUrl the user-configured base URL.
 * @returns a base URL that can be safely passed to the URL constructor.
 */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}
