import type { BrowserToolName, BrowserScope } from "./browser.js";
import { emitComputerUseSurface } from "../../../tools/computer-use/surface-preview.js";
import { browserAppKey } from "../../../tools/computer-use/native-app-key.js";
import { ExternalBrowserBridge, EXTERNAL_BROWSER_EXTENSION_NOT_READY, EXTERNAL_BROWSER_EXTENSION_NOT_READY_MESSAGE, type ExternalBrowserClaim } from "./external-browser-bridge.js";
import { OcuUserIntervened } from "../../../tools/computer-use/mac-focus-guard.js";
import { executeExternalBrowserPlaywright, externalBrowserHasBlockedFrames } from './external-browser-playwright.js';
import { BrowserUseSitePolicyReader } from './browser-use-site-policy-store.js';

type ExternalResult = Record<string, any>;
type ToolContent = Array<Record<string, any>>;

export const EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED =
  'Screenshots are not supported for Memmy in-app browser tabs. Use browser_snapshot to read the page text and element references. Do not switch to another tab or a desktop screenshot to capture this tab.';

export type BrowserCommandBridge = Pick<ExternalBrowserBridge, 'command' | 'getClaim'>
  & Partial<Pick<ExternalBrowserBridge, 'subscribePlaywright'>>
  & { isFrameAllowed?: (url: string) => boolean };

export function externalBrowserTargetId(claim: ExternalBrowserClaim): string {
  return `${claim.browser === 'memmy' ? 'embedded' : 'external'}:${claim.connectionId}:${claim.tabId}`;
}

export async function emitExternalBrowserFrame(
  bridge: BrowserCommandBridge, claim: ExternalBrowserClaim, scope: BrowserScope,
  screenshot?: ExternalResult,
  signal?: AbortSignal | null,
): Promise<void> {
  if (claim.browser === 'memmy' || signal?.aborted) return;
  // The executor that just acted knows whether a frame blocked by site policy is
  // on the page: a clear page gets a direct viewport capture, a blocked one none.
  const blocked = bridge.subscribePlaywright ? externalBrowserHasBlockedFrames(scope, claim) : false;
  if (!screenshot && blocked === true) return;
  // A presentation-only preview must not hold up the tool result or a stopped
  // turn. Some pages never finish screenshot preparation (fonts/animations).
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, blocked === false ? 1_500 : 3_000);
  const interrupted = new Promise<void>(resolve => {
    controller.signal.addEventListener('abort', () => resolve(), { once: true });
  });
  try {
    await Promise.race([(async () => {
      const policy = new BrowserUseSitePolicyReader();
      const frame = screenshot ?? (blocked === false
        ? await bridge.command(claim, "screenshot", { type: "jpeg" }, controller.signal) as ExternalResult
        : await executeExternalBrowserPlaywright({ command: bridge.command.bind(bridge), getClaim: bridge.getClaim.bind(bridge),
          subscribePlaywright: bridge.subscribePlaywright!.bind(bridge) }, claim, scope, 'screenshot', { type: 'jpeg' },
          bridge.isFrameAllowed ?? (url => policy.decision(url, 'access') !== 'block'), controller.signal));
      if (controller.signal.aborted || typeof frame.data !== "string" || !["png", "jpeg"].includes(frame.format)) return;
      const history = await bridge.command(claim, "historyState", {}, controller.signal) as ExternalResult;
      if (controller.signal.aborted) return;
      const latest = bridge.getClaim(claim) ?? claim;
      emitComputerUseSurface({ surface: "browser", ...scope,
        targetId: externalBrowserTargetId(latest), appKey: browserAppKey(latest.browser as 'chrome' | 'edge'),
        title: latest.title.slice(0, 256),
        url: latest.url.slice(0, 4096),
        canGoBack: history.canGoBack === true, canGoForward: history.canGoForward === true,
        imageDataUrl: `data:image/${frame.format};base64,${frame.data}` });
    })(), interrupted]);
  } catch { /* Preview errors must not fail the browser action. */ }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

function formatNodes(nodes: unknown, truncated = false): string {
  if (!Array.isArray(nodes)) return "No accessible elements.";
  const rendered = nodes.map((node: any) => {
    const indent = Number.isInteger(node.depth) && node.depth > 0 ? '  '.repeat(Math.min(node.depth, 12)) : '';
    const label = node.name ? ` ${JSON.stringify(node.name)}` : '';
    const hasValue = typeof node.value === 'string' && node.state?.valueRedacted !== true
      && (node.value !== '' || ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role));
    const value = hasValue ? ` value=${JSON.stringify(node.value)}` : '';
    const state = node.state && typeof node.state === 'object' ? ` state=${JSON.stringify(node.state)}` : '';
    const context = typeof node.context === 'string' && node.context ? ` in ${JSON.stringify(node.context)}` : '';
    return `${indent}${node.ref ? `[${node.ref}] ` : ""}${node.role || "generic"}${label}${value}${state}${context}`;
  }).join("\n");
  return (truncated || rendered.length > 150_000
    ? '[Observation truncated by the page budget. Use a narrow browser_find query or a unique locator for more detail.]\n' : '')
    + rendered.slice(0, 150_000);
}

function formatActionResult(result: ExternalResult): string {
  const { observation, ...status } = result ?? {};
  return JSON.stringify(status) + (observation?.nodes
    ? `\n\nObserved page after action:\n${formatNodes(observation.nodes, observation.truncated === true)}` : '');
}

function extensionConnectionFailure(error: unknown): ToolContent | null {
  if ((error as { code?: string } | null)?.code !== EXTERNAL_BROWSER_EXTENSION_NOT_READY) return null;
  return [{ type: 'text', text: JSON.stringify({ ok: false, code: EXTERNAL_BROWSER_EXTENSION_NOT_READY,
    retryable: false, noActionDispatched: true, inputDispatched: false,
    error: EXTERNAL_BROWSER_EXTENSION_NOT_READY_MESSAGE }) }];
}

/** Translate the existing browser tool vocabulary to a user-claimed Chrome/Edge tab. */
export async function callExternalBrowserTool(
  bridge: BrowserCommandBridge,
  claim: ExternalBrowserClaim,
  scope: BrowserScope,
  name: BrowserToolName,
  params: Record<string, any>,
  authorizeNavigation: (url: string) => Promise<boolean>,
  abortSignal?: AbortSignal | null,
): Promise<ToolContent> {
  if (claim.browser === 'memmy' && name === 'browser_take_screenshot') {
    throw new Error(EMBEDDED_BROWSER_SCREENSHOT_UNSUPPORTED);
  }
  if (name === 'browser_snapshot' && (claim.browser === 'memmy' || bridge.subscribePlaywright)
    && (params.boxes === true || params.target || params.ref)) {
    throw new Error('Connected browser snapshots return the page text and element references; boxes and target-scoped snapshots are not supported. Use browser_snapshot without these parameters, or browser_find with text or regex to locate a control.');
  }
  if (name === 'browser_file_upload') {
    const policy = new BrowserUseSitePolicyReader();
    let result: ExternalResult;
    try {
      result = bridge.subscribePlaywright
        ? await executeExternalBrowserPlaywright({ command: bridge.command.bind(bridge), getClaim: bridge.getClaim.bind(bridge),
          subscribePlaywright: bridge.subscribePlaywright.bind(bridge) }, claim, scope, 'upload', params,
          bridge.isFrameAllowed ?? (url => policy.decision(url, 'access') !== 'block'), abortSignal ?? undefined)
        : await bridge.command(claim, 'upload', params, abortSignal ?? undefined) as ExternalResult;
    } catch (error) {
      const failure = extensionConnectionFailure(error);
      if (failure) return failure;
      throw error;
    }
    await emitExternalBrowserFrame(bridge, claim, scope, undefined, abortSignal);
    return [{ type: 'text', text: formatActionResult(result) }];
  }
  const toolCommands: Record<BrowserToolName, string> = {
    browser_navigate: "navigate", browser_snapshot: "snapshot", browser_find: "find",
    browser_click: "click", browser_type: "type", browser_select_option: "selectOption",
    browser_press_key: "pressKey", browser_wait_for: "waitFor",
    browser_console_messages: "consoleMessages", browser_network_requests: "networkRequests",
    browser_take_screenshot: "screenshot", browser_resize: "resize",
    browser_file_upload: "unsupported",
  };
  if (name === "browser_navigate") {
    const target = new URL(String(params.url));
    if (!["http:", "https:"].includes(target.protocol)) throw new Error("External browser accepts HTTP(S) URLs only");
    if (target.origin !== new URL(claim.url).origin) {
      if (!await authorizeNavigation(target.href)) throw new Error(`Access to ${target.origin} was not approved`);
      await bridge.command(claim, "allowOrigin", { origin: target.origin });
    }
  }
  let result: ExternalResult;
  try {
    const action = toolCommands[name];
    if (bridge.subscribePlaywright
      && ['snapshot', 'find', 'click', 'type', 'selectOption', 'pressKey', 'scroll', 'waitFor', 'screenshot',
        'consoleMessages', 'networkRequests'].includes(action)) {
      const policy = new BrowserUseSitePolicyReader();
      result = await executeExternalBrowserPlaywright({ command: bridge.command.bind(bridge), getClaim: bridge.getClaim.bind(bridge),
        subscribePlaywright: bridge.subscribePlaywright.bind(bridge) },
        claim, scope, action, params, bridge.isFrameAllowed ?? (url => policy.decision(url, 'access') !== 'block'),
        abortSignal ?? undefined);
    } else result = await (abortSignal ? bridge.command(claim, action, params, abortSignal)
      : bridge.command(claim, action, params)) as ExternalResult;
  }
  catch (error) {
    const failure = extensionConnectionFailure(error);
    if (failure) return failure;
    if ((error as Error).message === "USER_ACTIVE_ON_TARGET_TAB") {
      throw new OcuUserIntervened(claim.browser === "memmy"
        ? "你正在操作 Memmy，我先暂停浏览器操作。你操作完后发条消息，我再接着做。"
        : `你正在使用这个 ${claim.browser === "edge" ? "Edge" : "Chrome"} 标签页，我先暂停了。切到其他标签页或窗口后发条消息，我再接着做。`);
    }
    throw error;
  }
  if (name === "browser_take_screenshot") {
    if (typeof result?.data !== "string" || !["png", "jpeg"].includes(result.format)) {
      throw new Error("External browser returned an invalid screenshot");
    }
    await emitExternalBrowserFrame(bridge, claim, scope, result, abortSignal);
    return [
      { type: "text", text: "Screenshot of the claimed external browser tab." },
      { type: "image", mimeType: `image/${result.format}`, data: result.data },
    ];
  }
  if (name === "browser_snapshot" || name === "browser_find") {
    await emitExternalBrowserFrame(bridge, claim, scope, undefined, abortSignal);
    return [{ type: "text", text: formatNodes(result?.nodes, result?.truncated === true) }];
  }
  await emitExternalBrowserFrame(bridge, claim, scope, undefined, abortSignal);
  return [{ type: "text", text: formatActionResult(result) }];
}
