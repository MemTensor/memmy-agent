/** Error envelope module. */
import { ZodError } from "zod";
import { MemoryLayerError } from "../adapters/outbound/memory-client/index.js";
import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";

export const API_ERROR_CODES = [
  "invalid_argument",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal",
  "memory_layer_unavailable",
  "missing_idempotency_key",
  "idempotency_body_mismatch",
  "scan_not_permitted",
  "memory_recall_not_permitted",
  "skill_write_not_permitted",
  "agent_source_unavailable",
  "composio_not_configured",
  "toolkit_unsupported"
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const HTTP_STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = Object.freeze({
  invalid_argument: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
  memory_layer_unavailable: 503,
  missing_idempotency_key: 400,
  idempotency_body_mismatch: 409,
  scan_not_permitted: 403,
  memory_recall_not_permitted: 403,
  skill_write_not_permitted: 403,
  agent_source_unavailable: 409,
  composio_not_configured: 400,
  toolkit_unsupported: 400
});

export interface ApiError extends Error {
  code: ApiErrorCode;
  cause?: unknown;
}

interface ErrorEnvelope {
  code: ApiErrorCode;
  status: number;
  message: string;
}

/** Handles with error envelope. */
export function withErrorEnvelope<Reply>(
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<Reply>
): RouteHandlerMethod {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      const envelope = toErrorEnvelope(error);
      return reply.code(envelope.status).send({
        error: {
          code: envelope.code,
          message: envelope.message,
          requestId: extractRequestId(request)
        }
      });
    }
  };
}

/** Handles to error envelope. */
function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof ZodError) {
    return {
      code: "invalid_argument",
      status: HTTP_STATUS_BY_CODE.invalid_argument,
      message: error.issues[0]?.message ?? "invalid argument"
    };
  }

  if (error instanceof MemoryLayerError) {
    const code = isApiErrorCode(error.code) ? error.code : "internal";
    return {
      code,
      status: error.status,
      message: error.message
    };
  }

  if (error instanceof Error && hasApiErrorCode(error)) {
    return {
      code: error.code,
      status: HTTP_STATUS_BY_CODE[error.code],
      message: error.message
    };
  }

  if (error instanceof Error) {
    return {
      code: "internal",
      status: HTTP_STATUS_BY_CODE.internal,
      message: error.message
    };
  }

  return {
    code: "internal",
    status: HTTP_STATUS_BY_CODE.internal,
    message: "internal error"
  };
}

/** Handles extract request id. */
function extractRequestId(request: FastifyRequest): string {
  const body = request.body;
  if (body && typeof body === "object" && "requestId" in body) {
    const requestId = (body as { requestId?: unknown }).requestId;
    if (typeof requestId === "string" && requestId.length > 0) {
      return requestId;
    }
  }

  const headerValue = request.headers["x-request-id"] ?? request.headers["x-requestid"];
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return typeof header === "string" && header.length > 0 ? header : "unknown";
}

/** Checks is api error code. */
function isApiErrorCode(code: string): code is ApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(code);
}

/** Checks has api error code. */
function hasApiErrorCode(error: Error): error is ApiError {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && isApiErrorCode(code);
}
