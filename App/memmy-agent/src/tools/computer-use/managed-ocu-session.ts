import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { MacPermissionPreflight, type PermissionPreflight } from './mac-permission-preflight.js';
import { computerUsePermissionError } from './mac-permission-settings.js';

export const OCU_TOOLS = new Set(['list_apps', 'get_app_state', 'click', 'drag', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text']);
export type OcuConnection = { session: any; close(): Promise<void> };
export class OcuBlocked extends Error {
  constructor(public readonly status: PermissionPreflight, message = 'Computer Use permission check failed') { super(message); }
}
export class OcuUncertain extends Error {}

/** One owner per configured server. Never retry a dispatched action. */
export class ManagedOcuSession {
  private connection: OcuConnection | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private needsReconnect = false;
  private schemas = '';
  private generation = 0;
  private cohort: { pending: number; checked?: { generation: number; status: PermissionPreflight } } | null = null;
  readonly preflight: MacPermissionPreflight;

  constructor(private readonly connect: () => Promise<OcuConnection>, doctor: () => Promise<PermissionPreflight>) {
    this.preflight = new MacPermissionPreflight(doctor);
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async open(): Promise<void> {
    if (this.closed) throw new Error('Computer Use connection was removed');
    if (this.connection) return;
    const connection = await this.connect();
    if (this.closed) { await connection.close(); throw new Error('Computer Use connection was removed'); }
    try {
      const result = await connection.session.listTools();
      const tools = [...(result.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      if (tools.length !== OCU_TOOLS.size || new Set(tools.map(t => t.name)).size !== OCU_TOOLS.size || tools.some(t => !OCU_TOOLS.has(t.name))) throw new Error('Expected the unmodified Open Computer Use 0.3.5 tool set');
      const schemas = JSON.stringify(tools.map(t => [t.name, t.inputSchema]));
      if (this.schemas && schemas !== this.schemas) throw new Error('Computer Use tool schema changed; reload the MCP configuration');
      if (this.closed) throw new Error('Computer Use connection was removed');
      this.schemas = schemas;
      this.connection = connection;
      this.generation++;
    } catch (error) { await connection.close(); throw error; }
  }
  private async replace(): Promise<void> {
    const previous = this.connection;
    this.connection = null;
    await previous?.close();
    await this.open();
    this.needsReconnect = false;
  }
  async initialize(): Promise<void> { await this.exclusive(() => this.open()); }
  async listTools(): Promise<any> { return this.exclusive(async () => { await this.open(); return this.connection!.session.listTools(); }); }
  async listResources(): Promise<any> { return { resources: [] }; }
  async listPrompts(): Promise<any> { return { prompts: [] }; }

  async invoke(name: string, args: Record<string, any>, timeout: number, context: RequestContext | null, signal?: AbortSignal | null): Promise<any> {
    const cohort = this.cohort ??= { pending: 0 };
    cohort.pending++;
    return this.exclusive(async () => {
      if (this.closed || signal?.aborted) throw new OcuBlocked({ state: 'unknown' });
      if (!OCU_TOOLS.has(name)) throw new OcuBlocked({ state: 'unknown' }, 'Unsupported Computer Use tool policy');
      const protectedTool = name !== 'list_apps';
      // A failed user message remains blocked across connection generations.
      const blocked = this.preflight.blocked(context);
      if (protectedTool && blocked) throw new OcuBlocked(await blocked);
      if (protectedTool && cohort.checked?.status.state !== 'granted' && cohort.checked) {
        this.preflight.remember(context, cohort.checked.status, this.generation);
        throw new OcuBlocked(cohort.checked.status);
      }
      const check = async () => {
        const status = cohort.checked?.generation === this.generation ? cohort.checked.status : await this.preflight.check(context, this.generation);
        cohort.checked = { generation: this.generation, status };
        this.preflight.remember(context, status, this.generation);
        return status;
      };
      let rebuilt = false;
      try {
        if (this.needsReconnect) { await this.replace(); rebuilt = true; }
        else await this.open();
        try { await this.connection!.session.ping(); }
        catch (error) { if (rebuilt) throw error; await this.replace(); rebuilt = true; }
        if (protectedTool) {
          let status = await check();
          if (status.state !== 'granted') { this.needsReconnect = true; throw new OcuBlocked(status); }
          try { await this.connection!.session.ping(); }
          catch (error) {
            if (rebuilt) throw error;
            await this.replace(); rebuilt = true;
            status = await check();
            if (status.state !== 'granted') { this.needsReconnect = true; throw new OcuBlocked(status); }
          }
        }
      } catch (error) {
        if (error instanceof OcuBlocked) throw error;
        this.needsReconnect = true;
        this.preflight.block(context);
        cohort.checked = { generation: this.generation, status: { state: 'unknown' } };
        throw new OcuBlocked({ state: 'unknown' });
      }
      if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
      try {
        const result = await this.connection!.session.callTool(name, args, timeout);
        if (signal?.aborted) throw new Error('cancelled after dispatch');
        const permission = computerUsePermissionError('open_computer_use', result);
        if (permission) {
          this.permissionDenied(context, permission);
          cohort.checked = { generation: this.generation, status: { state: 'missing', permission } };
        }
        return result;
      } catch {
        this.needsReconnect = true;
        this.preflight.block(context);
        cohort.checked = { generation: this.generation, status: { state: 'unknown' } };
        throw new OcuUncertain('Computer Use disconnected during the operation. Its result is unknown and it was not replayed.');
      }
    }).finally(() => { if (--cohort.pending === 0 && this.cohort === cohort) this.cohort = null; });
  }
  permissionDenied(context: RequestContext | null, permission: 'accessibility' | 'screenRecording' | 'inputMonitoring'): void {
    this.preflight.deny(context, permission);
    this.needsReconnect = true;
  }
  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }
}
