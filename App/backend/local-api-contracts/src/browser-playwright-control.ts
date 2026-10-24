/** Fixed local executor transport. These commands are not model-visible raw CDP tools. */
export const BROWSER_PLAYWRIGHT_CDP_METHODS = [
  'Runtime.enable', 'Runtime.disable', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup',
  'Runtime.addBinding', 'Runtime.runIfWaitingForDebugger',
  'Page.enable', 'Page.disable', 'Page.getFrameTree', 'Page.getLayoutMetrics',
  'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.createIsolatedWorld',
  'Page.captureScreenshot', 'Page.handleJavaScriptDialog',
  'DOM.enable', 'DOM.getDocument', 'DOM.describeNode', 'DOM.resolveNode',
  'DOM.getContentQuads', 'DOM.getBoxModel', 'DOM.scrollIntoViewIfNeeded',
  'DOM.querySelector', 'DOM.querySelectorAll',
  'Network.enable', 'Network.disable', 'Network.setCacheDisabled',
  'Log.enable', 'Log.disable',
  'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText',
  'Emulation.setDeviceMetricsOverride', 'Emulation.clearDeviceMetricsOverride',
  'Target.setAutoAttach', 'Target.getTargetInfo',
] as const;

export type BrowserPlaywrightEvent = { sequence: number; leaseId: string; method: string;
  params: Record<string, unknown>; sessionId?: string };
