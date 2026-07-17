/** Http memory client module. */
import {
  AddMemoryOutputSchema,
  ApiErrorBodySchema,
  CloseSessionOutputSchema,
  CompleteTurnOutputSchema,
  DeleteMemoryOutputSchema,
  DeletePanelTaskOutputSchema,
  EnqueueImportSummariesOutputSchema,
  GetMemoryOutputSchema,
  MemoryApiLogsOutputSchema,
  MemoryHealthSnapshotSchema,
  MemoryReloadConfigOutputSchema,
  PanelAnalysisOutputSchema,
  PanelItemsOutputSchema,
  PanelOverviewOutputSchema,
  PanelTasksOutputSchema,
  OpenSessionOutputSchema,
  SearchOutputSchema,
  StartTurnOutputSchema,
  WorkerRunOutputSchema
} from "@memmy/local-api-contracts";
import type { ZodType } from "zod";
import { MemoryLayerError, MemoryLayerNetworkError } from "./errors.js";
import { buildMemoryLayerUrl, MEMORY_LAYER_PATHS } from "./memory-layer-endpoints.js";
import { retryWithBackoff } from "./retry.js";
import type { MemoryClient } from "./types.js";

export interface MemoryLayerConfig {
  /** Base url. */
  baseUrl: string;
  /** Token. */
  token: string;
  /** Timeout ms. */
  timeoutMs: number;
  /** Max retries. */
  maxRetries: number;
}

export interface CreateHttpMemoryClientOptions {
  /** Fetch impl. */
  fetchImpl?: typeof fetch;
}

type PathKey = keyof typeof MEMORY_LAYER_PATHS;

/** Creates create http memory client. */
export function createHttpMemoryClient(
  config: MemoryLayerConfig,
  options: CreateHttpMemoryClientOptions = {}
): MemoryClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function request<Output>(
    method: "GET" | "POST" | "DELETE",
    pathKey: PathKey,
    responseSchema: ZodType<Output>,
    requestOptions: {
      body?: unknown;
      params?: Readonly<Record<string, string>>;
      query?: Readonly<Record<string, unknown>>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {}
  ): Promise<Output> {
    const url = appendQuery(buildMemoryLayerUrl(config.baseUrl, pathKey, requestOptions.params), requestOptions.query);

    const json = await retryWithBackoff(
      async () => {
        const timeoutSignal = AbortSignal.timeout(requestOptions.timeoutMs ?? config.timeoutMs);
        const hasBody = requestOptions.body !== undefined;
        const response = await fetchWithMappedNetworkErrors(fetchImpl, url, {
          method,
          headers: {
            ...(hasBody ? { "content-type": "application/json" } : {}),
            authorization: `Bearer ${config.token}`
          },
          body: hasBody ? JSON.stringify(requestOptions.body) : undefined,
          signal: combineAbortSignals(timeoutSignal, requestOptions.signal)
        });

        if (response.ok) {
          return response.json();
        }

        if (response.status >= 500) {
          throw new MemoryLayerError("memory_layer_unavailable", 503, "memory layer 5xx");
        }

        const rawBody = await response.json().catch(() => undefined);
        const parsed = ApiErrorBodySchema.safeParse(rawBody);
        if (parsed.success) {
          throw new MemoryLayerError(parsed.data.error.code, response.status, parsed.data.error.message);
        }
        throw new MemoryLayerError(
          response.status >= 500 ? "memory_layer_unavailable" : "internal",
          response.status,
          "memory layer returned an unrecognized error response",
          rawBody
        );
      },
      {
        maxRetries: config.maxRetries,
        baseDelayMs: 100,
        factor: 3,
        jitter: 0.2,
        shouldRetry: shouldRetryMemoryLayerError
      }
    );

    return responseSchema.parse(json);
  }

  return {
    async health() {
      return request("GET", "health", MemoryHealthSnapshotSchema);
    },

    async reloadConfig(input = {}) {
      return request("POST", "reloadConfig", MemoryReloadConfigOutputSchema, { body: input });
    },

    async openSession(input) {
      return request("POST", "openSession", OpenSessionOutputSchema, { body: input });
    },

    async closeSession(input) {
      const { sessionId, ...body } = input;
      return request("POST", "closeSession", CloseSessionOutputSchema, {
        params: { sessionId },
        body
      });
    },

    async startTurn(input) {
      return request("POST", "startTurn", StartTurnOutputSchema, { body: input });
    },

    async completeTurn(input) {
      const { turnId, ...body } = input;
      return request("POST", "completeTurn", CompleteTurnOutputSchema, {
        params: { turnId },
        body
      });
    },

    async search(input) {
      return request("POST", "search", SearchOutputSchema, { body: input });
    },

    async addMemory(input) {
      return request("POST", "addMemory", AddMemoryOutputSchema, { body: input });
    },

    async getMemory(input) {
      return request("GET", "getMemory", GetMemoryOutputSchema, {
        params: { id: input.memoryId }
      });
    },

    async deleteMemory(input) {
      const { memoryId, ...body } = input;
      return request("DELETE", "deleteMemory", DeleteMemoryOutputSchema, {
        params: { id: memoryId },
        body
      });
    },

    async enqueueImportSummaries() {
      return request("POST", "enqueueImportSummaries", EnqueueImportSummariesOutputSchema);
    },

    async runWorker(input) {
      return request("POST", "runWorker", WorkerRunOutputSchema, {
        body: { limit: input.limit },
        signal: input.signal,
        timeoutMs: input.timeoutMs
      });
    },

    async panelOverview() {
      return request("GET", "panelOverview", PanelOverviewOutputSchema);
    },

    async panelAnalysis() {
      return request("GET", "panelAnalysis", PanelAnalysisOutputSchema);
    },

    async panelItems(input) {
      return request("GET", "panelItems", PanelItemsOutputSchema, { query: input });
    },

    async panelTasks(input) {
      return request("GET", "panelTasks", PanelTasksOutputSchema, { query: input });
    },

    async deletePanelTask(taskId) {
      return request("DELETE", "deletePanelTask", DeletePanelTaskOutputSchema, {
        params: { id: taskId },
        body: {}
      });
    },

    async memoryApiLogs(input) {
      return request("GET", "memoryApiLogs", MemoryApiLogsOutputSchema, {
        query: {
          ...input,
          tools: input.tools?.join(",")
        }
      });
    }
  };
}

function combineAbortSignals(primary: AbortSignal, secondary: AbortSignal | undefined): AbortSignal {
  if (!secondary) {
    return primary;
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([primary, secondary]);
  }

  return secondary.aborted ? secondary : primary;
}

/**
 * Executes fetch and maps network/timeout errors into MemoryClient errors.
 *
 * @param fetchImpl fetch implementation.
 * @param url request URL.
 * @param init fetch init.
 * @returns the fetch Response.
 */
async function fetchWithMappedNetworkErrors(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new MemoryLayerError("memory_layer_unavailable", 503, "memory layer timeout", error);
    }

    throw new MemoryLayerNetworkError(error);
  }
}

/**
 * Determines whether the error comes from a request timeout or abort.
 *
 * @param error the caught fetch error.
 * @returns whether it should be handled as a 503 timeout.
 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/**
 * Determines whether a MemoryClient error is retryable.
 *
 * @param error the caught error.
 * @returns whether it should be retried.
 */
function shouldRetryMemoryLayerError(error: unknown): boolean {
  return (
    error instanceof MemoryLayerNetworkError ||
    (error instanceof MemoryLayerError && error.status >= 500)
  );
}

/**
 * Appends query parameters to a GET URL.
 *
 * @param url the original URL.
 * @param query the query object.
 * @returns the URL with the query appended.
 */
function appendQuery(url: string, query: Readonly<Record<string, unknown>> | undefined): string {
  if (!query) {
    return url;
  }

  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    appendQueryValue(parsed, key, value);
  }

  return parsed.toString();
}

/**
 * Appends a single query value; arrays are expanded into repeated keys.
 *
 * @param url the URL object.
 * @param key query key.
 * @param value query value.
 */
function appendQueryValue(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(url, key, item);
    }
    return;
  }

  if (typeof value === "object") {
    url.searchParams.append(key, JSON.stringify(value));
    return;
  }

  url.searchParams.append(key, String(value));
}
