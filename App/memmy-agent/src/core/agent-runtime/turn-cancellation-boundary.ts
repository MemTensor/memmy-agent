export type TurnCancellationReason = "aborted" | "ended";

export type TurnCancellationBoundary = {
  readonly turnId: string;
  readonly signal: AbortSignal | null;
  isClosed(): boolean;
  isAborted(): boolean;
  close(reason: TurnCancellationReason): void;
  metadata(): { turnId: string; turn_id: string };
  shouldEmitLive(): boolean;
  throwIfAborted(): void;
};

export function createAbortError(): Error {
  const error = new Error("task cancelled");
  error.name = "AbortError";
  return error;
}

export function createTurnCancellationBoundary({
  turnId,
  signal = null,
}: {
  turnId: string;
  signal?: AbortSignal | null;
}): TurnCancellationBoundary {
  let closed: TurnCancellationReason | null = null;
  const boundary: TurnCancellationBoundary = {
    turnId,
    signal,
    isClosed: () => closed !== null,
    isAborted: () => closed !== null || signal?.aborted === true,
    close: (reason: TurnCancellationReason) => {
      closed ??= reason;
    },
    metadata: () => ({ turnId, turn_id: turnId }),
    shouldEmitLive: () => !boundary.isAborted(),
    throwIfAborted: () => {
      if (boundary.isAborted()) throw createAbortError();
    },
  };
  return boundary;
}
