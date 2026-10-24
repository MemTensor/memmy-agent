/** Browser-service CDP policy recreated from the installed package's observable gate. */
const allowedDomains = new Set([
  'Accessibility', 'Audits', 'Console', 'CSS', 'Debugger', 'DOM', 'DOMDebugger',
  'DOMSnapshot', 'Emulation', 'Fetch', 'IO', 'Input', 'Inspector', 'Log', 'Network',
  'Overlay', 'Page', 'Performance', 'Profiler', 'Runtime', 'Tracing', 'WebAudio',
]);

const blockedMethods = new Set([
  'DOM.getFileInfo', 'DOM.setFileInputFiles', 'Input.dispatchKeyEvent', 'Input.setInterceptDrags',
  'Network.clearBrowserCookies', 'Network.deleteDeviceBoundSession',
  'Network.enableDeviceBoundSessions', 'Network.getAllCookies',
  'Network.getResponseBodyForInterception', 'Network.setCookieControls',
  'Network.setExtraHTTPHeaders', 'Network.setRequestInterception',
  'Network.takeResponseBodyForInterceptionAsStream', 'Page.addScriptToEvaluateOnLoad',
  'Page.addScriptToEvaluateOnNewDocument', 'Page.crash', 'Page.disable',
  'Page.getNavigationHistory', 'Page.resetNavigationHistory', 'Page.setAdBlockingEnabled',
  'Page.setBypassCSP', 'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog',
  'Page.setRPHRegistrationMode', 'Page.setSPCTransactionMode', 'Tracing.requestMemoryDump',
  'Fetch.disable', 'Input.dispatchDragEvent', 'Network.continueInterceptedRequest',
  'Network.getCertificate', 'Network.loadNetworkResource', 'Network.replayXHR',
  'Page.navigate', 'Page.navigateToHistoryEntry',
]);

function urlField(method: string, value: Record<string, unknown>, field: string, required = false): string[] {
  const target = value[field];
  if (target === undefined && !required) return [];
  if (typeof target !== 'string' || !target || target.length > 4096) {
    throw new Error(`${method} requires a valid ${field} for origin approval`);
  }
  return [target];
}

function cookieUrls(method: string, value: Record<string, unknown>): string[] {
  if (['domain', 'sourcePort', 'sourceScheme'].some(field => Object.hasOwn(value, field))) {
    throw new Error(`${method} requires an explicit URL instead of domain or source fields`);
  }
  const urls = urlField(method, value, 'url', true);
  if (value.partitionKey !== undefined) {
    if (!value.partitionKey || typeof value.partitionKey !== 'object'
      || Array.isArray(value.partitionKey)) throw new Error('Invalid CDP cookie partition key');
    urls.push(...urlField(method, value.partitionKey as Record<string, unknown>, 'topLevelSite'));
  }
  return urls;
}

function destinationUrls(method: string, params: Record<string, unknown>): string[] {
  switch (method) {
    case 'Fetch.continueRequest': return urlField(method, params, 'url');
    case 'Fetch.continueResponse':
    case 'Fetch.fulfillRequest': {
      if (params.responseHeaders === undefined) return [];
      if (!Array.isArray(params.responseHeaders) || params.responseHeaders.length > 100) {
        throw new Error('Invalid CDP response headers');
      }
      const urls: string[] = [];
      for (const header of params.responseHeaders) {
        if (!header || typeof header !== 'object' || Array.isArray(header)
          || typeof header.name !== 'string' || typeof header.value !== 'string') {
          throw new Error('Invalid CDP response header');
        }
        if (header.name.trim().toLowerCase() === 'location') urls.push(header.value);
      }
      return urls;
    }
    case 'Network.deleteCookies':
    case 'Network.setCookie': return cookieUrls(method, params);
    case 'Network.setCookies': {
      if (params.cookies === undefined) return [];
      if (!Array.isArray(params.cookies) || params.cookies.length > 20) throw new Error('Invalid CDP cookies');
      return params.cookies.flatMap(cookie => {
        if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
          throw new Error('Invalid CDP cookie');
        }
        return cookieUrls(method, cookie as Record<string, unknown>);
      });
    }
    case 'Network.getCookies': {
      if (!Array.isArray(params.urls) || params.urls.length < 1 || params.urls.length > 20
        || params.urls.some(url => typeof url !== 'string' || !url || url.length > 4096)) {
        throw new Error('Network.getCookies requires explicit URLs for origin approval');
      }
      return params.urls as string[];
    }
    case 'Page.deleteCookie': return urlField(method, params, 'url', true);
    default: return [];
  }
}

function validateSpecialParameters(method: string, params: Record<string, unknown>): void {
  const unavailable = () => { throw new Error(`${method} parameters are unavailable through raw CDP`); };
  if ((method === 'Fetch.continueResponse' || method === 'Fetch.fulfillRequest')
    && params.binaryResponseHeaders != null) unavailable();
  if (method === 'Network.configureDurableMessages' && params.maxTotalBufferSize != null) unavailable();
  if (method === 'Network.enable' && params.enableDurableMessages === true) unavailable();
  if (method === 'Page.createIsolatedWorld' && params.grantUniveralAccess === true) unavailable();
  if (method === 'Page.reload' && params.scriptToEvaluateOnLoad != null) unavailable();
  if (method === 'Tracing.start') {
    const options = typeof params.options === 'string' ? params.options.split(',').map(value => value.trim()) : [];
    const trace = params.traceConfig && typeof params.traceConfig === 'object'
      && !Array.isArray(params.traceConfig) ? params.traceConfig as Record<string, unknown> : {};
    if (params.perfettoConfig != null || params.tracingBackend === 'system'
      || options.includes('enable-systrace') || trace.enableSystrace === true
      || trace.memoryDumpConfig != null) unavailable();
  }
  if (method === 'Fetch.enable') {
    if (!Array.isArray(params.patterns) || params.patterns.length > 50
      || params.patterns.some(pattern => !pattern || typeof pattern !== 'object'
        || Array.isArray(pattern) || typeof pattern.resourceType !== 'string'
        || pattern.resourceType === 'Document')) unavailable();
  }
}

/** Returns every explicit destination that needs its own access and CDP decision. */
export function normalizeBrowserCdpWriteCall(method: unknown, input: unknown): {
  method: string; params: Record<string, unknown>; targetUrls: string[] } {
  if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)
    || !allowedDomains.has(method.split('.')[0]!) || blockedMethods.has(method)
    || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('CDP method or parameters are unavailable');
  }
  let encoded: string;
  try { encoded = JSON.stringify(input); }
  catch { throw new Error('CDP parameters are unavailable'); }
  if (!encoded || encoded.length > 24_000) throw new Error('CDP parameters are unavailable');
  const params = JSON.parse(encoded) as Record<string, unknown>;
  validateSpecialParameters(method, params);
  const targetUrls = destinationUrls(method, params);
  if (targetUrls.length > 20) throw new Error('Too many CDP destination URLs');
  return { method, params, targetUrls };
}
