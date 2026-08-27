/** Errors module. */

/** Implementation of memory layer error. */
export class MemoryLayerError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "MemoryLayerError";
  }
}

/** Implementation of memory layer network error. */
export class MemoryLayerNetworkError extends Error {
  constructor(public readonly cause: unknown) {
    super("memory layer network error");
    this.name = "MemoryLayerNetworkError";
  }
}
