import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { BrowserCommandOutcome, BrowserCommandSettle, ExternalBrowserClaim,
  ExternalBrowserPlaywrightEvent } from './external-browser-bridge.js';

export type PlaywrightCommandBridge = {
  /** `settle` runs when the reply arrives, in order with subscribed executor events. */
  command(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>, name: string,
    args?: Record<string, unknown>, signal?: AbortSignal, settle?: BrowserCommandSettle): Promise<unknown>;
  getClaim(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>): ExternalBrowserClaim | null;
  subscribePlaywright(identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    listener: (event: ExternalBrowserPlaywrightEvent) => void): () => void;
};
const ACTION_DEADLINE_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 2_000;
type Operation = { bridge: PlaywrightCommandBridge; leaseId: string; origin: string; signal: AbortSignal;
  controller: AbortController; parentSignal?: AbortSignal; parentAbort: () => void;
  timer?: ReturnType<typeof setTimeout>; startedAt: number; rejectInterruption: (error: Error) => void;
  endPromise?: Promise<void>; detachPromise?: Promise<void> };
type CdpMessage = { id: number; method: string; params?: Record<string, any>; sessionId?: string };
type RemoteObjectScope = { url: string; sessionId: string; frameId: string; contextKey?: string };
type FrameEvent = Pick<ExternalBrowserPlaywrightEvent, 'method' | 'params' | 'sessionId'>;
export type BrowserExecutionDiagnostics = {
  consoleRecords: Array<{ frameUrl: string; type: string; text: string }>;
  networkRecords: Array<{ frameUrl: string; method: string; url: string }>;
};

/** A deliberately single-page CDP transport, using only public Playwright APIs. */
export class ExternalBrowserPlaywrightRelay {
  private readonly path = `/${randomBytes(24).toString('hex')}`;
  private readonly server = http.createServer((_req, response) => response.writeHead(404).end());
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private socket: WebSocket | null = null;
  private operation: Operation | null = null;
  private lastOperation: Operation | null = null;
  private unsubscribe: (() => void) | null = null;
  private targetInfo: Record<string, any> = {};
  private frameUrls = new Map<string, string>();
  private frameParents = new Map<string, string | undefined>();
  private mainFrameId = '';
  private childUrls = new Map<string, string>();
  private childIds = new Map<string, string>();
  private childDescriptions = new Map<string, string>();
  private versionFrames: Array<[string, string]> = [];
  private contextUrls = new Map<string, string>();
  private contextFrames = new Map<string, string>();
  private objectScopes = new Map<string, RemoteObjectScope>();
  // The physical tree includes denied frames. Only this sanitized view is
  // published to Playwright, so it never waits for a deliberately hidden world.
  private visibleFrames = new Set<string>();
  private visibleSessions = new Set<string>();
  private pendingAttachments = new Map<string, FrameEvent>();
  private pendingNavigations = new Map<string, FrameEvent>();
  private pendingContexts = new Map<string, FrameEvent>();
  private childAttachments = new Map<string, FrameEvent>();
  private autoAttached = false;
  private inputState: 'none' | 'confirmed' | 'unknown' = 'none';
  private documentReplaced = false;
  private consoleRecords: Array<{ frameUrl: string; type: string; text: string }> = [];
  private networkRecords: Array<{ frameUrl: string; method: string; url: string }> = [];
  private endpoint = '';
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private stage = 'idle';
  private failure: Error | null = null;
  private interruption: Promise<never> = new Promise(() => undefined);
  readonly mainSessionId = 'memmy-page';
  setStage(stage: string): void { this.stage = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(stage) ? stage : 'action'; }
  get actionError(): Error | null { return this.failure; }
  get deadlineError(): Error | null { return (this.failure as any)?.code === 'BROWSER_ACTION_DEADLINE' ? this.failure : null; }
  waitForInterruption(): Promise<never> { return this.interruption; }
  hasBlockedFrames(): boolean { return [...this.frameParents.keys()].some(id => !this.frameAllowed(id))
    || [...this.childUrls.values()].some(url => !this.permitted(url)); }
  dispatchState(): 'none' | 'confirmed' | 'unknown' { return this.inputState; }
  /** The tab committed (or, for the in-app browser, started) a new main document during this action. */
  documentWasReplaced(): boolean { return this.documentReplaced; }
  frameVersion(): string { return JSON.stringify({ frames: this.versionFrames,
    children: [...this.childDescriptions.entries()].sort(([a], [b]) => a.localeCompare(b)),
    admittedFrames: [...this.frameParents.keys()].filter(id => this.frameAllowed(id)).sort() }); }
  consoleMessages(): Array<{ type: string; text: string }> {
    return this.consoleRecords.filter(record => this.permitted(record.frameUrl)).map(({ frameUrl: _url, ...record }) => record);
  }
  networkRequests(): Array<{ method: string; url: string }> {
    return this.networkRecords.filter(record => this.permitted(record.frameUrl)).map(({ frameUrl: _url, ...record }) => record);
  }

  constructor(readonly identity: Pick<ExternalBrowserClaim, 'connectionId' | 'tabId'>,
    private allowFrame: (url: string) => boolean,
    diagnostics: BrowserExecutionDiagnostics = { consoleRecords: [], networkRecords: [] }) {
    this.consoleRecords = diagnostics.consoleRecords;
    this.networkRecords = diagnostics.networkRecords;
    this.server.on('upgrade', (request, socket, head) => {
      if (this.closed || request.socket.remoteAddress !== '127.0.0.1' || request.url !== this.path || this.socket) {
        socket.destroy(); return;
      }
      this.sockets.handleUpgrade(request, socket, head, ws => {
        this.socket = ws;
        ws.on('message', raw => {
          let input: CdpMessage;
          try { input = JSON.parse(String(raw)); } catch { ws.close(1003); return; }
          this.receive(input, ws);
        });
        ws.on('close', () => {
          if (this.socket !== ws) return;
          this.socket = null;
          if (this.operation) this.interrupt(this.operation,
            Object.assign(new Error('Browser executor transport disconnected'), { code: 'BROWSER_TRANSPORT_CLOSED' }));
          void this.close();
        });
      });
    });
  }
  setFramePolicy(policy: (url: string) => boolean): void { this.allowFrame = policy; }

  async start(): Promise<string> {
    if (this.closed) throw this.failure ?? new Error('Browser executor relay closed');
    if (this.endpoint) return this.endpoint;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    if (this.closed) { this.server.close(); throw this.failure ?? new Error('Browser executor relay closed'); }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Browser executor relay unavailable');
    this.endpoint = `ws://127.0.0.1:${address.port}${this.path}`;
    return this.endpoint;
  }

  async begin(bridge: PlaywrightCommandBridge, origin: string, input: boolean,
    fresh: boolean, signal?: AbortSignal, uploadPaths?: string[]): Promise<{ documentEpoch: number; cdpEpoch: number; frameEpoch: number | null; frameVersion: string }> {
    if (this.closed) throw this.failure ?? new Error('Browser executor relay closed');
    if (this.operation) throw new Error('Browser executor action is already active');
    this.inputState = 'none';
    this.documentReplaced = false;
    this.failure = null;
    this.stage = 'lease-start';
    this.assertClaim(bridge, origin, signal);
    const leaseId = randomBytes(16).toString('hex');
    const controller = new AbortController();
    let rejectInterruption!: (error: Error) => void;
    this.interruption = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
    // A caller can subscribe after begin; a synchronous revocation must still be handled.
    void this.interruption.catch(() => undefined);
    const operation: Operation = { bridge, origin, leaseId, controller, signal: controller.signal,
      parentSignal: signal, startedAt: Date.now(), rejectInterruption,
      parentAbort: () => { this.interrupt(operation, this.cancelledError()); void this.close(); } };
    this.operation = operation;
    this.lastOperation = operation;
    operation.timer = setTimeout(() => {
      const error = Object.assign(new Error('Browser action exceeded its 30 second deadline'), {
        code: 'BROWSER_ACTION_DEADLINE', stage: this.stage,
        elapsedMs: Math.max(0, Date.now() - operation.startedAt), tabId: this.identity.tabId,
      });
      this.interrupt(operation, error);
      void this.close();
    }, ACTION_DEADLINE_MS);
    signal?.addEventListener('abort', operation.parentAbort, { once: true });
    try {
      if (fresh) { this.frameUrls.clear(); this.frameParents.clear(); }
      this.unsubscribe = bridge.subscribePlaywright(this.identity, event => this.onEvent(event));
      const state = await Promise.race([bridge.command(this.identity, 'playwrightStart',
        { leaseId, approvedOrigin: origin, input, fresh, ...(uploadPaths ? { uploadPaths } : {}) }, operation.signal),
      this.interruption]) as Record<string, any>;
      if (this.assertActive() !== operation) throw new Error('Browser executor action changed');
      this.targetInfo = { ...state.targetInfo, browserContextId: 'memmy-selected-context', type: 'page', attached: true };
      // A root FrameTree omits out-of-process children. Their authenticated
      // sessions and contexts remain live on a warm connection; replacing the
      // map with only the root tree would invalidate those cached contexts.
      this.mainFrameId = String(state.frameTree?.frame?.id || '');
      this.readFrameTree(state.frameTree);
      const versionFrames = (tree: any): Array<[string, string]> => !tree?.frame?.id ? []
        : [[String(tree.frame.id), String(tree.frame.url || '')], ...(tree.childFrames ?? []).flatMap(versionFrames)];
      this.versionFrames = versionFrames(state.frameTree);
      this.childDescriptions.clear();
      for (const child of state.childTargets ?? []) this.childDescriptions.set(child.targetId, child.url);
      this.assertActive();
      return { documentEpoch: Number(state.documentEpoch), cdpEpoch: Number(state.cdpEpoch),
        frameEpoch: Number.isSafeInteger(state.frameEpoch) && state.frameEpoch >= 0 ? state.frameEpoch : null,
        frameVersion: this.frameVersion() };
    } catch (error) { await this.end(); throw this.failure ?? error; }
  }

  async end(detach = false): Promise<void> {
    // Always end the last lease, even when the debugger stays attached;
    // cleanup is memoized, so an action that already ended sends nothing new.
    const operation = this.operation ?? this.lastOperation;
    if (this.operation === operation && operation) this.release(operation);
    if (detach && this.lastOperation === operation) this.lastOperation = null;
    if (operation) await this.cleanup(operation, detach);
  }

  private cancelledError(): Error {
    return Object.assign(new Error('Browser executor cancelled'), { name: 'AbortError', code: 'BROWSER_ACTION_CANCELLED' });
  }

  private release(operation: Operation): void {
    if (this.operation !== operation) return;
    this.operation = null;
    clearTimeout(operation.timer);
    operation.parentSignal?.removeEventListener('abort', operation.parentAbort);
    this.unsubscribe?.(); this.unsubscribe = null;
    operation.controller.abort(this.failure ?? this.cancelledError());
  }

  private interrupt(operation: Operation, error: Error): void {
    if (this.operation !== operation) return;
    this.failure = error;
    // Revoke before disconnecting so no queued CDP input can acquire the old lease.
    operation.rejectInterruption(error);
    this.release(operation);
    this.disconnect();
  }

  private disconnect(): void {
    const socket = this.socket; this.socket = null;
    socket?.terminate();
    for (const client of this.sockets.clients) client.terminate();
  }

  private cleanup(operation: Operation, detach: boolean): Promise<void> {
    const key = detach ? 'detachPromise' : 'endPromise';
    if (operation[key]) return operation[key]!;
    operation[key] = (async () => {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(); }, CLEANUP_TIMEOUT_MS);
      });
      try {
        // Cleanup uses the captured lease, never a later task's current lease.
        await Promise.race([operation.bridge.command(this.identity, 'playwrightEnd',
          { leaseId: operation.leaseId, approvedOrigin: operation.origin, ...(detach ? { detach: true } : {}) },
          controller.signal).then(() => undefined, () => undefined), deadline]);
      } catch { /* Cleanup failure cannot prevent local disconnection or release. */ }
      finally { clearTimeout(timer); controller.abort(); }
    })();
    return operation[key]!;
  }

  private assertClaim(bridge: PlaywrightCommandBridge, origin: string, signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error('Browser executor cancelled');
    const claim = bridge.getClaim(this.identity);
    if (!claim || new URL(claim.url).origin !== origin) throw new Error('Browser executor tab changed');
  }

  private assertActive(): Operation {
    const operation = this.operation;
    if (!operation) throw new Error('Browser executor has no active action');
    this.assertClaim(operation.bridge, operation.origin, operation.signal);
    return operation;
  }

  private permitted(url: string | undefined): boolean {
    if (!url) return false;
    if (url === 'about:blank' || url === 'about:srcdoc') return true;
    try { return ['http:', 'https:'].includes(new URL(url).protocol) && this.allowFrame(url); }
    catch { return false; }
  }

  private readFrameTree(tree: any, parentId?: string): void {
    if (!tree?.frame?.id) return;
    this.frameUrls.set(tree.frame.id, String(tree.frame.url || ''));
    this.frameParents.set(tree.frame.id, tree.frame.parentId || parentId || this.frameParents.get(tree.frame.id));
    for (const child of tree.childFrames ?? []) this.readFrameTree(child, tree.frame.id);
  }

  private affectedFrames(frameId: string): Set<string> {
    const frames = new Set([frameId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, parent] of this.frameParents) if (parent && frames.has(parent) && !frames.has(id)) {
        frames.add(id); changed = true;
      }
    }
    return frames;
  }

  private invalidateFrame(frameId: string, remove = false): void {
    const frames = this.affectedFrames(frameId);
    for (const [key, frame] of this.contextFrames) if (frames.has(frame)) {
      this.contextFrames.delete(key); this.contextUrls.delete(key);
    }
    for (const [key, scope] of this.objectScopes) if (frames.has(scope.frameId)) this.objectScopes.delete(key);
    if (remove) for (const frame of frames) {
      this.frameUrls.delete(frame); this.frameParents.delete(frame); this.visibleFrames.delete(frame);
      this.pendingAttachments.delete(frame); this.pendingNavigations.delete(frame);
      for (const [key, event] of this.pendingContexts) if ((event.params as any)?.context?.auxData?.frameId === frame) this.pendingContexts.delete(key);
    }
  }

  private frameAllowed(frameId: string): boolean {
    const seen = new Set<string>();
    for (let id: string | undefined = frameId; id; id = this.frameParents.get(id)) {
      if (seen.has(id) || !this.permitted(this.frameUrls.get(id))) return false;
      seen.add(id);
      if (id === this.mainFrameId) return true;
    }
    return false;
  }

  private forward(event: FrameEvent): void {
    this.emit({ sessionId: event.sessionId || this.mainSessionId, method: event.method, params: event.params });
  }

  private checkPendingBound(): void {
    if (this.pendingAttachments.size + this.pendingNavigations.size + this.pendingContexts.size <= 512) return;
    const operation = this.operation;
    if (operation) {
      this.interrupt(operation, Object.assign(new Error('Browser frame lifecycle buffer exceeded its limit'),
        { code: 'BROWSER_FRAME_LIFECYCLE_LIMIT' }));
      void this.close();
    }
  }

  private publishFrames(): void {
    // A child is released only after its trusted URL and complete parent chain
    // are permitted. Structural events must precede its execution contexts.
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, navigation] of this.pendingNavigations) {
        if (!this.frameAllowed(id)) continue;
        const parent = this.frameParents.get(id);
        if (id !== this.mainFrameId && (!parent || !this.visibleFrames.has(parent))) continue;
        if (!this.visibleFrames.has(id)) {
          const attachment = this.pendingAttachments.get(id) ?? { method: 'Page.frameAttached',
            sessionId: navigation.sessionId, params: { frameId: id, parentFrameId: parent } };
          this.forward(attachment); this.visibleFrames.add(id);
        }
        this.pendingAttachments.delete(id); this.pendingNavigations.delete(id);
        this.forward(navigation); changed = true;
      }
    }
    for (const [key, event] of this.pendingContexts) {
      const context = (event.params as any)?.context;
      const frameId = context?.auxData?.frameId;
      if (!this.visibleFrames.has(frameId) || !this.frameAllowed(frameId)) continue;
      this.pendingContexts.delete(key);
      this.contextUrls.set(key, this.frameUrls.get(frameId)!); this.contextFrames.set(key, frameId);
      this.forward(event);
    }
    this.publishChildSessions();
  }

  private publishChildSessions(): void {
    for (const [sessionId, event] of this.childAttachments) {
      const frameId = this.childIds.get(sessionId)!;
      if (this.visibleSessions.has(sessionId) || !this.frameAllowed(frameId)) continue;
      const parent = this.frameParents.get(frameId);
      if (!parent || !this.visibleFrames.has(parent)) continue;
      if (!this.visibleFrames.has(frameId)) {
        this.forward(this.pendingAttachments.get(frameId) ?? { method: 'Page.frameAttached',
          sessionId: event.sessionId, params: { frameId, parentFrameId: parent } });
        this.pendingAttachments.delete(frameId); this.visibleFrames.add(frameId);
      }
      this.visibleSessions.add(sessionId); this.forward(event);
    }
  }

  private hideFrame(frameId: string, sessionId?: string): boolean {
    const frames = this.affectedFrames(frameId);
    if ([...this.childIds].some(([session, id]) => frames.has(id) && this.visibleSessions.has(session))) {
      // Playwright owns a FrameSession for an exposed OOPIF. Removing only its
      // Page frame leaves a context waiter; revoke the view at this boundary.
      const operation = this.operation;
      if (operation) {
        this.interrupt(operation, Object.assign(new Error('Browser frame access changed; take a fresh observation'),
          { code: 'BROWSER_FRAME_ACCESS_CHANGED' }));
        void this.close();
      }
      return true;
    }
    if (this.visibleFrames.has(frameId)) this.forward({ method: 'Page.frameDetached', sessionId,
      params: { frameId, reason: 'remove' } });
    for (const id of frames) this.visibleFrames.delete(id);
    return false;
  }

  private objectScope(objectId: string, sessionId: string): RemoteObjectScope | undefined {
    const scope = this.objectScopes.get(`${sessionId}:${objectId}`);
    return scope && this.permitted(scope.url) && this.frameAllowed(scope.frameId) ? scope : undefined;
  }

  private pruneFrameTree(tree: any): any {
    if (!tree?.frame || !this.frameAllowed(tree.frame.id)) return undefined;
    this.visibleFrames.add(tree.frame.id);
    return { ...tree, childFrames: (tree.childFrames ?? []).map((child: any) => this.pruneFrameTree(child)).filter(Boolean) };
  }

  private emit(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private onEvent(event: ExternalBrowserPlaywrightEvent): void {
    const operation = this.operation;
    if (!operation || event.leaseId !== operation.leaseId || operation.signal?.aborted) return;
    if (event.method === 'Memmy.executorRevoked') {
      if ((event.params as Record<string, unknown>)?.reason === 'navigation') this.documentReplaced = true;
      this.interrupt(operation, new Error('Browser action revoked')); void this.close(); return;
    }
    if (event.method === 'Page.frameNavigated' && !event.sessionId && (event.params as any)?.frame
      && !(event.params as any).frame.parentId) this.documentReplaced = true;
    try { this.assertActive(); } catch (error) {
      this.interrupt(operation, error as Error); void this.close(); return;
    }
    const params = event.params as Record<string, any>;
    if (event.method === 'Target.attachedToTarget') {
      if (params.targetInfo?.type !== 'iframe') return;
      const url = String(params.targetInfo.url || '');
      const frameId = String(params.targetInfo.targetId);
      this.childUrls.set(params.sessionId, url); this.childIds.set(params.sessionId, frameId);
      this.childDescriptions.set(frameId, url); this.frameUrls.set(frameId, url);
      this.frameParents.set(frameId, params.targetInfo.parentFrameId || this.frameParents.get(frameId));
      this.childAttachments.set(params.sessionId, event);
      this.publishChildSessions(); return;
    }
    if (event.method === 'Target.targetInfoChanged') {
      const frameId = params.targetInfo?.targetId;
      if (!this.childDescriptions.has(frameId)) return;
      const url = String(params.targetInfo.url || '');
      this.childDescriptions.set(frameId, url); this.frameUrls.set(frameId, url);
      for (const [sessionId, targetId] of this.childIds) if (targetId === frameId) {
        this.childUrls.set(sessionId, url);
        const attachment = this.childAttachments.get(sessionId);
        if (attachment) this.childAttachments.set(sessionId, { ...attachment,
          params: { ...(attachment.params as any), targetInfo: params.targetInfo } });
      }
      if (!this.frameAllowed(frameId)) { this.hideFrame(frameId, event.sessionId); return; }
      this.publishChildSessions();
      if (!event.sessionId || this.visibleSessions.has(event.sessionId)) this.forward(event);
      return;
    }
    if (event.method === 'Target.detachedFromTarget') {
      const visible = this.visibleSessions.delete(params.sessionId);
      const frameId = this.childIds.get(params.sessionId);
      const prefix = `${params.sessionId}:`;
      for (const key of this.contextUrls.keys()) if (key.startsWith(prefix)) { this.contextUrls.delete(key); this.contextFrames.delete(key); }
      for (const [key, scope] of this.objectScopes) if (scope.sessionId === params.sessionId) this.objectScopes.delete(key);
      for (const key of this.pendingContexts.keys()) if (key.startsWith(prefix)) this.pendingContexts.delete(key);
      this.childDescriptions.delete(frameId || ''); this.childAttachments.delete(params.sessionId);
      this.childIds.delete(params.sessionId); this.childUrls.delete(params.sessionId);
      if (visible) this.forward(event);
      // Target detach can be a process swap. Only Page.frameDetached(remove)
      // removes the physical frame and its descendants.
      return;
    }
    if (event.method === 'Page.frameAttached') {
      this.frameParents.set(params.frameId, params.parentFrameId);
      // An existing OOPIF can swap back into its parent renderer. Playwright
      // needs this structural notification to retire the old FrameSession.
      if (this.visibleFrames.has(params.frameId) && this.frameAllowed(params.frameId)) { this.forward(event); return; }
      this.pendingAttachments.set(params.frameId, event);
      this.checkPendingBound(); this.publishFrames(); return;
    }
    if (event.method === 'Page.frameDetached') {
      if (params.reason === 'swap') {
        if (this.visibleFrames.has(params.frameId)) this.forward(event);
      } else {
        const visible = this.visibleFrames.has(params.frameId);
        this.invalidateFrame(params.frameId, true);
        if (visible) this.forward(event);
      }
      return;
    }
    if (event.method === 'Page.frameNavigated') {
      const frame = params.frame;
      if (!frame?.id) return;
      this.invalidateFrame(frame.id);
      this.frameParents.set(frame.id, frame.parentId || this.frameParents.get(frame.id));
      this.frameUrls.set(frame.id, String(frame.url || ''));
      for (const [sessionId, id] of this.childIds) if (id === frame.id) this.childUrls.set(sessionId, String(frame.url || ''));
      if (!this.frameAllowed(frame.id)) { this.pendingNavigations.delete(frame.id); this.hideFrame(frame.id, event.sessionId); return; }
      this.pendingNavigations.set(frame.id, event);
      this.checkPendingBound(); this.publishFrames(); return;
    }
    if (event.method === 'Runtime.executionContextCreated') {
      const context = params.context;
      const frameId = context?.auxData?.frameId;
      if (!frameId) return;
      const key = `${event.sessionId || this.mainSessionId}:${context?.id}`;
      // Keep authenticated identity metadata even for a denied document. It is
      // never published to Playwright while denied, and every later command
      // rechecks the live policy. A permission change must not freeze admission.
      const url = this.frameUrls.get(frameId);
      if (url) { this.contextUrls.set(key, url); this.contextFrames.set(key, frameId); }
      // context.origin alone is not a trustworthy document URL for site policy.
      if (!this.visibleFrames.has(frameId) || !this.frameAllowed(frameId)) {
        if (!this.frameUrls.has(frameId) || this.frameAllowed(frameId)) {
          this.pendingContexts.set(key, event); this.checkPendingBound();
        }
        return;
      }
    }
    if (event.method === 'Runtime.executionContextsCleared') {
      const prefix = `${event.sessionId || this.mainSessionId}:`;
      for (const key of this.contextUrls.keys()) if (key.startsWith(prefix)) {
        this.contextUrls.delete(key); this.contextFrames.delete(key);
      }
      for (const key of this.pendingContexts.keys()) if (key.startsWith(prefix)) this.pendingContexts.delete(key);
      for (const [key, scope] of this.objectScopes) if (scope.sessionId === (event.sessionId || this.mainSessionId)) this.objectScopes.delete(key);
    }
    if (event.method === 'Runtime.executionContextDestroyed') {
      const key = `${event.sessionId || this.mainSessionId}:${params.executionContextId}`;
      this.contextUrls.delete(key); this.contextFrames.delete(key); this.pendingContexts.delete(key);
      for (const [id, scope] of this.objectScopes) if (scope.contextKey === key) this.objectScopes.delete(id);
    }
    if (event.sessionId && !this.visibleSessions.has(event.sessionId)) return;
    if (params.frameId && (!this.visibleFrames.has(params.frameId) || !this.frameAllowed(params.frameId))) return;
    if (event.method === 'Runtime.consoleAPICalled') {
      const key = `${event.sessionId || this.mainSessionId}:${params.executionContextId}`;
      const url = this.contextUrls.get(key);
      const frameId = this.contextFrames.get(key);
      if (!frameId || !this.visibleFrames.has(frameId) || !this.frameAllowed(frameId)) return;
      {
        this.consoleRecords.push({ frameUrl: url!, type: String(params.type || 'log'), text: (params.args ?? [])
          .map((value: any) => String(value.value ?? value.description ?? '')).join(' ').slice(0, 3000) });
        if (this.consoleRecords.length > 200) this.consoleRecords.shift();
      }
    }
    if (event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.bindingCalled') {
      const id = params.executionContextId ?? params.exceptionDetails?.executionContextId;
      const frameId = this.contextFrames.get(`${event.sessionId || this.mainSessionId}:${id}`);
      if (!frameId || !this.visibleFrames.has(frameId) || !this.frameAllowed(frameId)) return;
    }
    if (event.method === 'Log.entryAdded') return;
    if (event.method === 'Network.requestWillBeSent') {
      const url = this.frameUrls.get(params.frameId);
      if (this.permitted(url)) {
        this.networkRecords.push({ frameUrl: url!, method: String(params.request?.method || ''), url: String(params.request?.url || '').slice(0, 4096) });
        if (this.networkRecords.length > 200) this.networkRecords.shift();
      }
    }
    this.emit({ sessionId: event.sessionId || this.mainSessionId, method: event.method, params });

  }

  send(method: string, params: Record<string, any> = {}, sessionId = this.mainSessionId): Promise<any> {
    return Promise.race([new Promise((resolve, reject) => {
      try { this.dispatchCommand(method, params, sessionId, outcome => outcome.ok ? resolve(outcome.result) : reject(outcome.error)); }
      catch (error) { reject(error); }
    }), this.interruption]);
  }

  // Replies are written in the same turn the bridge reports them, so Playwright
  // receives each one before any event the browser emitted after it.
  private receive(input: CdpMessage, ws: WebSocket): void {
    const reply = (body: Record<string, unknown>) => {
      if (this.socket === ws) this.emit({ id: input.id, ...(input.sessionId ? { sessionId: input.sessionId } : {}), ...body });
    };
    const fail = (error: unknown) => reply({ error: { code: -32000, message: String((error as Error)?.message || error) } });
    try {
      if (!Number.isInteger(input.id) || typeof input.method !== 'string') throw new Error('Invalid executor CDP command');
      this.assertActive();
      if (!input.sessionId) { reply({ result: this.browserCommand(input) }); return; }
      this.dispatchCommand(input.method, input.params ?? {}, input.sessionId, outcome => {
        if (!outcome.ok) { fail(outcome.error); return; }
        reply({ result: outcome.result });
        if (input.method === 'Page.getFrameTree') this.publishFrames();
      });
    } catch (error) { fail(error); }
  }

  private dispatchCommand(method: string, params: Record<string, any>, sessionId: string,
    done: (outcome: BrowserCommandOutcome) => void): void {
    const operation = this.assertActive();
    if (sessionId !== this.mainSessionId && (!this.permitted(this.childUrls.get(sessionId))
      || !this.frameAllowed(this.childIds.get(sessionId) || ''))) {
      throw new Error('Browser executor frame is unavailable or blocked');
    }
    const contextId = params.contextId ?? params.executionContextId;
    const contextKey = contextId !== undefined ? `${sessionId}:${contextId}` : undefined;
    const objectScope = params.objectId ? this.objectScope(params.objectId, sessionId) : undefined;
    const frameUrl = params.frameId ? this.frameUrls.get(params.frameId)
      : contextId !== undefined ? this.contextUrls.get(`${sessionId}:${contextId}`)
        : objectScope?.url;
    if ((params.frameId || contextId !== undefined || params.objectId) && !this.permitted(frameUrl)) {
      throw new Error('Browser executor frame identity is unavailable or blocked');
    }
    const scopedFrameId = params.frameId || (contextKey ? this.contextFrames.get(contextKey) : undefined) || objectScope?.frameId;
    if (scopedFrameId && !this.frameAllowed(scopedFrameId)) throw new Error('Browser executor frame ancestry is unavailable or blocked');
    if ((params.arguments ?? []).some((argument: any) => argument.objectId && !this.objectScope(argument.objectId, sessionId))) {
      throw new Error('Browser executor argument belongs to an unavailable or blocked frame');
    }
    if (method === 'DOM.getDocument' && this.hasBlockedFrames() && (params.pierce || params.depth === -1)) {
      throw new Error('Browser executor cannot traverse blocked frame documents');
    }
    const resolvedUrl = frameUrl ?? (sessionId === this.mainSessionId ? operation.origin : this.childUrls.get(sessionId));
    const resolvedFrameId = params.frameId || (contextKey ? this.contextFrames.get(contextKey) : undefined)
      || objectScope?.frameId || (sessionId === this.mainSessionId ? this.mainFrameId : this.childIds.get(sessionId));
    const resolvedContextKey = contextKey || objectScope?.contextKey;
    const commandParams = method === 'Target.setAutoAttach' ? { ...params, waitForDebuggerOnStart: false,
      filter: [{ type: 'iframe', exclude: false }] } : params;
    const mutation = method === 'Input.insertText' || method === 'DOM.setFileInputFiles'
      || (method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseWheel'].includes(params.type))
      || (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown')
      || (method === 'Runtime.callFunctionOn'
        && /\.(?:selectOptions|fill|focusNode|setInputFiles|setChecked)\(/.test(String(params.functionDeclaration || '')));
    const previousState = this.inputState;
    if (mutation && this.inputState !== 'confirmed') this.inputState = 'unknown';
    const accept = (result: Record<string, any>): Record<string, any> => {
      if (mutation) this.inputState = 'confirmed';
      if (this.assertActive() !== operation) throw new Error('Browser executor action changed');
      if (method === 'Runtime.releaseObject' && params.objectId) this.objectScopes.delete(`${sessionId}:${params.objectId}`);
      if (resolvedUrl && resolvedFrameId) {
        for (const value of [result?.result, result?.object, ...(Array.isArray(result?.result)
          ? result.result.flatMap((property: any) => [property.value, property.get, property.set]) : [])]) {
          if (value?.objectId) this.objectScopes.set(`${sessionId}:${value.objectId}`,
            { url: resolvedUrl, sessionId, frameId: resolvedFrameId, ...(resolvedContextKey ? { contextKey: resolvedContextKey } : {}) });
        }
      }
      if (method === 'DOM.describeNode' && result.node?.frameId && !this.permitted(this.frameUrls.get(result.node.frameId))) {
        throw new Error('Browser executor frame is blocked');
      }
      if (method === 'Page.getFrameTree') {
        this.readFrameTree(result.frameTree);
        return { ...result, frameTree: this.pruneFrameTree(result.frameTree) };
      }
      return result;
    };
    let settled = false;
    const settle = (outcome: BrowserCommandOutcome) => {
      if (settled) return;
      settled = true;
      if (!outcome.ok) {
        if (mutation && outcome.error.message === 'USER_ACTIVE_ON_TARGET_TAB') this.inputState = previousState;
        done(outcome); return;
      }
      let accepted: Record<string, any>;
      try { accepted = accept(outcome.result as Record<string, any>); }
      catch (error) { done({ ok: false, error: error as Error }); return; }
      done({ ok: true, result: accepted });
    };
    // A bridge reports through `settle` in arrival order; the promise is the fallback.
    operation.bridge.command(this.identity, 'playwrightCdp', {
      leaseId: operation.leaseId, approvedOrigin: operation.origin, method, params: commandParams,
      ...(sessionId !== this.mainSessionId ? { sessionId } : {}),
    }, operation.signal, settle).then(result => settle({ ok: true, result }),
      error => settle({ ok: false, error: error instanceof Error ? error : new Error(String(error)) }))
      .catch(() => undefined);
  }

  private browserCommand(message: CdpMessage): unknown {
    switch (message.method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: 'Chrome/150.0.0.0',
        revision: 'memmy', userAgent: `MemmyBrowserRelay (${process.platform === 'darwin' ? 'Macintosh'
          : process.platform === 'win32' ? 'Windows NT 10.0' : 'Linux'})`, jsVersion: '1' };
      case 'Target.setAutoAttach':
        if (!this.autoAttached) {
          this.autoAttached = true;
          this.emit({ method: 'Target.attachedToTarget', params: { sessionId: this.mainSessionId,
            targetInfo: this.targetInfo, waitingForDebugger: false } });
        }
        return {};
      case 'Target.getTargetInfo': return { targetInfo: this.targetInfo };
      case 'Target.attachToTarget':
        if (message.params?.targetId !== this.targetInfo.targetId) throw new Error('Browser executor cannot attach another tab');
        return { sessionId: this.mainSessionId };
      case 'Target.detachFromTarget': return {};
      case 'Browser.close': this.socket?.close(); return {};
      default: throw new Error(`Browser-wide CDP is unavailable: ${message.method}`);
    }
  }

  /** `detach: false` closes only this Playwright connection; the next action reuses the attached tab. */
  close(detach = true): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    if (this.operation) this.interrupt(this.operation, this.cancelledError());
    // Local disconnection must not await an unresponsive extension or desktop.
    this.disconnect();
    this.sockets.close();
    if (this.server.listening) this.server.close();
    this.endpoint = '';
    this.closePromise = this.end(detach);
    return this.closePromise;
  }
}
