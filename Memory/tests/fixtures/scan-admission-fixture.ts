/** Unit-only service doubles do not own a concurrency controller. Integration
 * admission tests use the real MemoryService instead of this fixture. */
export async function withUnrestrictedScanPermit<T>(
  _sourceId: string | readonly string[], signal: AbortSignal, operation: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  return operation();
}
