/** Commands that observe the current page without changing page or browser state. */
export const BROWSER_CDP_READ_METHODS = [
  'Accessibility.getFullAXTree', 'DOM.getDocument', 'Page.getLayoutMetrics',
  'Page.captureScreenshot', 'Runtime.evaluate',
] as const;
export type BrowserCdpReadMethod = typeof BROWSER_CDP_READ_METHODS[number];

export type BrowserCdpTarget = { sessionId: string } | { targetId: string };

export function normalizeBrowserCdpTarget(input: unknown): BrowserCdpTarget | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid CDP target');
  const target = input as Record<string, unknown>;
  if (Object.keys(target).length !== 1) throw new Error('Invalid CDP target');
  const key = Object.keys(target)[0];
  if ((key !== 'sessionId' && key !== 'targetId') || typeof target[key] !== 'string'
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(target[key] as string)) throw new Error('Invalid CDP target');
  return { [key]: target[key] } as BrowserCdpTarget;
}

export function normalizeBrowserCdpCommandOptions(input: unknown): {
  target?: BrowserCdpTarget; timeoutMs?: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid CDP options');
  const options = input as Record<string, unknown>;
  const target = normalizeBrowserCdpTarget(options.target);
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs)
    || (timeoutMs as number) < 0 || (timeoutMs as number) > 30_000)) throw new Error('Invalid CDP timeout');
  return { ...(target ? { target } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }) };
}

export function normalizeBrowserCdpReadCall(method: unknown, input: unknown): {
  method: BrowserCdpReadMethod; params: Record<string, unknown> } {
  if (typeof method !== 'string' || !BROWSER_CDP_READ_METHODS.includes(method as BrowserCdpReadMethod)
    || !input || typeof input !== 'object' || Array.isArray(input)
    || JSON.stringify(input).length > 24_000) throw new Error('CDP method or parameters are unavailable');
  const params = input as Record<string, unknown>;
  const noParams = () => { if (Object.keys(params).length) throw new Error('CDP method parameters are unavailable'); };
  switch (method) {
    case 'Accessibility.getFullAXTree':
    case 'Page.getLayoutMetrics': noParams(); return { method, params: {} };
    case 'DOM.getDocument': {
      if (Object.keys(params).some(key => !['depth'].includes(key))
        || (params.depth !== undefined && (!Number.isInteger(params.depth)
          || (params.depth as number) < 0 || (params.depth as number) > 3))) {
        throw new Error('CDP DOM depth is unavailable');
      }
      return { method, params: { depth: params.depth ?? 1, pierce: false } };
    }
    case 'Page.captureScreenshot': {
      if (Object.keys(params).some(key => key !== 'format')
        || (params.format !== undefined && params.format !== 'png' && params.format !== 'jpeg')) {
        throw new Error('CDP screenshot parameters are unavailable');
      }
      return { method, params: { format: params.format ?? 'png', captureBeyondViewport: false } };
    }
    case 'Runtime.evaluate': {
      if (Object.keys(params).some(key => key !== 'expression')
        || typeof params.expression !== 'string' || !params.expression
        || params.expression.length > 20_000) throw new Error('CDP expression is unavailable');
      return { method, params: { expression: params.expression,
        throwOnSideEffect: true, returnByValue: true, awaitPromise: false, userGesture: false } };
    }
    default: throw new Error('CDP method is unavailable');
  }
}

export function normalizeBrowserCdpEventQuery(input: unknown): {
  afterSequence?: number; limit: number; methods?: string[];
  target?: BrowserCdpTarget; timeoutMs?: number } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid CDP event query');
  const query = input as Record<string, unknown>;
  if (Object.keys(query).some(key => !['afterSequence', 'limit', 'methods', 'target', 'timeoutMs'].includes(key))
    || (query.afterSequence !== undefined && (!Number.isSafeInteger(query.afterSequence)
      || (query.afterSequence as number) < 0))
    || (query.limit !== undefined && (!Number.isInteger(query.limit)
      || (query.limit as number) < 1 || (query.limit as number) > 1000))
    || (query.methods !== undefined && (!Array.isArray(query.methods) || query.methods.length < 1
      || query.methods.length > 20 || query.methods.some(method => typeof method !== 'string'
        || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method))))) throw new Error('Invalid CDP event query');
  const options = normalizeBrowserCdpCommandOptions(query);
  return { ...(query.afterSequence === undefined ? {} : { afterSequence: query.afterSequence as number }),
    limit: (query.limit as number | undefined) ?? 100,
    ...(query.methods === undefined ? {} : { methods: query.methods as string[] }), ...options };
}
