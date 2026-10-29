import { createHash, randomUUID } from 'node:crypto';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { ManagedOcuSession, OcuBlocked } from './managed-ocu-session.js';
import { NativeAppLeases } from './native-app-leases.js';

export type ManagedOcuHost = Pick<ManagedOcuSession,
  'invoke' | 'finishTurn' | 'presentModelResult' | 'permissionDenied'> & Partial<Pick<ManagedOcuSession, 'appKeyFor'>>;

function taskKey(context: RequestContext | null): string | null {
  const scope = [context?.sessionKey, context?.channel, context?.chatId];
  const task = context?.metadata.turnId ?? context?.metadata.turn_id ?? context?.messageId;
  if (!scope.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    || typeof task !== 'string' || !task || task.length > 256) return null;
  return JSON.stringify([...scope, task]);
}

/** Connections, waiting queues and uncertain dispatches belong to one runtime task. */
export class ManagedOcuSessionPool implements ManagedOcuHost {
  private readonly poolId = randomUUID();
  private readonly tasks = new Map<string, ManagedOcuSession>();
  private readonly finished = new Set<string>();
  private readonly results = new WeakMap<object, ManagedOcuSession>();
  private readonly appLeases = new NativeAppLeases();
  private discovery: ManagedOcuSession | null = null;
  private closed = false;

  constructor(private readonly create: (ownerId: string, appLeases: NativeAppLeases) => ManagedOcuSession) {}

  private ownerId(key: string): string {
    return createHash('sha256').update(this.poolId).update(key).digest('hex').slice(0, 32);
  }

  private discoverySession(): ManagedOcuSession {
    if (this.closed) throw new OcuBlocked({ state: 'unknown' });
    return this.discovery ??= this.create(this.ownerId('discovery'), this.appLeases);
  }

  async initialize(): Promise<void> { await this.discoverySession().initialize(); }
  async listTools(): Promise<any> { return this.discoverySession().listTools(); }
  async listResources(): Promise<any> { return { resources: [] }; }
  async listPrompts(): Promise<any> { return { prompts: [] }; }

  async invoke(name: string, args: Record<string, any>, timeout: number, context: RequestContext | null,
    signal?: AbortSignal | null, options: { modelVisible?: boolean } = {}): Promise<any> {
    signal?.throwIfAborted();
    if (this.closed) throw new OcuBlocked({ state: 'unknown' });
    const key = taskKey(context);
    if (!key && name !== 'list_apps') throw new OcuBlocked({ state: 'unknown', reason: 'requestUnavailable' });
    if (key && this.finished.has(key)) return { isError: true,
      _meta: { memmyComputerUse: { noActionDispatched: true } }, content: [{ type: 'text', text:
        'This Computer Use task has finished. The action was not sent. Start from a fresh observation in a new request.' }] };
    let owner = key ? this.tasks.get(key) : this.discoverySession();
    if (!owner) {
      owner = this.create(this.ownerId(key!), this.appLeases);
      this.tasks.set(key!, owner);
    }
    const result = await owner.invoke(name, args, timeout, context, signal, options);
    if (result && typeof result === 'object') this.results.set(result, owner);
    return result;
  }

  presentModelResult(name: string, args: Record<string, any>, result: any, output: any,
    context: RequestContext | null): any {
    const key = taskKey(context);
    if (this.closed || (key && this.finished.has(key))) return output;
    const owner = result && typeof result === 'object' ? this.results.get(result) : undefined;
    // A late result must never create a connection or update another task's observations.
    return owner?.presentModelResult(name, args, result, output, context) ?? output;
  }

  appKeyFor(result: unknown): string | undefined {
    const owner = result && typeof result === 'object' ? this.results.get(result) : undefined;
    return owner?.appKeyFor(result);
  }

  permissionDenied(context: RequestContext | null,
    permission: 'accessibility' | 'screenRecording' | 'inputMonitoring'): void {
    const key = taskKey(context);
    if (key) this.tasks.get(key)?.permissionDenied(context, permission);
  }

  async finishTurn(context: RequestContext | null): Promise<void> {
    const key = taskKey(context);
    if (!key || this.finished.has(key)) return;
    this.finished.add(key);
    const owner = this.tasks.get(key);
    this.tasks.delete(key);
    // Abort transport and task-owned native process immediately. Enqueueing cleanup
    // behind a hung native action would prevent a stopped task from releasing resources.
    await owner?.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const owners = [...this.tasks.values(), ...(this.discovery ? [this.discovery] : [])];
    this.tasks.clear();
    this.discovery = null;
    const settled = await Promise.allSettled(owners.map(owner => owner.close()));
    const failure = settled.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
