/** Verification failures with HTTP status and an optional retry delay. */
export class VerificationRequestError extends Error {
  readonly code: "rate_limited" | "internal";

  constructor(message: string, readonly status: 429 | 500 | 504, readonly retryAfterSec?: number) {
    super(message);
    this.name = "VerificationRequestError";
    this.code = status === 429 ? "rate_limited" : "internal";
  }
}

/** Leaves definitive validation/authentication failures available for immediate correction. */
export function toVerificationRequestError(error: unknown, retryAfterSec?: number): VerificationRequestError | null {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (code === "invalid_argument" || code === "unauthorized" || code === "forbidden") return null;
  const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
  const timeout = error instanceof Error && (error.name === "TimeoutError" || status === 408 || status === 504);
  let httpStatus: 429 | 500 | 504 = 500;
  if (code === "rate_limited" || status === 429) {
    httpStatus = 429;
  } else if (timeout) {
    httpStatus = 504;
  }
  return new VerificationRequestError(
    error instanceof Error ? error.message : "Verification request failed",
    httpStatus,
    retryAfterSec
  );
}
