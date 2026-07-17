import { ApiErrorBodySchema, type ApiErrorCode, type RuntimeConfig } from "@memmy/local-api-contracts";

export interface ParsableSchema<T> {
  parse(value: unknown): T;
}

export interface RequestJsonInput<T> {
  config: RuntimeConfig;
  path: string;
  schema: ParsableSchema<T>;
  init?: RequestInit;
  body?: unknown;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;
  readonly requestId: string | null;

  constructor(message: string, status: number, code: ApiErrorCode | null = null, requestId: string | null = null) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export async function requestJson<T>(input: RequestJsonInput<T>): Promise<T> {
  const headers: Record<string, string> = {
    "x-memmy-local-token": input.config.localToken
  };
  if (input.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(new URL(input.path, input.config.baseUrl), {
    ...input.init,
    method: input.init?.method ?? (input.body === undefined ? "GET" : "POST"),
    headers: {
      ...headers,
      ...input.init?.headers
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body)
  });

  if (!response.ok) {
    throw await toApiRequestError(response, input.path);
  }

  return input.schema.parse(await response.json());
}

async function toApiRequestError(response: Response, path: string): Promise<ApiRequestError> {
  const rawBody = await readJsonSafely(response);
  const parsedError = ApiErrorBodySchema.safeParse(rawBody);

  if (parsedError.success) {
    return new ApiRequestError(
      parsedError.data.error.message,
      response.status,
      parsedError.data.error.code,
      parsedError.data.error.requestId
    );
  }

  return new ApiRequestError(`Request ${path} failed with status ${response.status}`, response.status);
}

/**
 * Reads the JSON response body with fault tolerance.
 *
 * @param response The raw fetch response.
 * @returns The JSON object; returns null for non-JSON or empty responses.
 */
async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
