/** Prevents the main window and desktop pet from notifying for the same delivery. */
export class TaskDoneNotificationDeduplicator {
  private readonly deliveredAtById = new Map<string, number>();

  constructor(
    private readonly options: {
      now?: () => number;
      maxEntries?: number;
      retentionMs?: number;
    } = {},
  ) {}

  shouldNotify(deliveryId?: string): boolean {
    // Ordinary task completions have no delivery identity and retain their behavior.
    if (typeof deliveryId !== "string" || !deliveryId.trim()) return true;
    const now = this.options.now?.() ?? Date.now();
    const retentionMs = this.options.retentionMs ?? 24 * 60 * 60 * 1000;
    for (const [id, deliveredAt] of this.deliveredAtById) {
      if (now - deliveredAt >= retentionMs) this.deliveredAtById.delete(id);
    }
    if (this.deliveredAtById.has(deliveryId)) return false;
    this.deliveredAtById.set(deliveryId, now);
    const maxEntries = Math.max(1, this.options.maxEntries ?? 4096);
    while (this.deliveredAtById.size > maxEntries) {
      this.deliveredAtById.delete(this.deliveredAtById.keys().next().value!);
    }
    return true;
  }
}
