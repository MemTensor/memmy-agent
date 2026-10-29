import { randomBytes } from 'node:crypto';
import { browserSemanticSnapshotExpression } from './browser-semantic-snapshot.js';
import { bindBrowserTextInputReceiver, verifyBrowserTextInput } from './browser-text-verification.js';
import type { Browser, Dialog, ElementHandle, Frame, Locator, Page } from 'playwright';
import type { BrowserScope } from './browser.js';
import type { ExternalBrowserClaim } from './external-browser-bridge.js';
import { ExternalBrowserPlaywrightRelay, type BrowserExecutionDiagnostics, type PlaywrightCommandBridge } from './external-browser-playwright-relay.js';

type NodeInfo = { ref: string; role: string; name: string; value: string; state?: Record<string, unknown>;
  depth?: number; context?: string };
export const EXTERNAL_BROWSER_SNAPSHOT_BUDGET = { nodes: 800, characters: 60_000, frames: 32 } as const;
type Reference = NodeInfo & { framePath: number[]; url: string; timeOrigin: number };
// Observations belong to the task, while a CDP connection can be recycled
// between any two actions (idle detach, preview failure, or reconnect).
type ScopeState = {
  observations: Map<string, Map<string, Reference>>;
  diagnostics: Map<string, BrowserExecutionDiagnostics>;
};
type Session = {
  key: string; scopeKey: string; relay: ExternalBrowserPlaywrightRelay; browser: Browser | null;
  page: Page | null; epoch: string; refs: Map<string, Reference>; state: ScopeState; idleTimer?: NodeJS.Timeout;
};
const sessions = new Map<string, Session>();
const queues = new Map<string, Promise<unknown>>();
const scopes = new Map<string, ScopeState>();
const scopeKey = (scope: BrowserScope) => JSON.stringify([scope.sessionKey, scope.channel, scope.chatId]);
const sessionKey = (scope: BrowserScope, claim: ExternalBrowserClaim) => `${scopeKey(scope)}:${claim.connectionId}:${claim.tabId}`;
const INPUT_ACTIONS = new Set(['click', 'type', 'selectOption', 'pressKey', 'scroll', 'upload']);
const EMBEDDED_FRAME_OBSERVATION_MS = 3_000;
// Long enough to span a model step, so consecutive actions reuse one connection.
const WARM_CONNECTION_MS = 45_000;
const REPLACED_PAGE_SETTLE_MS = 5_000;
const replacedPages = new WeakMap<object, number | undefined>();


function frameAt(page: Page, path: number[]): Frame | null {
  let frame: Frame | undefined = page.mainFrame();
  for (const index of path) frame = frame?.childFrames()[index];
  return frame ?? null;
}

function bounded<T>(work: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  work.catch(() => undefined);
  return Promise.race([work, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

async function capture(session: Session, allowFrame: (url: string) => boolean,
  query?: { text?: string; regex?: string }): Promise<{ nodes: NodeInfo[]; truncated: boolean }> {
  session.relay.setStage('observation');
  const nonce = randomBytes(8).toString('hex');
  const refs = new Map<string, Reference>();
  const nodes: NodeInfo[] = [];
  let visitedFrames = 0, characters = 0, truncated = false, skippedFrames = 0;
  const visit = async (frame: Frame, framePath: number[]) => {
    if (++visitedFrames > EXTERNAL_BROWSER_SNAPSHOT_BUDGET.frames) { truncated = true; return; }
    // An embedded frame can be mid-navigation or never expose a context; it
    // must not hold the whole observation, while the main document still must.
    const embedded = framePath.length > 0;
    const evaluate = <T>(expression: string) => embedded
      ? bounded(frame.evaluate(expression) as Promise<T>, EMBEDDED_FRAME_OBSERVATION_MS, 'Embedded frame did not respond')
      : frame.evaluate(expression) as Promise<T>;
    let captured: { nodes: NodeInfo[]; timeOrigin: number; url: string; truncated: boolean };
    try {
      // Existing OOPIFs can initially have an empty public Frame.url() after
      // CDP attachment. Read only location first, then check policy before DOM.
      const url = await evaluate<string>('location.href');
      if (url !== 'about:blank' && url !== 'about:srcdoc' && !allowFrame(url)) return;
      if (embedded) await bounded(frame.waitForLoadState('domcontentloaded'),
        EMBEDDED_FRAME_OBSERVATION_MS, 'Embedded frame did not respond');
      captured = await evaluate(browserSemanticSnapshotExpression(`${nonce}${framePath.join('a') || 'b'}`, query));
      if (url !== captured.url) throw new Error('Browser frame changed during observation');
    } catch (error) {
      if (!embedded || session.relay.actionError) throw error;
      skippedFrames++; truncated = true; return;
    }
    truncated ||= captured.truncated;
    // Embedded frame content follows the page, under a line naming the frame's host.
    let host = '';
    try { host = new URL(captured.url).host; } catch { /* about:blank and srcdoc frames have no host. */ }
    const frameNodes = embedded && captured.nodes.length
      ? [{ ref: '', role: 'iframe', name: host, value: '', ...(query ? {} : { depth: framePath.length - 1 }) }, ...captured.nodes.map(node => query
        ? { ...node, context: [`iframe ${host}`.trim(), node.context].filter(Boolean).join(' > ') }
        : { ...node, depth: (node.depth ?? 0) + framePath.length })]
      : captured.nodes;
    for (const node of frameNodes) {
      if (query && !node.ref) continue;
      const size = JSON.stringify(node).length;
      if (nodes.length >= EXTERNAL_BROWSER_SNAPSHOT_BUDGET.nodes
        || characters + size > EXTERNAL_BROWSER_SNAPSHOT_BUDGET.characters) { truncated = true; continue; }
      characters += size;
      if (node.ref) refs.set(node.ref, { ...node, framePath, url: captured.url, timeOrigin: captured.timeOrigin });
      nodes.push(node);
    }
    for (const [index, child] of frame.childFrames().entries()) await visit(child, [...framePath, index]);
  };
  await visit(session.page!.mainFrame(), []);
  if (scopes.get(session.scopeKey) !== session.state || session.relay.actionError) {
    throw session.relay.actionError ?? new Error('Browser observation belongs to an ended task');
  }
  if (skippedFrames) nodes.push({ ref: '', role: 'note', value: '',
    name: `${skippedFrames} embedded frame(s) did not respond and were left out; observe again if their content is needed.` });
  session.refs = refs;
  session.state.observations.set(session.key, refs);
  return { nodes, truncated };
}

type BrowserTarget = Locator | ElementHandle;

async function target(session: Session, value: unknown, allowFrame: (url: string) => boolean): Promise<BrowserTarget> {
  const raw = String(value || '').trim();
  const text = /^\[(pw-[a-f0-9]+-\d+)\]$/.exec(raw)?.[1] ?? raw;
  if (!text || text.length > 2000) throw new Error('A page element reference or selector is required');
  if (!text.startsWith('pw-')) {
    if (/^ax-\d+$/.test(text)) throw new Error('This element reference is stale. Read browser_snapshot again.');
    return session.page!.locator(text);
  }
  const reference = session.refs.get(text);
  if (!reference) throw new Error('This element reference is stale. Read browser_snapshot again.');
  const frame = frameAt(session.page!, reference.framePath);
  if (!frame || !allowFrame(reference.url)) {
    throw new Error('This element frame changed or is blocked. Read browser_snapshot again.');
  }
  const locate = frame.evaluate('({url:location.href,timeOrigin:performance.timeOrigin})') as Promise<{ url: string; timeOrigin: number }>;
  const current = reference.framePath.length
    ? await bounded(locate, EMBEDDED_FRAME_OBSERVATION_MS, 'This element frame did not respond. Read browser_snapshot again.')
    : await locate;
  if (current.url !== reference.url || current.timeOrigin !== reference.timeOrigin) {
    throw new Error('This element document changed. Read browser_snapshot again.');
  }
  // CSS attributes and role/name can be cloned or reused by an SPA. Retrieve
  // the exact element from the world that created the snapshot. A handle keeps
  // Playwright from silently re-resolving to a replacement before dispatch.
  const remote = await frame.evaluateHandle((ref: string) => {
    const refs = (globalThis as any)[Symbol.for('memmy.playwright.element.refs')];
    const element = refs?.get(ref)?.deref();
    return element?.isConnected && element.ownerDocument === (globalThis as any).document ? element : null;
  }, text);
  const handle = remote.asElement();
  if (!handle) {
    await remote.dispose().catch(() => undefined);
    throw new Error('This element reference is stale. Read browser_snapshot again.');
  }
  return handle;
}

async function withTarget<T>(session: Session, value: unknown, allowFrame: (url: string) => boolean,
  action: (target: BrowserTarget) => Promise<T>): Promise<T> {
  const selected = await target(session, value, allowFrame);
  try { return await action(selected); }
  finally { if ('dispose' in selected) await selected.dispose().catch(() => undefined); }
}

/** Detach only when the tab is released; a reconnect keeps the debugger attached. */
async function dispose(session: Session, detach = true): Promise<void> {
  clearTimeout(session.idleTimer);
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  // Closing the relay disconnects Playwright without closing the user's tab.
  await session.relay.close(detach);
  session.browser = null; session.page = null;
}

/** Whether the tab's connected executor sees a frame blocked by site policy; undefined when it is not connected. */
export function externalBrowserHasBlockedFrames(scope: BrowserScope, claim: ExternalBrowserClaim): boolean | undefined {
  const session = sessions.get(sessionKey(scope, claim));
  return session?.browser ? session.relay.hasBlockedFrames() : undefined;
}

export async function closeExternalBrowserPlaywrightScope(scope: BrowserScope): Promise<void> {
  const key = scopeKey(scope);
  // Revoke queued work synchronously, before awaiting connection cleanup.
  scopes.delete(key);
  await Promise.allSettled([...sessions.values()].filter(session => session.scopeKey === key).map(session => dispose(session)));
}

export async function closeAllExternalBrowserPlaywright(): Promise<void> {
  scopes.clear();
  await Promise.allSettled([...sessions.values()].map(session => dispose(session)));
}

/** Ordinary browser actions only; this does not accept model CDP or JavaScript. */
export async function executeExternalBrowserPlaywright(bridge: PlaywrightCommandBridge,
  claim: ExternalBrowserClaim, scope: BrowserScope, action: string, args: Record<string, any>,
  allowFrame: (url: string) => boolean, signal?: AbortSignal,
  internal: { afterDocument?: number } = {}): Promise<Record<string, any>> {
  const key = sessionKey(scope, claim);
  const ownerKey = scopeKey(scope);
  const owner: ScopeState = scopes.get(ownerKey) ?? { observations: new Map(), diagnostics: new Map() };
  scopes.set(ownerKey, owner);
  const diagnostics = owner.diagnostics.get(key) ?? { consoleRecords: [], networkRecords: [] };
  owner.diagnostics.set(key, diagnostics);
  const tabKey = `${claim.connectionId}:${claim.tabId}`;
  const previous = queues.get(tabKey) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(async () => {
    if (signal?.aborted || scopes.get(ownerKey) !== owner) throw new Error('Browser executor cancelled');
    const operationId = randomBytes(6).toString('hex');
    const startedAt = Date.now();
    const diagnostic = (outcome: string, error?: Error & { stage?: string; code?: string }) => {
      console.info('[browser-executor]', JSON.stringify({ operationId, action, browser: claim.browser,
        outcome, elapsedMs: Date.now() - startedAt,
        ...(error?.stage ? { stage: error.stage } : {}), ...(error?.code ? { code: error.code } : {}) }));
    };
    diagnostic('started');
    let outcome = 'completed';
    let session = sessions.get(key);
    if (!session) {
      session = { key, scopeKey: ownerKey, state: owner, relay: new ExternalBrowserPlaywrightRelay(claim, allowFrame, diagnostics),
        browser: null, page: null, epoch: '', refs: owner.observations.get(key) ?? new Map() };
      sessions.set(key, session);
    }
    clearTimeout(session.idleTimer);
    session.relay.setFramePolicy(allowFrame);
    const origin = new URL(claim.url).origin;
    const abort = () => { void dispose(session!); };
    signal?.addEventListener('abort', abort, { once: true });
    let documentEpoch: number | undefined;
    let textVerified = false;
    const dialogs: Array<{ type: string; handled: 'accepted' | 'dismissed'; message?: string }> = [];
    let removeDialogListener = () => undefined as unknown;
    const withDialogs = <T extends Record<string, any>>(result: T): T => dialogs.length ? { ...result, dialogs,
      ...(dialogs.some(dialog => dialog.handled === 'dismissed' && dialog.type !== 'alert')
        ? { dialogNote: 'The page asked for confirmation and it was dismissed. Repeat the action with acceptDialog: true only if the task requires accepting.' } : {}) } : result;
    try {
      if (claim.browser === 'memmy' && action === 'screenshot') throw new Error('Screenshots are not supported for Memmy in-app browser tabs');
      const uploadPaths = action === 'upload' ? args.paths as string[] : undefined;
      let state = await session.relay.begin(bridge, origin, INPUT_ACTIONS.has(action), !session.browser, signal, uploadPaths);
      const epoch = `${state.documentEpoch}:${state.cdpEpoch}:${state.frameEpoch}:${state.frameVersion}`;
      // Older peers do not provide a complete frame-lifecycle generation. A
      // fresh connection preserves correctness until their automatic update.
      if (session.browser && (state.frameEpoch === null || session.epoch !== epoch)) {
        const refs = session.refs;
        await dispose(session, false);
        // The old connection is absent from sessions while native cleanup is
        // pending. Task revocation during that gap must prevent reacquisition.
        if (signal?.aborted || scopes.get(ownerKey) !== owner) throw new Error('Browser executor cancelled');
        session = { key, scopeKey: ownerKey, state: owner, relay: new ExternalBrowserPlaywrightRelay(claim, allowFrame, diagnostics),
          browser: null, page: null, epoch: '', refs };
        sessions.set(key, session);
        state = await session.relay.begin(bridge, origin, INPUT_ACTIONS.has(action), true, signal, uploadPaths);
      }
      documentEpoch = state.documentEpoch;
      if (internal.afterDocument !== undefined && documentEpoch <= internal.afterDocument) {
        throw new Error('The replacement page has not loaded yet');
      }
      if (!session.browser) {
        session.relay.setStage('connection');
        const { chromium } = await import('playwright');
        const endpoint = await session.relay.start();
        session.browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, timeout: 15_000 });
        const pages = session.browser.contexts().flatMap(context => context.pages());
        if (pages.length !== 1) throw new Error('Browser executor did not receive exactly the selected tab');
        session.page = pages[0];
        session.page.setDefaultTimeout(8_000);
      }
      session.epoch = `${state.documentEpoch}:${state.cdpEpoch}:${state.frameEpoch}:${session.relay.frameVersion()}`;
      const page = session.page!;
      const observed = async (result: Record<string, unknown>) => ({ ...result,
        observation: await capture(session!, allowFrame) });
      const assertUntargetedInputAllowed = (afterInput = false) => {
        if (session!.relay.hasBlockedFrames() || page.frames().some(frame =>
          !['about:blank', 'about:srcdoc'].includes(frame.url()) && !allowFrame(frame.url()))) {
          throw Object.assign(new Error('Untargeted input is unavailable while the page contains a frame blocked by site policy'),
            { inputTargetUncertain: afterInput });
        }
      };
      session.relay.setStage(action);
      // Dialogs are dismissed unless the caller asked to accept them; either way
      // the result reports them, since a dismissed confirm usually stops the step.
      const blockedFrames = session.relay.hasBlockedFrames();
      const onDialog = (dialog: Dialog) => {
        const accept = args.acceptDialog === true && INPUT_ACTIONS.has(action);
        dialogs.push({ type: dialog.type(), handled: accept ? 'accepted' : 'dismissed',
          ...(blockedFrames ? {} : { message: dialog.message().slice(0, 500) }) });
        void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
      };
      page.on('dialog', onDialog);
      removeDialogListener = () => page.off('dialog', onDialog);
      const actionSession = session;
      const perform = async (): Promise<Record<string, any>> => {
        switch (action) {
          case 'consoleMessages': return { messages: actionSession.relay.consoleMessages() };
          case 'networkRequests': return { requests: actionSession.relay.networkRequests() };
          case 'snapshot': return await capture(actionSession, allowFrame);
          case 'find': {
            return await capture(actionSession, allowFrame, { text: String(args.text || ''),
              regex: args.regex ? String(args.regex).slice(0, 250) : undefined });
          }
          case 'click': {
            if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
              assertUntargetedInputAllowed();
              await page.mouse.click(args.x, args.y,
                { button: args.button || 'left', clickCount: args.doubleClick ? 2 : 1 });
              assertUntargetedInputAllowed(true);
            }
            else {
              await withTarget(actionSession, args.target || args.ref, allowFrame, async locator => {
                const options = { button: args.button || 'left', modifiers: args.modifiers };
                if (args.doubleClick) await locator.dblclick(options); else await locator.click(options);
              });
            }
            return await observed({ ok: true, inputDispatched: true });
          }
          case 'type': {
            const text = String(args.text || '');
            if (text.length > 100_000) throw new Error('Text is too long');
            const verification = await withTarget(actionSession, args.target || args.ref, allowFrame, async locator => {
              // Bind selectors too: neither verification nor submission may silently
              // move to a replacement field after the input has been dispatched.
              const selected = 'elementHandle' in locator ? await locator.elementHandle() : locator;
              if (!selected) throw new Error('The input field is no longer available; take a new snapshot.');
              let field: ElementHandle | undefined;
              try {
                field = await bindBrowserTextInputReceiver(selected);
                if (args.slowly) {
                  await field.fill('');
                  await field.type(text);
                } else await field.fill(text);
                const verified = await verifyBrowserTextInput(field, text);
                textVerified = ['matched', 'normalized'].includes(verified.status);
                if (args.submit && ['matched', 'normalized'].includes(verified.status)) await field.press('Enter');
                return verified;
              } finally {
                await field?.dispose().catch(() => undefined);
                if (selected !== locator) await selected.dispose().catch(() => undefined);
              }
            });
            const inputVerified = ['matched', 'normalized'].includes(verification.status);
            return await observed({ ok: inputVerified, inputDispatched: true, inputVerified, verification,
              ...(args.submit ? { submitted: inputVerified } : {}),
              ...(!inputVerified ? { freshObservationRequired: true,
                error: 'The field did not retain the requested text. Inspect the observation before acting; input was not replayed.' } : {}) });
          }
          case 'selectOption': {
            const values = Array.isArray(args.values) ? args.values.map(String) : [String(args.value || '')];
            const selected = await withTarget(actionSession, args.target || args.ref, allowFrame,
              locator => locator.selectOption(values));
            return await observed({ value: selected.length === 1 ? selected[0] : selected, values: selected });
          }
          case 'pressKey': {
            const key = String(args.key || '').replace(/\bCtrl\b/g, 'Control').replace(/\bCommand\b/g, 'Meta');
            if (!key || key.length > 50) throw new Error('Invalid key');
            assertUntargetedInputAllowed();
            await page.keyboard.press(key);
            assertUntargetedInputAllowed(true);
            return await observed({ ok: true, inputDispatched: true });
          }
          case 'scroll': {
            assertUntargetedInputAllowed();
            await page.mouse.wheel(Number(args.deltaX) || 0, Number(args.deltaY) || 0);
            assertUntargetedInputAllowed(true);
            return await observed({ ok: true, inputDispatched: true });
          }
          case 'upload': {
            if (!Array.isArray(uploadPaths) || !uploadPaths.length || uploadPaths.length > 20
              || uploadPaths.some(file => typeof file !== 'string' || !file)) throw new Error('Approved upload paths are required');
            await withTarget(actionSession, args.target || args.ref, allowFrame,
              locator => locator.setInputFiles(uploadPaths));
            return await observed({ ok: true, uploaded: uploadPaths.length });
          }
          case 'waitFor': {
            const timeout = Math.min(25_000, Math.max(0, Number(args.time || 0) * 1000)) || 5_000;
            const deadline = Date.now() + timeout;
            if (!args.text && !args.textGone) {
              if (args.time) await page.waitForTimeout(timeout);
            } else while (true) {
              const result = await capture(actionSession, allowFrame);
              const text = result.nodes.map(node => `${node.name} ${node.value}`).join('\n');
              if ((!args.text || text.includes(String(args.text))) && (!args.textGone || !text.includes(String(args.textGone)))) break;
              if (Date.now() >= deadline) throw new Error('Wait condition was not met');
              await page.waitForTimeout(150);
            }
            return { ok: true };
          }
          case 'screenshot': {
            const assertScreenshotAllowed = () => {
              if (actionSession.relay.hasBlockedFrames() || page.frames().some(frame => !['about:blank', 'about:srcdoc'].includes(frame.url()) && !allowFrame(frame.url()))) {
                throw new Error('Screenshot includes a frame blocked by site policy');
              }
            };
            assertScreenshotAllowed();
            const type = args.type === 'jpeg' ? 'jpeg' : 'png';
            if (args.fullPage && (args.target || args.ref)) throw new Error('Choose fullPage or an element screenshot');
            const data = args.target || args.ref
              ? await withTarget(actionSession, args.target || args.ref, allowFrame, locator => locator.screenshot({ type }))
              : await page.screenshot({ type, fullPage: args.fullPage === true });
            assertScreenshotAllowed();
            return { format: type, data: data.toString('base64') };
          }
          default: throw new Error('Unsupported Playwright browser action');
        }
      };
      // frame.evaluate can wait for an execution-context event without an
      // outstanding CDP command. Its wait is not covered by locator timeouts.
      return withDialogs(await Promise.race([perform(), session.relay.waitForInterruption()]));
    } catch (error) {
      const actionError = session.relay.actionError ?? error;
      outcome = signal?.aborted ? 'cancelled' : 'failed';
      diagnostic(outcome, actionError as Error);
      const dispatchState = session.relay.dispatchState();
      const replaced = session.relay.documentWasReplaced();
      await dispose(session, false);
      const message = signal?.aborted ? 'Browser executor cancelled' : String((actionError as Error)?.message || actionError);
      if (!signal?.aborted && message !== 'USER_ACTIVE_ON_TARGET_TAB' && dispatchState !== 'none' && replaced
        && !(actionError as Error & { inputTargetUncertain?: boolean }).inputTargetUncertain) {
        // Input was sent and then the tab moved to a new document, as a submit or link does.
        const unverifiedText = action === 'type' && !textVerified;
        const result = withDialogs({ ok: dispatchState === 'confirmed' && !unverifiedText, dispatchState,
          inputDispatched: dispatchState === 'confirmed', noActionDispatched: false, pageChanged: true,
          ...(unverifiedText ? { inputVerified: false, freshObservationRequired: true,
            error: 'The page changed before the input value could be verified. Input was not replayed.' } : {}) });
        replacedPages.set(result, documentEpoch);
        return result;
      }
      if (!signal?.aborted && message !== 'USER_ACTIVE_ON_TARGET_TAB' && dispatchState !== 'none') {
        return withDialogs({ ok: false, dispatchState, inputDispatched: dispatchState === 'confirmed',
          noActionDispatched: false, freshObservationRequired: true, error: message,
          ...((actionError as Error & { inputTargetUncertain?: boolean }).inputTargetUncertain
            ? { inputTargetUncertain: true } : {}) });
      }
      const failure = actionError instanceof Error && !signal?.aborted ? actionError : new Error(message);
      Object.assign(failure, { dispatchState, noActionDispatched: dispatchState === 'none', freshObservationRequired: true });
      if (message !== 'USER_ACTIVE_ON_TARGET_TAB') failure.message += dispatchState === 'none'
        ? ' No input was dispatched; take a fresh observation before acting.'
        : ' Input may already have been dispatched; take a fresh observation before acting.';
      throw failure;
    } finally {
      removeDialogListener();
      signal?.removeEventListener('abort', abort);
      await session.relay.end();
      if (sessions.get(key) === session) {
        session.idleTimer = setTimeout(() => void dispose(session!), WARM_CONNECTION_MS);
        session.idleTimer.unref?.();
      }
      if (outcome === 'completed') diagnostic(outcome);
    }
  });
  queues.set(tabKey, work);
  void work.finally(() => { if (queues.get(tabKey) === work) queues.delete(tabKey); }).catch(() => undefined);
  return work.then(result => replacedPages.has(result) && !signal?.aborted
    ? observeReplacedPage(bridge, claim, scope, result, replacedPages.get(result), allowFrame, signal) : result);
}

/** Reads the document that replaced the page after an action, once it is the current one. */
async function observeReplacedPage(bridge: PlaywrightCommandBridge, claim: ExternalBrowserClaim, scope: BrowserScope,
  result: Record<string, any>, previousDocument: number | undefined, allowFrame: (url: string) => boolean,
  signal?: AbortSignal): Promise<Record<string, any>> {
  const origin = new URL(claim.url).origin;
  const settleBy = Date.now() + REPLACED_PAGE_SETTLE_MS;
  for (let attempt = 0; !signal?.aborted; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt ? 300 : 100));
    const latest = bridge.getClaim(claim);
    if (!latest) break;
    if (new URL(latest.url).origin !== origin) {
      return { ...result, observation: { nodes: [{ ref: '', role: 'note', value: latest.url.slice(0, 2000),
        name: 'The page moved to another site. Observe it with browser_snapshot, which asks for access if needed.' }], truncated: false } };
    }
    const lastTry = Date.now() >= settleBy;
    try {
      // Until the deadline, only a newer document counts as the result page.
      const observation = await executeExternalBrowserPlaywright(bridge, latest, scope, 'snapshot', {}, allowFrame, signal,
        lastTry ? {} : { afterDocument: previousDocument });
      return { ...result, observation };
    } catch { if (lastTry) break; }
  }
  return { ...result, freshObservationRequired: true };
}
