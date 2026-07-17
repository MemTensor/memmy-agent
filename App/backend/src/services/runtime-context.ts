/** Runtime context module. */

/** Contract for runtime context. */
export interface RuntimeContext {
  adapterId: string;
  requestId?: string;
  signal?: AbortSignal;
}
