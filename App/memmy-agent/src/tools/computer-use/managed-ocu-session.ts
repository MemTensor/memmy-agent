import { isDeepStrictEqual } from 'node:util';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { MEMMY_COMPUTER_USE_MCP_SERVER } from '../../config/computer-use-server.js';
import { MacPermissionPreflight, type PermissionPreflight } from './mac-permission-preflight.js';
import { computerUsePermissionError } from './mac-permission-settings.js';
import { OcuUserIntervened, withMacFocusGuard } from './mac-focus-guard.js';
import { replaceOccludedWindowsFrame } from './windows-window-capture.js';
import { NativeAppApprovalDenied, NativeAppApprovalGate,
  resolveNativeAppIdentity } from './native-app-approvals.js';
import { beginLockedMacAction, releaseLockedMacAction } from './locked-mac-use.js';
import { NativeAxDiffPresenter } from './native-ax-diff.js';

export const OCU_TOOLS = new Set(['list_apps', 'get_app_state', 'click', 'drag', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text']);
export type OcuConnection = { session: any; close(): Promise<void> };
export class OcuBlocked extends Error {
  constructor(public readonly status: PermissionPreflight, message = 'Computer Use permission check failed') { super(message); }
}
export class OcuUncertain extends Error {}
const WINDOWS_FOCUS_GUARD_STOP = 'WINDOWS_FOCUS_GUARD_STOP: ';

function windowsFocusGuardStop(result: any): string | null {
  if (result?.isError !== true || !Array.isArray(result.content) || result.content.length !== 1) return null;
  const item = result.content[0];
  return item?.type === 'text' && typeof item.text === 'string' && item.text.startsWith(WINDOWS_FOCUS_GUARD_STOP)
    ? item.text.slice(WINDOWS_FOCUS_GUARD_STOP.length) : null;
}

/** One owner per configured server. Never retry a dispatched action. */
export class ManagedOcuSession {
  private connection: OcuConnection | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private needsReconnect = false;
  private schemas: Array<[string, unknown]> | null = null;
  private generation = 0;
  private cachedTools: any = null;
  private permissionsPaused = false;
  private readonly lifetime = new AbortController();
  private cohort: { pending: number; checked?: { generation: number; status: PermissionPreflight } } | null = null;
  readonly preflight: MacPermissionPreflight;
  private readonly appApprovals: NativeAppApprovalGate | null;
  private readonly platform: NodeJS.Platform;
  private readonly axDiffPresenter = new NativeAxDiffPresenter();
  private presentationRevision = 0;
  private readonly resultRevisions = new WeakMap<object, { revision: number; generation: number }>();

  constructor(
    private readonly connect: () => Promise<OcuConnection>,
    private readonly probe: (session: any, signal?: AbortSignal | null, requireScreenshot?: boolean) => Promise<PermissionPreflight>,
    private readonly guide?: (status: PermissionPreflight, signal?: AbortSignal | null,
      check?: () => Promise<PermissionPreflight>, canContinue?: boolean,
      observe?: (signal?: AbortSignal) => Promise<PermissionPreflight>) => Promise<boolean | void>,
    private readonly stopHelperForPermissions?: () => Promise<void>,
    options: { appApprovals?: NativeAppApprovalGate | null; platform?: NodeJS.Platform;
      passivePermissionStatus?: (signal?: AbortSignal) => Promise<PermissionPreflight> } = {},
  ) {
    this.preflight = new MacPermissionPreflight(signal => probe(this.connection!.session, signal));
    // The desktop session passes the shared app gate. An app that is not
    // allowed once for this message, or always allowed in settings, never
    // receives the click. Tests can pass null to exercise other policies.
    this.appApprovals = options.appApprovals ?? null;
    this.platform = options.platform ?? process.platform;
    this.passivePermissionStatus = options.passivePermissionStatus;
  }
  private readonly passivePermissionStatus?: (signal?: AbortSignal) => Promise<PermissionPreflight>;
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
      if (tools.length !== OCU_TOOLS.size || new Set(tools.map(t => t.name)).size !== OCU_TOOLS.size || tools.some(t => !OCU_TOOLS.has(t.name))) throw new Error('Expected the Memmy Computer Use tool set');
      const schemas = tools.map(t => [t.name, t.inputSchema] as [string, unknown]);
      // The native helper can serialize Swift dictionary keys in a different
      // order after restarting. Compare JSON values, not their serialized order.
      if (this.schemas && !isDeepStrictEqual(schemas, this.schemas)) throw new Error('Computer Use tool schema changed; reload the MCP configuration');
      if (this.closed) throw new Error('Computer Use connection was removed');
      this.schemas = schemas;
      this.cachedTools = result;
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
  async listTools(): Promise<any> { return this.exclusive(async () => { if (this.permissionsPaused && this.cachedTools) return this.cachedTools; await this.open(); return this.connection!.session.listTools(); }); }
  async listResources(): Promise<any> { return { resources: [] }; }
  async listPrompts(): Promise<any> { return { prompts: [] }; }

  private async pauseForPermissions(): Promise<void> {
    this.permissionsPaused = true;
    this.needsReconnect = true;
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
    await this.stopHelperForPermissions?.();
  }

  private async recheckForGuide(signal?: AbortSignal | null, requireScreenshot = false): Promise<PermissionPreflight> {
    if (signal?.aborted || this.closed) return { state: 'unknown' };
    let status: PermissionPreflight;
    try {
      await this.replace();
      status = await this.probe(this.connection!.session, signal, requireScreenshot);
    } catch { status = { state: 'unknown', reason: 'probeFailed' }; }
    // Even a successful check stops the helper again, so changing a switch in
    // Settings cannot ask macOS to relaunch an arbitrary same-name installation.
    try { await this.pauseForPermissions(); }
    catch { return { state: 'unknown', reason: 'helperPauseFailed' }; }
    return status;
  }

  private async showGuide(status: PermissionPreflight, signal?: AbortSignal | null, canContinue = false): Promise<PermissionPreflight> {
    const actionable = status.state === 'missing' || (status.state === 'unknown' && status.reason === 'screenCaptureUnavailable');
    if (!actionable || !this.guide || signal?.aborted || this.closed) return status;
    const requireScreenshot = (status.state === 'missing' && status.permission === 'screenRecording')
      || (status.state === 'unknown' && status.reason === 'screenCaptureUnavailable');
    if (this.stopHelperForPermissions) {
      try {
        await this.pauseForPermissions();
      } catch {
        return { state: 'unknown', reason: 'helperPauseFailed' };
      }
    }
    const approved = !signal?.aborted && !this.closed
      && await this.guide(status, signal, () => this.recheckForGuide(signal, requireScreenshot), canContinue,
        this.passivePermissionStatus).catch(() => false);
    // The status-only doctor reads Memmy's shared TCC identity. It may have
    // started its background app agent while the guide was open.
    if (this.passivePermissionStatus) {
      try { await this.stopHelperForPermissions?.(); }
      catch { return { state: 'unknown', reason: 'helperPauseFailed' }; }
    }
    // Never resume based on UI state alone, or replay an already dispatched action.
    if (approved === true && canContinue && !signal?.aborted && !this.closed) {
      await this.replace();
      const fresh = await this.probe(this.connection!.session, signal, requireScreenshot);
      if (fresh.state === 'granted' && !signal?.aborted && !this.closed) {
        this.permissionsPaused = false;
        return fresh;
      }
      await this.pauseForPermissions();
      return signal?.aborted ? { state: 'unknown' } : fresh;
    }
    return status;
  }

  async invoke(name: string, args: Record<string, any>, timeout: number, context: RequestContext | null, signal?: AbortSignal | null): Promise<any> {
    // Every invocation counts, including UI surface calls whose results the model never sees.
    const presentationRevision = ++this.presentationRevision;
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
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
      let rebuilt = false;
      let authorizedArgs = args;
      try {
        // Only a new interactive message may restart a helper paused for setup.
        this.permissionsPaused = false;
        if (this.needsReconnect) { await this.replace(); rebuilt = true; }
        else await this.open();
        try { await this.connection!.session.ping(); }
        catch (error) { if (rebuilt) throw error; await this.replace(); rebuilt = true; }
        // Ask in Memmy before any target operation. The native operation checks
        // only the OS permissions it actually needs and reports missing access.
        // list_apps only resolves the target's stable identity; no app action is sent.
        if (this.appApprovals && protectedTool) {
          const target = args.app ?? args.app_name ?? args.application;
          if (typeof target !== 'string' || !target.trim()
            || (this.platform !== 'darwin' && this.platform !== 'win32')) throw new NativeAppApprovalDenied();
          let listing: unknown;
          try { listing = await this.connection!.session.callTool('list_apps', {}, timeout); }
          catch { throw new NativeAppApprovalDenied('Computer Use could not verify the target app identity. The operation was not sent.'); }
          const app = resolveNativeAppIdentity(listing, target, this.platform);
          if (!app) throw new NativeAppApprovalDenied('Computer Use could not verify the target app identity. The operation was not sent.');
          await this.appApprovals.authorize({ platform: app.platform, appId: app.appId,
            displayName: app.displayName }, context);
          if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
          const key = typeof args.app === 'string' ? 'app' : typeof args.app_name === 'string' ? 'app_name' : 'application';
          authorizedArgs = { ...args, [key]: app.runtimeSelector ?? app.appId };
        }
      } catch (error) {
        if (error instanceof OcuBlocked || error instanceof NativeAppApprovalDenied) throw error;
        this.needsReconnect = true;
        this.preflight.block(context);
        cohort.checked = { generation: this.generation, status: { state: 'unknown' } };
        throw new OcuBlocked({ state: 'unknown' });
      }
      if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
      let lockedLease: Awaited<ReturnType<typeof beginLockedMacAction>>;
      try {
        lockedLease = protectedTool ? await beginLockedMacAction(context) : null;
      } catch {
        this.preflight.block(context);
        throw new OcuBlocked({ state: 'unknown' }, 'Locked Mac use was not authorized; no app action was sent.');
      }
      try {
        if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
        const call = () => this.connection!.session.callTool(name, authorizedArgs, timeout);
        let result = process.platform === 'darwin' && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
          ? await withMacFocusGuard(String(authorizedArgs.app ?? authorizedArgs.app_name ?? authorizedArgs.application ?? ''), name, call)
          : await call();
        if (this.platform === 'win32' && name !== 'list_apps' && name !== 'get_app_state') {
          const guardStop = windowsFocusGuardStop(result);
          if (guardStop !== null) throw new OcuUserIntervened(guardStop);
        }
        if (process.platform === 'win32' && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
            && name === 'get_app_state' && result?.isError !== true) {
          result = await replaceOccludedWindowsFrame(result, String(args.app ?? ''), signal);
        }
        if (signal?.aborted) throw new Error('cancelled after dispatch');
        const permission = computerUsePermissionError(MEMMY_COMPUTER_USE_MCP_SERVER, result);
        if (permission) {
          this.permissionDenied(context, permission);
          const status = await this.showGuide({ state: 'missing', permission }, signal);
          cohort.checked = { generation: this.generation, status };
          this.preflight.remember(context, status, this.generation);
          if (status.state === 'unknown' && status.reason === 'helperPauseFailed') throw new OcuBlocked(status);
        }
        if (result && typeof result === 'object') {
          this.resultRevisions.set(result, { revision: presentationRevision, generation: this.generation });
        }
        return result;
      } catch (error) {
        if (error instanceof OcuUserIntervened) {
          this.preflight.block(context);
          throw error;
        }
        if (error instanceof OcuBlocked) throw error;
        this.needsReconnect = true;
        this.preflight.block(context);
        cohort.checked = { generation: this.generation, status: { state: 'unknown' } };
        throw new OcuUncertain('Computer Use disconnected during the operation. Its result is unknown and it was not replayed.');
      } finally {
        try { await releaseLockedMacAction(lockedLease); }
        catch (error) {
          this.preflight.block(context);
          if (error instanceof OcuUserIntervened) throw error;
          throw new OcuUncertain('The app action may have completed, but Memmy could not verify that the Mac relocked. The action was not replayed.');
        }
      }
    }).finally(() => { if (--cohort.pending === 0 && this.cohort === cohort) this.cohort = null; });
  }
  presentModelResult(name: string, args: Record<string, any>, result: any, output: any, context: RequestContext | null): any {
    if (this.platform !== 'darwin') return output;
    const stamp = result && typeof result === 'object' ? this.resultRevisions.get(result) : undefined;
    return this.axDiffPresenter.present(name, args, result, output, context,
      stamp?.revision ?? null, this.presentationRevision, stamp?.generation ?? this.generation);
  }
  permissionDenied(context: RequestContext | null, permission: 'accessibility' | 'screenRecording' | 'inputMonitoring'): void {
    this.preflight.deny(context, permission);
    this.needsReconnect = true;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.axDiffPresenter.clear();
    this.lifetime.abort();
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }
}
