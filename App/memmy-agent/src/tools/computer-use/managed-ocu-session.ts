import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RequestContext } from '../../core/agent-runtime/tools/context.js';
import { MEMMY_COMPUTER_USE_MCP_SERVER } from '../../config/computer-use-server.js';
import { MacPermissionPreflight, type PermissionPreflight } from './mac-permission-preflight.js';
import { computerUsePermissionError } from './mac-permission-settings.js';
import { OcuUserIntervened, OcuUserYielded, waitForMacTargetIdle, withMacFocusGuard } from './mac-focus-guard.js';
import { replaceOccludedWindowsFrame, WINDOWS_MAX_CAPTURE_DIMENSION, windowsCapturedPngMatchesSize, windowsWindowCaptureClient, type WindowsWindowCaptureClient } from './windows-window-capture.js';
import { NativeAppApprovalDenied, NativeAppApprovalGate,
  resolveNativeAppIdentity, resolveInstalledAppIdentity, InstalledAppIdentityLookupError } from './native-app-approvals.js';
import { NativeConnectionStageError, recordNativeFailure, type NativeDiagnosticStage } from './native-diagnostics.js';
import { NativeAxDiffPresenter } from './native-ax-diff.js';
import { mcpTargetWindowId } from './surface-preview.js';
import { isWindowsWindowID, waitForWindowsTargetIdle } from './windows-focus-guard.js';
import { nativeAppKey } from './native-app-key.js';
import { NativeAppLeases } from './native-app-leases.js';

export const OCU_TOOLS = new Set(['list_apps', 'get_app_state', 'click', 'drag', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text']);
export type OcuConnection = { session: any; close(): Promise<void>;
  /** True when a setting the helper reads only at launch has changed since this connection started. */
  outdated?(): boolean };
export class OcuBlocked extends Error {
  constructor(public readonly status: PermissionPreflight, message = 'Computer Use permission check failed') { super(message); }
}
export class OcuUncertain extends Error {}
const WINDOWS_FOCUS_GUARD_STOP = 'WINDOWS_FOCUS_GUARD_STOP: ';
const MAC_FOCUS_GUARD_YIELD_BEFORE = 'MAC_FOCUS_GUARD_YIELD_BEFORE_DISPATCH: ';
const MAC_FOCUS_GUARD_YIELD_AFTER = 'MAC_FOCUS_GUARD_YIELD_AFTER_DISPATCH: ';
type WindowsImageObservation = { targetKey: string; windowID: number; pid: number;
  generation: number; desktopCapture: boolean };
type NativeTurn = { targetKeys: Set<string> };

function nativeTurnKey(context: RequestContext | null): string | null {
  const scope = [context?.sessionKey, context?.channel, context?.chatId];
  const turnID = context?.metadata.turnId ?? context?.metadata.turn_id;
  if (!scope.every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    || typeof turnID !== 'string' || !turnID || turnID.length > 128) return null;
  return JSON.stringify([...scope, turnID]);
}

function macFocusGuardYield(result: any): { dispatched: boolean } | null {
  if (result?.isError !== true || !Array.isArray(result.content) || result.content.length !== 1) return null;
  const item = result.content[0];
  if (item?.type !== 'text' || typeof item.text !== 'string') return null;
  if (item.text.startsWith(MAC_FOCUS_GUARD_YIELD_BEFORE)) return { dispatched: false };
  if (item.text.startsWith(MAC_FOCUS_GUARD_YIELD_AFTER)) return { dispatched: true };
  return null;
}

function windowsFocusGuardStop(result: any): string | null {
  if (result?.isError !== true || !Array.isArray(result.content) || result.content.length !== 1) return null;
  const item = result.content[0];
  return item?.type === 'text' && typeof item.text === 'string' && item.text.startsWith(WINDOWS_FOCUS_GUARD_STOP)
    ? item.text.slice(WINDOWS_FOCUS_GUARD_STOP.length) : null;
}

function windowsFocusGuardYield(result: any): { dispatched: boolean; pid: number; windowID: number } | null {
  // Only native transport metadata can signal a yield. Window text, page text,
  // and the legacy STOP marker cannot opt an operation into automatic recovery.
  const native = result?._meta?.memmyComputerUse;
  if (result?.isError !== true || typeof native?.userYield?.dispatched !== 'boolean'
    || !Number.isSafeInteger(native.pid) || native.pid <= 0 || !isWindowsWindowID(native.targetWindowID)) return null;
  return { dispatched: native.userYield.dispatched, pid: native.pid, windowID: native.targetWindowID };
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
  private readonly resultRevisions = new WeakMap<object, { revision: number; generation: number;
    targetKey?: string; bindingKey?: string; windowID?: number; observationID?: string }>();
  private readonly targetWindows = new Map<string, number>();
  private readonly modelTargetWindows = new Map<string, number>();
  private readonly modelObservations = new Map<string, { windowID: number; observationID: string }>();
  private readonly windowsImageObservations = new Map<string, WindowsImageObservation>();
  private readonly nativeTurns = new Map<string, NativeTurn>();
  private readonly finishedNativeTurns = new Set<string>();
  private readonly connectionClosures = new WeakMap<OcuConnection, Promise<void>>();
  private connectionShutdown: Promise<void> | null = null;

  private detachWindowsConnection(connection: OcuConnection): Promise<void> {
    if (this.connection === connection) {
      this.connection = null;
      this.needsReconnect = true;
      // A detached helper cannot supply a valid token to a queued invocation
      // or to a late presentation of a previously returned result.
      this.generation++;
      this.targetWindows.clear();
      this.modelTargetWindows.clear();
      this.modelObservations.clear();
      this.windowsImageObservations.clear();
      this.axDiffPresenter.clear();
    }
    const existing = this.connectionClosures.get(connection);
    if (existing) return existing;
    let closing: Promise<void>;
    try { closing = Promise.resolve(connection.close()); }
    catch (error) { closing = Promise.reject(error); }
    this.connectionClosures.set(connection, closing);
    this.connectionShutdown = closing;
    void closing.catch(() => undefined);
    return closing;
  }

  private async callNativeTool(name: string, args: Record<string, any>, timeout: number,
    signal?: AbortSignal | null): Promise<any> {
    const connection = this.connection!;
    if (this.platform !== 'win32') return connection.session.callTool(name, args, timeout);
    signal?.throwIfAborted();
    const timeoutMs = Math.max(1, Math.ceil(timeout * 1000));
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const callSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const stop = (error: unknown) => {
        // Start process shutdown at the cancellation boundary, not after an
        // uncooperative callTool promise eventually completes.
        void this.detachWindowsConnection(connection);
        reject(error);
      };
      cancel = () => stop(signal?.reason ?? new DOMException('Computer Use cancelled', 'AbortError'));
      signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        const error = new Error('Windows Computer Use native call timed out');
        stop(error);
        controller.abort(error);
      }, timeoutMs);
    });
    const request = Promise.resolve().then(() => {
      callSignal.throwIfAborted();
      return connection.session.callTool(name, { ...args,
        _host_deadline_epoch_ms: deadline }, timeout, callSignal);
    });
    try { return await Promise.race([request, cancelled]); }
    catch (error) {
      await this.detachWindowsConnection(connection);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  private rememberWindowsImage(result: any, targetKey: string): void {
    if (!this.windowsCaptureClient || result?.isError === true) return;
    const native = result?._meta?.memmyComputerUse;
    const windowID = mcpTargetWindowId(result, 'win32');
    const image = result?.content?.find((item: any) => item?.type === 'image' && item.mimeType === 'image/png');
    if (windowID === undefined || !Number.isSafeInteger(native?.pid) || native.pid <= 0
      || typeof native.observationID !== 'string' || !native.observationID || native.observationID.length > 128
      || typeof image?.data !== 'string' || native.screenshotIsolated !== true) return;
    const header = Buffer.from(image.data.slice(0, 48), 'base64');
    if (header.length < 24 || header.toString('hex', 0, 8) !== '89504e470d0a1a0a'
      || header.toString('ascii', 12, 16) !== 'IHDR') return;
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    const desktopCapture = native.screenshotSource === 'desktop-capture';
    if (!width || !height || width > WINDOWS_MAX_CAPTURE_DIMENSION || height > WINDOWS_MAX_CAPTURE_DIMENSION
      || (desktopCapture && !windowsCapturedPngMatchesSize(image.data, width, height))) return;
    const key = JSON.stringify([targetKey, native.observationID]);
    this.windowsImageObservations.delete(key);
    // Keep only the source/binding proof. Reliable native pixels live in the
    // helper's ROI history; Electron fallback pixels lack a verified origin.
    this.windowsImageObservations.set(key, { targetKey, windowID, pid: native.pid,
      generation: this.generation, desktopCapture });
    while (this.windowsImageObservations.size > 128)
      this.windowsImageObservations.delete(this.windowsImageObservations.keys().next().value!);
  }

  private targetKey(target: string, context: RequestContext | null): string {
    const messageID = context?.messageId ?? context?.metadata.message_id ?? context?.metadata.messageId
      ?? context?.metadata.turnId ?? context?.metadata.turn_id;
    return JSON.stringify([context?.sessionKey, context?.channel, context?.chatId,
      messageID, target.trim().toLocaleLowerCase()]);
  }
  private rememberWindow(key: string, windowID: number): void {
    this.targetWindows.delete(key);
    this.targetWindows.set(key, windowID);
    while (this.targetWindows.size > 256) this.targetWindows.delete(this.targetWindows.keys().next().value!);
  }
  private windowKey(targetKey: string, windowID: number | undefined): string {
    return windowID === undefined ? targetKey : JSON.stringify([targetKey, windowID]);
  }

  constructor(
    private readonly connect: () => Promise<OcuConnection>,
    private readonly probe: (session: any, signal?: AbortSignal | null, requireScreenshot?: boolean) => Promise<PermissionPreflight>,
    private readonly guide?: (status: PermissionPreflight, signal?: AbortSignal | null,
      check?: () => Promise<PermissionPreflight>, canContinue?: boolean,
      observe?: (signal?: AbortSignal) => Promise<PermissionPreflight>) => Promise<boolean | void>,
    private readonly stopHelperForPermissions?: () => Promise<void>,
    options: { appApprovals?: NativeAppApprovalGate | null; platform?: NodeJS.Platform;
      passivePermissionStatus?: (signal?: AbortSignal) => Promise<PermissionPreflight>;
      macFocusGuard?: typeof withMacFocusGuard;
      macWaitForTargetIdle?: typeof waitForMacTargetIdle;
      windowsWaitForTargetIdle?: typeof waitForWindowsTargetIdle;
      appIdentityResolver?: typeof resolveInstalledAppIdentity;
      windowsCaptureClient?: Pick<WindowsWindowCaptureClient, 'capture'>;
      appLeases?: NativeAppLeases; appWaitMs?: number } = {},
  ) {
    this.appLeases = options.appLeases ?? new NativeAppLeases();
    this.appWaitMs = options.appWaitMs ?? 20_000;
    this.preflight = new MacPermissionPreflight(signal => probe(this.connection!.session, signal));
    // The desktop session passes the shared app gate. An app that is not
    // allowed once for this message, or always allowed in settings, never
    // receives the click. Tests can pass null to exercise other policies.
    this.appApprovals = options.appApprovals ?? null;
    this.platform = options.platform ?? process.platform;
    this.passivePermissionStatus = options.passivePermissionStatus;
    this.macFocusGuard = options.macFocusGuard ?? withMacFocusGuard;
    this.macWaitForTargetIdle = options.macWaitForTargetIdle ?? waitForMacTargetIdle;
    this.windowsWaitForTargetIdle = options.windowsWaitForTargetIdle ?? waitForWindowsTargetIdle;
    this.appIdentityResolver = options.appIdentityResolver ?? resolveInstalledAppIdentity;
    this.windowsCaptureClient = this.platform === 'win32' ? options.windowsCaptureClient
      ?? (process.platform === 'win32' && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
        ? windowsWindowCaptureClient : undefined) : undefined;
  }
  private readonly passivePermissionStatus?: (signal?: AbortSignal) => Promise<PermissionPreflight>;
  private readonly appLeases: NativeAppLeases;
  private readonly appWaitMs: number;
  private readonly leaseOwner = randomUUID();
  private readonly resultApps = new WeakMap<object, string>();
  private readonly macFocusGuard: typeof withMacFocusGuard;
  private readonly macWaitForTargetIdle: typeof waitForMacTargetIdle;
  private readonly windowsWaitForTargetIdle: typeof waitForWindowsTargetIdle;
  private readonly appIdentityResolver: typeof resolveInstalledAppIdentity;
  private readonly windowsCaptureClient?: Pick<WindowsWindowCaptureClient, 'capture'>;

  private async observeAfterYield(name: string, target: string, timeout: number,
    yielded: OcuUserYielded, signal: AbortSignal, windowID?: number, authorizedAppId?: string): Promise<any> {
    signal.throwIfAborted();
    const dispatched = yielded.dispatched;
    const note = dispatched
      ? `Computer Use yielded to physical user input. The ${name} action may already have completed and was not replayed. Observe the current state before choosing the next action.`
      : `Computer Use yielded to physical user input. The requested ${name} action was NOT dispatched. Its old element indices and coordinates were discarded. Use the current state to choose the next action.`;
    if (yielded.timedOut) return { isError: true, content: [{ type: 'text', text:
      `${note} The target app is still in use. This is a temporary yield, not a permission failure. You may continue other task steps or try observing the app later.` }] };
    // Never re-enter invoke's exclusive queue and never replay the old action.
    const fresh = await this.callNativeTool('get_app_state',
      { app: target, ...(windowID !== undefined ? { window_id: windowID } : {}),
        ...(authorizedAppId ? { _memmy_expected_app_id: authorizedAppId } : {}) }, timeout, signal);
    signal.throwIfAborted();
    return { ...fresh, content: [{ type: 'text', text: note }, ...(fresh?.content ?? [])] };
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work, work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }
  private async open(): Promise<void> {
    if (this.closed) throw new Error('Computer Use connection was removed');
    if (this.connection) return;
    if (this.connectionShutdown) {
      const shutdown = this.connectionShutdown;
      await shutdown;
      if (this.connectionShutdown === shutdown) this.connectionShutdown = null;
      if (this.closed) throw new Error('Computer Use connection was removed');
    }
    let connection: OcuConnection;
    try { connection = await this.connect(); }
    catch (error) { throw new NativeConnectionStageError('connect', error); }
    if (this.closed) { await connection.close(); throw new Error('Computer Use connection was removed'); }
    try {
      let result: any;
      try { result = await connection.session.listTools(); }
      catch (error) { throw new NativeConnectionStageError('tool-discovery', error); }
      const tools = [...(result.tools ?? [])].sort((a, b) => a.name.localeCompare(b.name));
      if (tools.length !== OCU_TOOLS.size || new Set(tools.map(t => t.name)).size !== OCU_TOOLS.size || tools.some(t => !OCU_TOOLS.has(t.name))) throw new NativeConnectionStageError('tool-schema', new Error('Expected the Memmy Computer Use tool set'));
      const schemas = tools.map(t => [t.name, t.inputSchema] as [string, unknown]);
      // The native helper can serialize Swift dictionary keys in a different
      // order after restarting. Compare JSON values, not their serialized order.
      if (this.schemas && !isDeepStrictEqual(schemas, this.schemas)) throw new NativeConnectionStageError('tool-schema', new Error('Computer Use tool schema changed; reload the MCP configuration'));
      if (this.closed) throw new Error('Computer Use connection was removed');
      this.schemas = schemas;
      this.cachedTools = result;
      this.connection = connection;
      this.generation++;
    } catch (error) { await connection.close().catch(() => undefined); throw error; }
  }
  private async replace(): Promise<void> {
    const previous = this.connection;
    if (this.platform === 'win32' && previous) await this.detachWindowsConnection(previous);
    else { this.connection = null; await previous?.close(); }
    await this.open();
    this.needsReconnect = false;
  }
  async initialize(): Promise<void> { await this.exclusive(() => this.open()); }
  async listTools(): Promise<any> { return this.exclusive(async () => { if (this.permissionsPaused && this.cachedTools) return this.cachedTools; await this.open(); return this.connection!.session.listTools(); }); }
  async listResources(): Promise<any> { return { resources: [] }; }
  async listPrompts(): Promise<any> { return { prompts: [] }; }

  /** End only this host turn. A shared native helper must retain other chats' state. */
  async finishTurn(context: RequestContext | null): Promise<void> {
    const turnKey = nativeTurnKey(context);
    if (!turnKey) return;
    await this.exclusive(async () => {
      const turn = this.nativeTurns.get(turnKey);
      if (!turn || this.finishedNativeTurns.has(turnKey)) return;
      this.nativeTurns.delete(turnKey);
      this.finishedNativeTurns.add(turnKey);
      while (this.finishedNativeTurns.size > 256)
        this.finishedNativeTurns.delete(this.finishedNativeTurns.values().next().value!);
      for (const key of turn.targetKeys) {
        if ([...this.nativeTurns.values()].some(active => active.targetKeys.has(key))) continue;
        this.targetWindows.delete(key);
        this.modelTargetWindows.delete(key);
        this.modelObservations.delete(key);
        for (const [imageKey, image] of this.windowsImageObservations)
          if (image.targetKey === key) this.windowsImageObservations.delete(imageKey);
      }
      if (this.nativeTurns.size) return;
      this.axDiffPresenter.clear();
      const session = this.connection?.session;
      if (this.closed || this.platform !== 'darwin' || typeof session?.notifyTurnEnded !== 'function') return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(() => !this.closed && !this.nativeTurns.size && this.connection?.session === session
            ? session.notifyTurnEnded() : undefined),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('Native turn cleanup timed out'),
              { code: 'ETIMEDOUT' })), 1000);
          }),
        ]);
      } catch (error) { recordNativeFailure('finish-turn', error, context); }
      finally { if (timer) clearTimeout(timer); }
    });
  }

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

  async invoke(name: string, args: Record<string, any>, timeout: number, context: RequestContext | null,
    signal?: AbortSignal | null, options: { modelVisible?: boolean } = {}): Promise<any> {
    // Register before waiting on another operation, so its cleanup cannot reset
    // a newer chat/turn that has already queued work on this owner.
    const turnKey = OCU_TOOLS.has(name) && name !== 'list_apps' ? nativeTurnKey(context) : null;
    if (!this.closed && turnKey && !this.finishedNativeTurns.has(turnKey) && !this.nativeTurns.has(turnKey))
      this.nativeTurns.set(turnKey, { targetKeys: new Set() });
    // These bridge fields are host-owned. A model, page, or PiP caller cannot
    // replace the native pixel proof with an arbitrary screenshot.
    args = { ...args };
    delete args._observed_screenshot_png;
    delete args._fresh_screenshot_png;
    delete args._host_deadline_epoch_ms;
    delete args._memmy_expected_app_id;
    // Every invocation counts, including UI surface calls whose results the model never sees.
    const presentationRevision = ++this.presentationRevision;
    // A queued tool cannot use a state produced by another tool in the same
    // batch after its arguments were already generated.
    const modelObservationsAtInvocation = options.modelVisible ? new Map(this.modelObservations) : undefined;
    const targetWindowsAtInvocation = options.modelVisible ? new Map(this.targetWindows) : undefined;
    const modelTargetWindowsAtInvocation = options.modelVisible ? new Map(this.modelTargetWindows) : undefined;
    const modelGenerationAtInvocation = this.generation;
    signal = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const cohort = this.cohort ??= { pending: 0 };
    cohort.pending++;
    return this.exclusive(async () => {
      if (this.closed || signal?.aborted) throw new OcuBlocked({ state: 'unknown' });
      if (!OCU_TOOLS.has(name)) throw new OcuBlocked({ state: 'unknown' }, 'Unsupported Computer Use tool policy');
      if (turnKey && this.finishedNativeTurns.has(turnKey)) return { isError: true,
        _meta: { memmyComputerUse: { noActionDispatched: true } }, content: [{ type: 'text', text:
          'This Computer Use turn has finished. The action was not sent. Start from a fresh observation in the new request.' }] };
      const protectedTool = name !== 'list_apps';
      // A failed user message remains blocked across connection generations.
      const blocked = this.preflight.blocked(context);
      if (protectedTool && blocked) {
        const status = await blocked;
        if (status.state === 'unknown' && status.reason === 'requestUnavailable') {
          throw new OcuBlocked({ ...status, diagnostic: recordNativeFailure('request-context', null, context) });
        }
        throw new OcuBlocked(status);
      }
      if (protectedTool && cohort.checked?.status.state !== 'granted' && cohort.checked) {
        this.preflight.remember(context, cohort.checked.status, this.generation);
        throw new OcuBlocked(cohort.checked.status);
      }
      let rebuilt = false;
      let authorizedArgs = args;
      let authorizedAppId: string | undefined;
      let resolvedApp: { platform: string; appId: string; displayName: string } | null = null;
      let opensByIdentity = false;
      let stage: NativeDiagnosticStage = 'connect';
      try {
        // Only a new interactive message may restart a helper paused for setup.
        this.permissionsPaused = false;
        if (this.connection?.outdated?.()) this.needsReconnect = true;
        if (this.needsReconnect) { await this.replace(); rebuilt = true; }
        else {
          try { await this.open(); }
          catch (error) {
            if (this.closed || signal.aborted || (error instanceof NativeConnectionStageError && error.stage === 'tool-schema')) throw error;
            await this.replace(); rebuilt = true;
          }
        }
        stage = 'ping';
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
          stage = 'list-apps';
          try { listing = await this.callNativeTool('list_apps', {}, timeout, signal); }
          catch (error) { signal.throwIfAborted(); throw new NativeConnectionStageError('list-apps', error); }
          if ((listing as { isError?: unknown })?.isError === true) throw new NativeConnectionStageError('list-apps', new Error('Application discovery failed'));
          let app = resolveNativeAppIdentity(listing, target, this.platform);
          if (!app) {
            stage = 'installed-app-lookup';
            try { app = await this.appIdentityResolver(target, this.platform, signal); }
            catch (error) {
              signal.throwIfAborted();
              const diagnostic = recordNativeFailure(stage, error, context);
              const code = error instanceof InstalledAppIdentityLookupError ? error.code : 'lookup-failed';
              const label = code === 'not-found' ? '未找到这个已安装应用'
                : code === 'ambiguous' ? '找到多个匹配应用，无法确定操作对象'
                  : code === 'blocked' ? '这个应用不允许通过电脑操作使用' : '未能读取已安装应用的身份';
              throw new NativeAppApprovalDenied(`${label}，本次应用操作未执行。诊断编号：${diagnostic.id}。`);
            }
          }
          if (!app) {
            const diagnostic = recordNativeFailure('installed-app-lookup', null, context);
            throw new NativeAppApprovalDenied(`未能确认目标应用身份，本次应用操作未执行。诊断编号：${diagnostic.id}。`);
          }
          await this.appApprovals.authorize({ platform: app.platform, appId: app.appId,
            displayName: app.displayName }, context);
          if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
          resolvedApp = app;
          const key = typeof args.app === 'string' ? 'app' : typeof args.app_name === 'string' ? 'app_name' : 'application';
          authorizedArgs = { ...args, [key]: app.runtimeSelector ?? app.appId };
          if (this.platform === 'win32') { authorizedAppId = app.appId; opensByIdentity = !app.runtimeSelector; }
        }
      } catch (error) {
        if (this.platform === 'win32' && signal?.aborted) throw error;
        if (error instanceof OcuBlocked || error instanceof NativeAppApprovalDenied) throw error;
        this.needsReconnect = true;
        const diagnostic = recordNativeFailure(error instanceof NativeConnectionStageError ? error.stage : stage, error, context);
        const status: PermissionPreflight = { state: 'unknown', reason: 'connectionFailed', diagnostic };
        this.preflight.remember(context, status, this.generation);
        cohort.checked = { generation: this.generation, status };
        throw new OcuBlocked(status);
      }
      if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
      const requestedApp = String(args.app ?? args.app_name ?? args.application ?? '');
      const appKey = protectedTool && (resolvedApp || requestedApp.trim())
        ? nativeAppKey(resolvedApp, requestedApp, this.platform) : null;
      // Observation never waits: a task stuck reading an app cannot hold up another task.
      if (appKey && name !== 'get_app_state' && !await this.acquireApp(appKey, signal)) return { isError: true,
        _meta: { memmyComputerUse: { noActionDispatched: true } }, content: [{ type: 'text', text:
          `${resolvedApp?.displayName ?? requestedApp} is being used by another Memmy task. The ${name} action was not sent. Continue other steps or observe this app again shortly.` }] };
      try {
        if (signal?.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
        const target = String(authorizedArgs.app ?? authorizedArgs.app_name ?? authorizedArgs.application ?? '');
        let targetKey = this.targetKey(target, context);
        if (turnKey) this.nativeTurns.get(turnKey)?.targetKeys.add(targetKey);
        let windowID: number | undefined;
        let dispatchName = name;
        let observationNote: string | undefined;
        const windowBoundPlatform = this.platform === 'darwin' || this.platform === 'win32';
        if (windowBoundPlatform && protectedTool) {
          const requested = authorizedArgs.window_id;
          if (requested !== undefined && (!Number.isSafeInteger(requested) || requested <= 0
            || (this.platform === 'darwin' && requested > 0xffffffff))) {
            return { isError: true, content: [{ type: 'text', text: 'window_id must be a positive native window ID from get_app_state. The action was not sent.' }] };
          }
          const observed = modelTargetWindowsAtInvocation?.get(targetKey)
            ?? (targetWindowsAtInvocation ?? this.targetWindows).get(targetKey);
          const modelObservation = this.platform !== 'win32' || modelGenerationAtInvocation === this.generation
            ? modelObservationsAtInvocation?.get(this.windowKey(targetKey, requested ?? observed)) : undefined;
          const expectedWindow = options.modelVisible && name !== 'get_app_state' ? modelObservation?.windowID : observed;
          if (name !== 'get_app_state' && requested !== undefined && requested !== expectedWindow) {
            return { isError: true, content: [{ type: 'text', text: 'Observe the requested window with get_app_state(app, window_id) before acting on it. The action was not sent.' }] };
          }
          windowID = requested ?? expectedWindow;
          if (windowID !== undefined) authorizedArgs = { ...authorizedArgs, window_id: windowID };
          if (options.modelVisible && name !== 'get_app_state') {
            if (!modelObservation) {
              // A new request cannot borrow another request's cached indices.
              // Return an observation so the model can choose a fresh action.
              dispatchName = 'get_app_state';
              authorizedArgs = { app: target };
              observationNote = 'this request has not observed the target window';
            } else if (authorizedArgs.observation_id !== undefined
              && authorizedArgs.observation_id !== modelObservation.observationID) {
              dispatchName = 'get_app_state';
              authorizedArgs = { app: target, window_id: modelObservation.windowID };
              observationNote = 'its observation_id does not match the state visible when this tool was invoked';
            } else authorizedArgs = { ...authorizedArgs, observation_id: modelObservation.observationID };
          }
        }
        const coordinateTool = name === 'drag'
          || ((name === 'click' || name === 'scroll') && authorizedArgs.element_index === undefined);
        if (this.windowsCaptureClient && dispatchName === name && coordinateTool) {
          const token = authorizedArgs.observation_id;
          const observation = typeof token === 'string'
            ? this.windowsImageObservations.get(JSON.stringify([this.windowKey(targetKey, windowID), token])) : undefined;
          let captureFailure: string | undefined;
          if (!observation || observation.generation !== this.generation || observation.windowID !== windowID) {
            captureFailure = 'its exact Windows screenshot observation is no longer available';
          } else if (observation.desktopCapture)
            captureFailure = 'Desktop capture has no verified native coordinate origin. Use an exact UIA element_index instead of screenshot coordinates';
          if (captureFailure) {
            dispatchName = 'get_app_state';
            authorizedArgs = { app: target, ...(windowID !== undefined ? { window_id: windowID } : {}) };
            observationNote = captureFailure;
          }
        }
        // Re-observation may replace all tool arguments above. Carry the
        // approved identity to every native dispatch so PID reuse during the
        // approval dialog cannot transfer access to another app.
        if (authorizedAppId) authorizedArgs = { ...authorizedArgs, _memmy_expected_app_id: authorizedAppId };
        const call = () => this.callNativeTool(dispatchName, authorizedArgs, timeout, signal);
        let result: any;
        try {
          result = this.platform === 'darwin' && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1'
            ? await this.macFocusGuard(target, dispatchName, call, undefined,
              { yieldOnUserInput: true, targetWindowId: windowID, signal })
            : await call();
        } catch (error) {
          if (!(error instanceof OcuUserYielded)) throw error;
          result = await this.observeAfterYield(name, target, timeout, error, signal, windowID);
        }
        if (this.platform === 'darwin') {
          const yielded = macFocusGuardYield(result);
          if (yielded) {
            // The helper rechecks just before dispatch, closing the race after
            // the JS snapshot. Its exact error marker is never a page-text cue.
            const idle = await this.macWaitForTargetIdle(target, { signal, targetWindowId: windowID });
            result = await this.observeAfterYield(name, target, timeout,
              new OcuUserYielded(yielded.dispatched, !idle), signal, windowID);
          }
        }
        if (this.platform === 'win32' && name !== 'list_apps' && name !== 'get_app_state') {
          const guardStop = windowsFocusGuardStop(result);
          if (guardStop !== null) throw new OcuUserIntervened(guardStop);
          const yielded = windowsFocusGuardYield(result);
          if (yielded) {
            if (windowID !== undefined && yielded.windowID !== windowID) return { isError: true,
              content: [{ type: 'text', text: 'The helper yielded on a different window from the requested target. The action was not replayed. Observe the intended window before continuing.' }] };
            windowID ??= yielded.windowID;
            const idle = await this.windowsWaitForTargetIdle({ pid: yielded.pid, windowID }, { signal });
            result = await this.observeAfterYield(name, target, timeout,
              new OcuUserYielded(yielded.dispatched, !idle), signal, windowID, authorizedAppId);
          }
        }
        const returnedWindowID = mcpTargetWindowId(result, this.platform);
        if (windowBoundPlatform && protectedTool && result?.isError !== true
          && returnedWindowID !== undefined && windowID !== undefined && returnedWindowID !== windowID) {
          // Reject drift before requesting another screenshot. Neither focus
          // nor an action result implicitly transfers this task to a document.
          return { isError: true, content: [{ type: 'text', text: 'The helper returned a different window from the requested target. Its frame and element indices were discarded. Observe the intended window explicitly before continuing; the action was not replayed.' }] };
        }
        // A Windows app opened by its identity gets a process only now; later
        // calls find that running window by PID, so keep this observation there.
        const openedPid = opensByIdentity && result?.isError !== true ? result?._meta?.memmyComputerUse?.pid : undefined;
        if (Number.isSafeInteger(openedPid) && openedPid > 0) {
          targetKey = this.targetKey(String(openedPid), context);
          if (turnKey) this.nativeTurns.get(turnKey)?.targetKeys.add(targetKey);
        }
        if (this.windowsCaptureClient)
          result = await replaceOccludedWindowsFrame(result, target, signal, this.windowsCaptureClient);
        if (signal?.aborted) throw new Error('cancelled after dispatch');
        if (observationNote) result = { ...result, content: [{ type: 'text', text:
          `The requested ${name} action was NOT dispatched because ${observationNote}. Use this fresh state to choose the next action.` }, ...(result?.content ?? [])],
          ...(result?.isError !== true ? { _meta: { ...result?._meta, memmyComputerUse: {
            ...result?._meta?.memmyComputerUse, stateChanged: true, noActionDispatched: true } } } : {}) };
        if (windowBoundPlatform && protectedTool && result?.isError !== true) {
          if (returnedWindowID !== undefined) this.rememberWindow(targetKey, returnedWindowID);
        }
        const observationKey = this.windowKey(targetKey, returnedWindowID);
        if (turnKey) this.nativeTurns.get(turnKey)?.targetKeys.add(observationKey);
        if (this.platform === 'win32') this.rememberWindowsImage(result, observationKey);
        const permission = computerUsePermissionError(MEMMY_COMPUTER_USE_MCP_SERVER, result);
        if (permission) {
          this.permissionDenied(context, permission);
          const status = await this.showGuide({ state: 'missing', permission }, signal);
          cohort.checked = { generation: this.generation, status };
          this.preflight.remember(context, status, this.generation);
          if (status.state === 'unknown' && status.reason === 'helperPauseFailed') throw new OcuBlocked(status);
        }
        if (appKey && result && typeof result === 'object') this.resultApps.set(result, appKey);
        if (result && typeof result === 'object') {
          const observationID = result?._meta?.memmyComputerUse?.observationID;
          this.resultRevisions.set(result, { revision: presentationRevision, generation: this.generation,
            ...(windowBoundPlatform && protectedTool ? { targetKey: observationKey, bindingKey: targetKey,
              windowID: mcpTargetWindowId(result, this.platform),
              observationID: typeof observationID === 'string' && observationID.length <= 128 ? observationID : undefined } : {}) });
        }
        return result;
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof OcuUserIntervened) {
          this.preflight.block(context);
          throw error;
        }
        if (error instanceof OcuBlocked) throw error;
        recordNativeFailure('dispatch', error, context, name !== 'get_app_state' && name !== 'list_apps');
        this.needsReconnect = true;
        this.preflight.block(context);
        if (this.platform !== 'win32') cohort.checked = { generation: this.generation, status: { state: 'unknown' } };
        throw new OcuUncertain('Computer Use disconnected during the operation. Its result is unknown and it was not replayed.');
      } finally {
        if (appKey) this.appLeases.touch(appKey, this.leaseOwner);
      }
    }).finally(() => { if (--cohort.pending === 0 && this.cohort === cohort) this.cohort = null; });
  }
  presentModelResult(name: string, args: Record<string, any>, result: any, output: any, context: RequestContext | null): any {
    if (this.platform !== 'darwin' && this.platform !== 'win32') return output;
    const turnKey = nativeTurnKey(context);
    if (turnKey && this.finishedNativeTurns.has(turnKey)) return output;
    const stamp = result && typeof result === 'object' ? this.resultRevisions.get(result) : undefined;
    if (result?.isError !== true && stamp?.targetKey && stamp.windowID !== undefined && stamp.observationID
      && (this.platform !== 'win32' || (stamp.generation === this.generation && this.connection !== null))) {
      this.modelObservations.delete(stamp.targetKey);
      this.modelObservations.set(stamp.targetKey, { windowID: stamp.windowID, observationID: stamp.observationID });
      if (stamp.bindingKey) this.rememberModelWindow(stamp.bindingKey, stamp.windowID);
      while (this.modelObservations.size > 256) this.modelObservations.delete(this.modelObservations.keys().next().value!);
    }
    return this.axDiffPresenter.present(name, args, result, output, context,
      stamp?.revision ?? null, this.presentationRevision, stamp?.generation ?? this.generation);
  }
  permissionDenied(context: RequestContext | null, permission: 'accessibility' | 'screenRecording' | 'inputMonitoring'): void {
    this.preflight.deny(context, permission);
    this.needsReconnect = true;
  }
  private rememberModelWindow(key: string, windowID: number): void {
    this.modelTargetWindows.delete(key);
    this.modelTargetWindows.set(key, windowID);
    while (this.modelTargetWindows.size > 256)
      this.modelTargetWindows.delete(this.modelTargetWindows.keys().next().value!);
  }
  /** The approved app identity behind a result, shared with its connected-browser surfaces. */
  appKeyFor(result: unknown): string | undefined {
    return result && typeof result === 'object' ? this.resultApps.get(result) : undefined;
  }
  private async acquireApp(appKey: string, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + this.appWaitMs;
    while (this.appLeases.heldByOther(appKey, this.leaseOwner)) {
      if (signal.aborted || this.closed) throw new OcuBlocked({ state: 'unknown' });
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new OcuBlocked({ state: 'unknown' })); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); },
          Math.min(250, Math.max(1, deadline - Date.now())));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      if (this.closed) throw new OcuBlocked({ state: 'unknown' });
    }
    this.appLeases.claim(appKey, this.leaseOwner);
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.appLeases.release(this.leaseOwner);
    this.axDiffPresenter.clear();
    this.targetWindows.clear();
    this.modelTargetWindows.clear();
    this.modelObservations.clear();
    this.windowsImageObservations.clear();
    this.nativeTurns.clear();
    this.finishedNativeTurns.clear();
    const connection = this.connection;
    this.lifetime.abort();
    if (this.platform === 'win32' && connection) await this.detachWindowsConnection(connection);
    else { this.connection = null; await connection?.close(); }
    await this.connectionShutdown;
  }
}
