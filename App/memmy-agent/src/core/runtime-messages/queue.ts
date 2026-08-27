import { InboundMessage, OutboundMessage } from "./events.js";

type QueueWaiter<T> = {
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
};

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("AsyncQueue get aborted");
}

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<QueueWaiter<T>> = [];

  put(item: T): void {
    while (this.waiters.length) {
      const waiter = this.waiters.shift()!;
      this.cleanupWaiter(waiter);
      if (waiter.signal?.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.resolve(item);
      return;
    }
    this.items.push(item);
  }

  async get(signal: AbortSignal | null = null): Promise<T> {
    if (signal?.aborted) throw abortReason(signal);
    if (this.items.length > 0) return this.items.shift() as T;
    return new Promise<T>((resolve, reject) => {
      const waiter: QueueWaiter<T> = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        this.removeWaiter(waiter);
        reject(signal ? abortReason(signal) : new Error("AsyncQueue get aborted"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  getNowait(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  private cleanupWaiter(waiter: QueueWaiter<T>): void {
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.onAbort = null;
  }

  private removeWaiter(waiter: QueueWaiter<T>): void {
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
    this.cleanupWaiter(waiter);
  }
}

export class MessageBus {
  inbound: AsyncQueue<InboundMessage>;
  outbound: AsyncQueue<OutboundMessage>;

  constructor() {
    this.inbound = new AsyncQueue<InboundMessage>();
    this.outbound = new AsyncQueue<OutboundMessage>();
  }

  async publishInbound(message: InboundMessage): Promise<void> {
    this.inbound.put(message);
  }

  async publishOutbound(message: OutboundMessage): Promise<void> {
    this.outbound.put(message);
  }

  async nextInbound(signal: AbortSignal | null = null): Promise<InboundMessage> {
    return this.inbound.get(signal);
  }

  async nextOutbound(signal: AbortSignal | null = null): Promise<OutboundMessage> {
    return this.outbound.get(signal);
  }

  async consumeOutbound(signal: AbortSignal | null = null): Promise<OutboundMessage> {
    return this.nextOutbound(signal);
  }

  async consumeInbound(signal: AbortSignal | null = null): Promise<InboundMessage> {
    return this.nextInbound(signal);
  }

  get inboundSize(): number {
    return this.inbound.size;
  }

  get outboundSize(): number {
    return this.outbound.size;
  }
}
