import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extensions", "memmy-browser");

describe("Chrome and Edge extension packaging", () => {
  it("includes the unpacked MV3 extension in every desktop package variant", () => {
    for (const configName of [
      "electron-builder.yml", "electron-builder.unsigned.yml",
      "electron-builder.win.yml", "electron-builder.win.unsigned.yml",
    ]) {
      const config = YAML.parse(fs.readFileSync(path.join(root, configName), "utf8"));
      expect(config.extraResources).toContainEqual({
        from: "extensions/memmy-browser", to: "browser-extension", filter: ["**/*"],
      });
    }
    for (const file of ["manifest.json", "background.js", "popup.html", "popup.js", "auth.html", "auth.js"]) {
      expect(fs.existsSync(path.join(extension, file))).toBe(true);
    }
  });

  it("uses a deterministic browser ID and limits extension privileges", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extension, "manifest.json"), "utf8"));
    expect(manifest.manifest_version).toBe(3);
    const id = [...createHash("sha256").update(Buffer.from(manifest.key, "base64"))
      .digest().subarray(0, 16)].flatMap(value => [value >> 4, value & 15])
      .map(value => String.fromCharCode(97 + value)).join("");
    expect(id).toBe("mhodbgbbgalbhehapffidmdegokpoaom");
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*"]);
    expect(manifest.permissions).not.toContain("history");
    expect(manifest.permissions).not.toContain("cookies");
  });

  it("pauses writes while the user is focused on the claimed tab", async () => {
    const sendCommand = async () => ({ nodes: [] });
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} }, sendCommand },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: true, windowId: 1, url: "https://example.test/" }) },
      windows: { get: async () => ({ focused: true }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: "Chrome" }, URL });
    vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
    vm.runInContext("claims.set(7, { allowedOrigins: new Set(['https://example.test']) })", context);
    await expect(vm.runInContext("run(7, 'click', {x: 10, y: 10})", context))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    await expect(vm.runInContext("run(7, 'cdpWrite', {approvedOrigin: 'https://example.test', method: 'Runtime.evaluate', params: {expression: 'document.title = \"changed\"'}}, 'write-1')", context))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    await expect(vm.runInContext("run(7, 'snapshot', {})", context))
      .resolves.toMatchObject({ nodes: [] });
  });

  it("captures viewport and element screenshots at CSS or device resolution", async () => {
    const captures: Array<Record<string, unknown>> = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") return { result: { value: 2 } };
          if (method === "Page.getLayoutMetrics") return {
            cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 900, clientHeight: 600 },
          };
          if (method === "DOM.resolveNode") return { object: { objectId: "element-1" } };
          if (method === "Runtime.callFunctionOn") return {
            result: { value: { x: 10, y: 20, width: 72, height: 21 } },
          };
          if (method === "Page.captureScreenshot") { captures.push(params); return { data: "png" }; }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: "Chrome" }, URL });
    vm.runInContext(fs.readFileSync(path.join(extension, "background.js"), "utf8"), context);
    await vm.runInContext("screenshot(7, {})", context);
    await vm.runInContext("screenshot(7, {target: 'ax-3', scale: 'device'})", context);
    expect(captures).toMatchObject([
      { clip: { width: 900, height: 600, scale: 0.5 } },
      { clip: { x: 10, y: 20, width: 72, height: 21, scale: 1 } },
    ]);
  });

  it('sets files only on the approved claimed tab and live file input', async () => {
    const methods: string[] = [];
    let currentUrl = 'https://example.test/form';
    let fileInput = true;
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => {
          methods.push(method);
          if (method === 'DOM.resolveNode') return { object: { objectId: 'file-input' } };
          if (method === 'Runtime.callFunctionOn') return { result: { value: fileInput } };
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: currentUrl }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, { allowedOrigins: new Set(['https://example.test']) })", context);
    const args = { target: 'ax-3', paths: ['/tmp/approved.txt'], approvedOrigin: 'https://example.test' };
    (context as Record<string, unknown>).args = args;
    await expect(vm.runInContext('run(7, "upload", args, "operation-1")', context)).resolves.toEqual({ uploaded: 1 });
    expect(methods).toContain('DOM.setFileInputFiles');
    methods.length = 0;
    currentUrl = 'https://other.test/form';
    await expect(vm.runInContext('run(7, "upload", args, "operation-2")', context)).rejects.toThrow(/site changed/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    currentUrl = 'https://example.test/form';
    fileInput = false;
    await expect(vm.runInContext('run(7, "upload", args, "operation-3")', context)).rejects.toThrow(/not a file input/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    fileInput = true;
    vm.runInContext("cancelledCommands.add('operation-4')", context);
    await expect(vm.runInContext('run(7, "upload", args, "operation-4")', context)).rejects.toThrow(/cancelled/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
    vm.runInContext('claims.delete(7)', context);
    await expect(vm.runInContext('run(7, "upload", args, "operation-5")', context)).rejects.toThrow(/not connected/);
    expect(methods).not.toContain('DOM.setFileInputFiles');
  });

  it('keeps CDP reads on the approved claim and drops prior-origin events', async () => {
    let currentUrl = 'https://example.test/page';
    let changeDuringRead = false;
    let roundTripDuringRead = false;
    const methods: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          methods.push(method);
          if (method === 'Runtime.evaluate') {
            expect(params).toMatchObject({ expression: 'document.title', throwOnSideEffect: true,
              returnByValue: true, awaitPromise: false, userGesture: false });
            if (changeDuringRead) currentUrl = 'https://other.test/page';
            if (roundTripDuringRead) {
              vm.runInContext("resetCdpOrigin(claims.get(7), 'https://other.test'); resetCdpOrigin(claims.get(7), 'https://example.test')", context);
            }
            return { result: { value: 'Old title' } };
          }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, url: currentUrl }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, { origin: 'https://example.test', allowedOrigins: new Set(['https://example.test', 'https://other.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpSessions: new Map(), cdpWaiters: new Set() })", context);
    const call = { approvedOrigin: 'https://example.test', method: 'Runtime.evaluate',
      params: { expression: 'document.title' } };
    (context as Record<string, unknown>).args = call;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-1')", context))
      .resolves.toMatchObject({ result: { value: 'Old title' } });
    methods.length = 0;
    call.method = 'DOM.setFileInputFiles';
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-2')", context))
      .rejects.toThrow(/unavailable/);
    expect(methods).toEqual([]);
    call.method = 'Runtime.evaluate';
    changeDuringRead = true;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-3')", context))
      .rejects.toThrow(/site changed/);
    currentUrl = 'https://example.test/page';
    changeDuringRead = false;
    roundTripDuringRead = true;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-4')", context))
      .rejects.toThrow(/claim changed/);
    roundTripDuringRead = false;
    vm.runInContext("resetCdpOrigin(claims.get(7), 'https://example.test'); claims.get(7).cdpEvents.push({sequence: 1, method: 'Runtime.consoleAPICalled', params: {type: 'old'}})", context);
    currentUrl = 'https://other.test/page';
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://other.test', afterSequence: 0 };
    await expect(vm.runInContext("run(7, 'cdpEvents', args, 'events-1')", context))
      .resolves.toMatchObject({ events: [] });
  });

  it('executes only claimed, idle CDP writes with approved destination origins', async () => {
    let currentUrl = 'https://example.test/page';
    const methods: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => { methods.push(method); return {}; } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: currentUrl }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), console: [], requests: [], cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set()})", context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-2')", context)).resolves.toEqual({});
    expect(methods).toContain('Runtime.evaluate');
    methods.length = 0;
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Page.navigate', params: { url: 'https://other.test/' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-3')", context)).rejects.toThrow(/unavailable/);
    expect(methods).toEqual([]);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Network.setCookie', params: { name: 'sample', value: '1', url: 'https://other.test/' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-4')", context))
      .rejects.toThrow(/destination site/);
    expect(methods).toEqual([]);
    vm.runInContext("claims.get(7).allowedOrigins.add('https://other.test')", context);
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-5')", context)).resolves.toEqual({});
    expect(methods).toContain('Network.setCookie');
    methods.length = 0;
    currentUrl = 'https://different.test/page';
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-6')", context)).rejects.toThrow(/site changed/);
    expect(methods).toEqual([]);
  });

  it('binds child CDP commands and waiting events to the claimed tab attachment', async () => {
    let onEvent: (source: { tabId: number; sessionId?: string }, method: string,
      data: Record<string, unknown>) => void = () => undefined;
    let childUrl = 'https://example.test/frame';
    const sent: Array<{ target: { tabId: number; sessionId?: string }; method: string }> = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener(listener: typeof onEvent) { onEvent = listener; } },
        sendCommand: async (target: { tabId: number; sessionId?: string }, method: string) => {
          sent.push({ target, method });
          if (method === 'Target.getTargetInfo') return { targetInfo: {
            type: 'iframe', targetId: 'child-1', url: childUrl,
          } };
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/page' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), console: [], requests: [], cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set()})", context);
    onEvent({ tabId: 7 }, 'Target.attachedToTarget', { sessionId: 'session-1',
      targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://example.test/frame' } });
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 1, y: 2 },
      target: { targetId: 'child-1' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'child-1')", context)).resolves.toEqual({});
    expect(sent.find(item => item.method === 'Input.dispatchMouseEvent')?.target)
      .toEqual({ tabId: 7, sessionId: 'session-1' });
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      afterSequence: 0, target: { sessionId: 'session-1' }, timeoutMs: 100 };
    const pending = vm.runInContext("run(7, 'cdpEvents', args, 'events-1')", context) as Promise<unknown>;
    onEvent({ tabId: 7, sessionId: 'session-1' }, 'Runtime.consoleAPICalled', { type: 'log' });
    await expect(pending).resolves.toMatchObject({ events: [{ source: {
      tabId: 7, sessionId: 'session-1', targetId: 'child-1',
    } }] });
    onEvent({ tabId: 7 }, 'Target.targetInfoChanged', {
      targetInfo: { type: 'iframe', targetId: 'child-1', url: 'https://other.test/frame' },
    });
    childUrl = 'https://other.test/frame';
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Page.getLayoutMetrics', params: {}, target: { sessionId: 'session-1' } };
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'child-2')", context))
      .resolves.toEqual({});
    expect(sent.find(item => item.method === 'Page.getLayoutMetrics')?.target)
      .toEqual({ tabId: 7, sessionId: 'session-1' });
    onEvent({ tabId: 7 }, 'Target.detachedFromTarget', { sessionId: 'session-1' });
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'child-3')", context))
      .rejects.toThrow(/not attached/);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      afterSequence: 0, target: { targetId: 'child-1' } };
    await expect(vm.runInContext("run(7, 'cdpEvents', args, 'events-2')", context))
      .resolves.toMatchObject({ events: [{ method: 'Runtime.consoleAPICalled',
        source: { targetId: 'child-1' } }] });
  });

  it('blocks raw CDP writes during protected autofill and vice versa', async () => {
    const methods: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => { methods.push(method); return {}; } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/page' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set(), protectedActivity: 1, cdpWriteDepth: 0})", context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' } };
    await expect(vm.runInContext("run(7, 'cdpWrite', args, 'write-1')", context))
      .rejects.toThrow(/protected browser operation/);
    expect(methods).not.toContain('Runtime.evaluate');
    vm.runInContext('claims.get(7).protectedActivity = 0; claims.get(7).cdpWriteDepth = 1', context);
    await expect(vm.runInContext("fillAutofill(7, 'fillCredential', {origin: 'https://example.test', username: 'u', password: 'p'})", context))
      .rejects.toThrow(/during raw CDP/);
    expect(methods).not.toContain('Runtime.evaluate');
  });

  it('reports a CDP send timeout but retains the activity guard until debugger settles', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
        sendCommand: async (_target: unknown, method: string) => {
          if (method === 'Runtime.evaluate') { entered(); await pending; }
          return {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/page' }) },
      windows: { get: async () => ({ focused: false }) },
    };
    const context = vm.createContext({ chrome, WebSocket: class {}, navigator: { userAgent: 'Chrome' },
      URL, setTimeout, clearTimeout });
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
    vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpOrigin: 'https://example.test', cdpEvents: [], cdpSequence: 1, cdpEpoch: 0, cdpSessions: new Map(), cdpWaiters: new Set(), protectedActivity: 0, cdpWriteDepth: 0})", context);
    (context as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.title = "changed"' }, timeoutMs: 10 };
    const operation = vm.runInContext("run(7, 'cdpWrite', args, 'timeout-1')", context) as Promise<unknown>;
    try {
      await started;
      await expect(operation).rejects.toThrow(/timed out/);
      await expect(vm.runInContext("fillAutofill(7, 'fillCredential', {origin: 'https://example.test', username: 'u', password: 'p'})", context))
        .rejects.toThrow(/during raw CDP/);
    } finally { release(); await new Promise(resolve => setTimeout(resolve, 0)); }
    expect(vm.runInContext('claims.get(7).cdpWriteDepth', context)).toBe(0);
  });

  it('protects filled passwords across MV3 worker restart until a new document commits', async () => {
    const saved: Record<string, unknown> = {};
    const listeners: Array<(source: { tabId: number; sessionId?: string }, method: string,
      data: Record<string, unknown>) => void> = [];
    const sent: string[] = [];
    const chrome = {
      runtime: { onMessage: { addListener() {} } },
      storage: { session: {
        get: async (keys: string[]) => Object.fromEntries(keys.map(key => [key, saved[key]])),
        set: async (value: Record<string, unknown>) => { Object.assign(saved, value); },
      } },
      debugger: { attach: async () => undefined, detach: async () => undefined,
        onDetach: { addListener() {} }, onEvent: { addListener(listener: typeof listeners[number]) {
          listeners.push(listener);
        } },
        sendCommand: async (_target: unknown, method: string) => {
          sent.push(method);
          return method === 'Runtime.evaluate' ? { result: { value: 1 } } : {};
        } },
      tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
        get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/login' }) },
      windows: { get: async () => ({ focused: false }) },
      action: { setBadgeText: async () => undefined, setBadgeBackgroundColor: async () => undefined },
    };
    const create = () => {
      const context = vm.createContext({ chrome, WebSocket: class { static OPEN = 1; },
        navigator: { userAgent: 'Chrome' },
        URL, setTimeout, clearTimeout });
      vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
      vm.runInContext('connect = async () => undefined', context);
      return context;
    };
    const first = create();
    await vm.runInContext('claim(7, "")', first);
    const waiting = vm.runInContext("run(7, 'cdpEvents', {approvedOrigin: 'https://example.test', afterSequence: 0, timeoutMs: 500}, 'events-waiting')", first) as Promise<unknown>;
    const waitingAssertion = expect(waiting).rejects.toThrow(/credential protection|autofill/);
    await new Promise(resolve => setTimeout(resolve, 0));
    await vm.runInContext("fillAutofill(7, 'fillCredential', {origin: 'https://example.test', username: 'u', password: 'fake-password'})", first);
    await waitingAssertion;
    expect(saved.protectedCredentialTabs).toEqual([7]);
    listeners[0]!({ tabId: 7 }, 'Network.requestWillBeSent', {
      request: { url: 'https://example.test/login?password=fake-password' },
    });
    (first as Record<string, unknown>).args = { approvedOrigin: 'https://example.test',
      method: 'Runtime.evaluate', params: { expression: 'document.querySelector("input[type=password]").value' } };
    sent.length = 0;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'cdpEvents', {approvedOrigin: 'https://example.test', afterSequence: 0}, 'events-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'snapshot', {}, 'snapshot-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'click', {target: '7'}, 'click-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'tabState', {}, 'state-1')", first))
      .rejects.toThrow(/credential protection/);
    await expect(vm.runInContext("run(7, 'navigate', {url: 'https://other.test/'}, 'nav-1')", first))
      .rejects.toThrow(/credential protection/);
    expect(sent).not.toContain('Runtime.evaluate');
    const restarted = create();
    await vm.runInContext('claim(7, "")', restarted);
    (restarted as Record<string, unknown>).args = (first as Record<string, unknown>).args;
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-2')", restarted))
      .rejects.toThrow(/credential protection/);
    listeners.at(-1)!({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://example.test/account' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saved.protectedCredentialTabs).toEqual([7]);
    await vm.runInContext("run(7, 'navigate', {url: 'https://example.test/account'}, 'recover')", restarted);
    listeners.at(-1)!({ tabId: 7 }, 'Page.frameNavigated', {
      frame: { id: 'main', url: 'https://example.test/account' },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saved.protectedCredentialTabs).toEqual([]);
    await expect(vm.runInContext("run(7, 'cdpCall', args, 'read-3')", restarted))
      .resolves.toMatchObject({ result: { value: 1 } });
  });
});

it('keeps external browser auth values inside the extension and never returns them to Agent', async () => {
  const listeners: Array<(message: any, sender: any, respond: (value: any) => void) => void> = [];
  const sent: Array<{ method: string; expression?: string }> = [];
  const saved: Record<string, unknown> = {};
  const chrome = {
    runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onMessage: { addListener(listener: typeof listeners[number]) { listeners.push(listener); } } },
    storage: { session: { get: async () => saved, set: async (value: Record<string, unknown>) => Object.assign(saved, value) } },
    debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
      sendCommand: async (_target: unknown, method: string, args: any) => {
        sent.push({ method, expression: args?.expression });
        return method === 'Runtime.evaluate'
          ? { result: { value: args.expression.includes('const controls=') ? [] : true } } : {};
      } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/login' }),
      update: async (_tabId: number, value: { url: string }) => {
        const authId = new URL(value.url).searchParams.get('authId');
        const sender = { id: 'extension-id', tab: { windowId: 9 } };
        let details: any;
        listeners[0]!({ action: 'auth:get', authId }, sender, value => { details = value; });
        expect(details.request.origin).toBe('https://example.test');
        listeners[0]!({ action: 'auth:submit', authId, values: { password: 'fake-secret' } }, sender, () => undefined);
      } },
    windows: { onRemoved: { addListener() {} }, create: async () => ({ id: 9, tabs: [{ id: 90 }] }),
      remove: async () => undefined, get: async () => ({ focused: false }) },
  };
  const context = vm.createContext({ chrome, crypto: { randomUUID: () => '11111111-1111-1111-1111-111111111111' },
    WebSocket: class { static OPEN = 1; }, navigator: { userAgent: 'Chrome' },
    URL, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
  vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpEvents: [], cdpWaiters: new Set(), cdpSessions: new Map(), console: [], requests: [], protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, documentEpoch: 0}); runningCommands.add('auth-1')", context);
  (context as Record<string, unknown>).authInput = { origin: 'https://example.test',
    fields: [{ id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' }] };
  const result = await vm.runInContext("run(7, 'authRequest', authInput, 'auth-1')", context);
  expect(result).toEqual({ status: 'submitted' });
  expect(JSON.stringify(result)).not.toContain('fake-secret');
  expect(sent.filter(item => item.expression?.includes('fake-secret'))).toHaveLength(1);
  expect(saved.protectedCredentialTabs).toEqual([7]);
  await expect(vm.runInContext("run(7, 'snapshot', {}, 'snapshot-2')", context))
    .rejects.toThrow(/credential protection/);
});

it('validates a connected cross-origin child before external auth, including after user approval', async () => {
  const sent: Array<{ target: any; method: string; expression?: string }> = [];
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { session: { get: async () => ({}), set: async () => undefined } },
    debugger: { onDetach: { addListener() {} }, onEvent: { addListener() {} },
      sendCommand: async (target: any, method: string, args: any) => {
        sent.push({ target, method, expression: args?.expression });
        if (method === 'Runtime.evaluate' && args.expression.includes('const found=doc?.querySelectorAll'))
          return { result: { objectId: 'frame-node' } };
        if (method === 'DOM.describeNode') return { node: { nodeName: 'IFRAME', frameId: 'frame-1' } };
        if (method === 'Target.getTargetInfo') return { targetInfo: {
          targetId: 'frame-1', url: 'https://identity.test/login' } };
        if (method === 'Runtime.evaluate' && args.expression.includes('timeOrigin:doc.defaultView.performance.timeOrigin'))
          return { result: { value: { url: 'https://identity.test/login', timeOrigin: 123 } } };
        if (method === 'Runtime.evaluate') return { result: { value:
          args.expression.includes('const controls=') ? [] : true } };
        return {};
      } },
    tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      get: async () => ({ id: 7, active: false, windowId: 1, url: 'https://example.test/login' }) },
    windows: { get: async () => ({ focused: false }) },
  };
  const context = vm.createContext({ chrome, WebSocket: class { static OPEN = 1; },
    navigator: { userAgent: 'Chrome' }, URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context);
  vm.runInContext("claims.set(7, {origin: 'https://example.test', allowedOrigins: new Set(['https://example.test']), cdpEvents: [], cdpWaiters: new Set(), cdpSessions: new Map([['child-1', {targetId: 'frame-1', url: 'https://identity.test/login', revision: 0}]]), console: [], requests: [], protectedActivity: 0, cdpReadDepth: 0, cdpWriteDepth: 0, documentEpoch: 0}); runningCommands.add('auth-1')", context);
  (context as Record<string, unknown>).authInput = { origin: 'https://example.test', frame: 'iframe#signin',
    fields: [{ id: 'password', label: 'Password', type: 'password', required: true,
      selector: 'input[type=password]' }] };
  vm.runInContext("collectAuth = async () => ({values: {password: 'fake-secret'}})", context);
  expect(await vm.runInContext("run(7, 'authRequest', authInput, 'auth-1')", context))
    .toEqual({ status: 'submitted' });
  expect(sent.filter(item => item.expression?.includes('fake-secret')).map(item => item.target.sessionId))
    .toEqual(['child-1']);
  vm.runInContext("claims.get(7).credentialProtected = false; claims.get(7).cdpSessions.get('child-1').revision++; runningCommands.add('auth-2'); collectAuth = async () => { claims.get(7).cdpSessions.get('child-1').revision++; return {values: {password: 'late-secret'}}; }", context);
  sent.length = 0;
  expect(await vm.runInContext("run(7, 'authRequest', authInput, 'auth-2')", context))
    .toEqual({ status: 'page_changed' });
  expect(sent.some(item => item.expression?.includes('late-secret'))).toBe(false);
  vm.runInContext("runningCommands.add('auth-3'); collectAuth = async () => { cancelledCommands.add('auth-3'); return {values: {password: 'cancelled-secret'}}; }", context);
  sent.length = 0;
  expect(await vm.runInContext("run(7, 'authRequest', authInput, 'auth-3')", context))
    .toEqual({ status: 'page_changed' });
  expect(sent.some(item => item.expression?.includes('cancelled-secret'))).toBe(false);
});
