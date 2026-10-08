import { normalizeBrowserCdpEventQuery, type BrowserCdpTarget } from '@memmy/local-api-contracts';

type Event = { sequence: number; method: string; source: { tabId: number; sessionId?: string; targetId?: string };
  params?: Record<string, unknown> };

export class BrowserCdpEventBuffer {
  private nextSequence = 1;
  private readonly events: Event[] = [];
  private readonly waiters = new Set<() => void>();

  clear(): void { this.events.length = 0; this.wake(); }

  cursor(): number { return this.nextSequence - 1; }

  private wake(): void { for (const waiter of this.waiters) waiter(); }

  record(method: string, value: unknown, source: Event['source']): void {
    if (!/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) return;
    let params: Record<string, unknown> | undefined;
    try {
      const encoded = JSON.stringify(value);
      if (encoded && encoded.length <= 16_000) params = JSON.parse(encoded) as Record<string, unknown>;
    } catch { /* Omit oversized or unserializable event parameters. */ }
    this.events.push({ sequence: this.nextSequence++, method, source, ...(params ? { params } : {}) });
    if (this.events.length > 500) this.events.shift();
    this.wake();
  }

  read(input: unknown): { cursor: number; events: Event[]; hasMore: boolean; truncated: boolean } {
    const query = normalizeBrowserCdpEventQuery(input);
    const latest = this.nextSequence - 1;
    if (query.afterSequence === undefined) return { cursor: latest, events: [], hasMore: false, truncated: false };
    const first = this.events[0]?.sequence ?? this.nextSequence;
    const eligible = this.events.filter(event => event.sequence > query.afterSequence!
      && (!query.methods || query.methods.includes(event.method))
      && (!query.target || this.matchesTarget(event, query.target)));
    const events = eligible.slice(0, query.limit);
    return { cursor: events.at(-1)?.sequence ?? Math.max(query.afterSequence, latest),
      events, hasMore: eligible.length > events.length, truncated: query.afterSequence < first - 1 };
  }

  async wait(input: unknown, isCurrent: () => boolean): Promise<ReturnType<BrowserCdpEventBuffer['read']>> {
    const query = normalizeBrowserCdpEventQuery(input);
    const afterSequence = query.afterSequence ?? this.cursor();
    const effective = { ...query, afterSequence };
    const deadline = Date.now() + (query.timeoutMs ?? 0);
    while (true) {
      if (!isCurrent()) throw new Error('Browser CDP events are no longer approved');
      const result = this.read(effective);
      if (result.events.length || result.truncated || Date.now() >= deadline) return result;
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        this.waiters.add(wake);
        const timer = setTimeout(wake, Math.min(deadline - Date.now(), 250));
      });
    }
  }

  private matchesTarget(event: Event, target: BrowserCdpTarget): boolean {
    return 'sessionId' in target ? event.source.sessionId === target.sessionId
      : event.source.targetId === target.targetId;
  }
}
