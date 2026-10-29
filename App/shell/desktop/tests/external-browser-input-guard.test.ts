import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../extensions/memmy-browser/background.js");
const source = fs.readFileSync(extension, "utf8");
const ORIGIN = "https://example.test";

type DebuggerCall = { target: { tabId: number; sessionId?: string }; method: string; params: Record<string, any> };
type CommandHook = (call: DebuggerCall) => unknown | Promise<unknown>;

function inputGuardHarness(onCommand?: CommandHook, onCredentialPersist?: () => unknown | Promise<unknown>) {
  const clock = { wall: 1_800_000_000_000, monotonic: 1_000_000 };
  class ClockDate extends Date { static now() { return clock.wall; } }
  const calls: DebuggerCall[] = [];
  let debuggerEvent: (target: { tabId: number; sessionId?: string }, method: string,
    data: Record<string, unknown>) => void = () => undefined;
  const sessionStorage: Record<string, unknown> = {};
  const chrome = {
    runtime: { onMessage: { addListener() {} } },
    storage: { session: {
      get: async () => ({ ...sessionStorage }),
      set: async (value: Record<string, unknown>) => {
        Object.assign(sessionStorage, value);
        await onCredentialPersist?.();
      },
    } },
    tabs: {
      get: async () => ({ id: 7, active: true, windowId: 1, url: `${ORIGIN}/` }),
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} },
      onActivated: { addListener() {} },
    },
    windows: { get: async () => ({ focused: true }), onFocusChanged: { addListener() {} } },
    debugger: {
      attach: async () => undefined, detach: async () => undefined,
      onDetach: { addListener() {} },
      onEvent: { addListener(listener: typeof debuggerEvent) { debuggerEvent = listener; } },
      sendCommand: async (target: DebuggerCall["target"], method: string,
        params: Record<string, any> = {}) => {
        const call = { target, method, params };
        calls.push(call);
        const result = await onCommand?.(call);
        if (result !== undefined) return result;
        if (method === "Page.getFrameTree") return { frameTree: {
          frame: { id: target.sessionId ? "child-frame" : "main-frame" },
        } };
        if (method === "Page.createIsolatedWorld") return {
          executionContextId: target.sessionId ? 22 : 11,
        };
        if (method === "Target.getTargetInfo") return { targetInfo: {
          targetId: "child-target", type: "iframe", url: `${ORIGIN}/frame`,
        } };
        if (method === "Page.addScriptToEvaluateOnNewDocument") return {
          identifier: target.sessionId ? "child-observer-script" : "observer-script",
        };
        if (method === "Accessibility.getFullAXTree") return { nodes: [] };
        if (method === "DOM.resolveNode") return { object: { objectId: "page-object-2" } };
        if (method === "Runtime.evaluate" && params.expression === "document.body") {
          return { result: { objectId: "page-object-1" } };
        }
        if (method === "Runtime.evaluate" && params.expression?.includes("const controls=")) {
          return { result: { value: [] } };
        }
        if (method === "Runtime.evaluate") return { result: { value: true } };
        return {};
      },
    },
  };
  const context = vm.createContext({
    chrome, WebSocket: class { static OPEN = 1; },
    navigator: { userAgent: "Chrome/154", platform: "Win32" },
    Date: ClockDate, performance: { now: () => clock.monotonic,
      timeOrigin: clock.wall - clock.monotonic },
    URL, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context);
  vm.runInContext(`claims.set(7, newClaim(7, ${JSON.stringify(ORIGIN)}))`, context);
  const evaluate = (expression: string): any => vm.runInContext(expression, context);
  const run = (name: string, args: Record<string, unknown> = {}) => {
    (context as any).mockRequest = { name, args };
    return evaluate("run(7, mockRequest.name, mockRequest.args, 'test-command')") as Promise<any>;
  };
  const attach = () => evaluate("ensureAttached(7)") as Promise<void>;
  const token = () => evaluate("claims.get(7).inputObserverToken") as string;
  const emit = (method: string, data: Record<string, unknown>, sessionId?: string) =>
    debuggerEvent({ tabId: 7, ...(sessionId ? { sessionId } : {}) }, method, data);
  const input = (type: string, occurredAt: number, sessionId?: string) => emit(
    "Runtime.bindingCalled", { name: "__memmyUserInput",
      payload: JSON.stringify([token(), type, occurredAt]) }, sessionId);
  const advance = (ms: number) => { clock.wall += ms; clock.monotonic += ms; };
  const pressed = () => calls.filter(call => call.method === "Input.dispatchMouseEvent"
    && call.params.type === "mousePressed");
  return { calls, clock, attach, run, emit, input, advance, pressed, evaluate };
}

describe("external browser real input guard", () => {
  it.each(["false", "exception"])("fails attachment when root observer evaluation returns %s", async outcome => {
    const browser = inputGuardHarness(call => {
      if (call.method === "Runtime.evaluate" && call.params.contextId === 11) {
        return outcome === "false" ? { result: { value: false } }
          : { exceptionDetails: { text: "observer failed" }, result: { value: true } };
      }
    });
    await expect(browser.attach()).rejects.toThrow("INPUT_OBSERVER_UNAVAILABLE");
    await expect(browser.run("click", { x: 10, y: 10 })).rejects.toThrow("INPUT_OBSERVER_UNAVAILABLE");
    expect(browser.pressed()).toHaveLength(0);
  });

  it.each(["disappeared", "attached"])(
    "retries the root frame tree when a child frame %s during observer installation", async change => {
      let browser!: ReturnType<typeof inputGuardHarness>;
      let rootTrees = 0;
      let failedWorld = false;
      browser = inputGuardHarness(call => {
        if (!call.target.sessionId && call.method === "Page.getFrameTree") {
          rootTrees++;
          return { frameTree: { frame: { id: "main-frame" },
            ...(change === "attached" || rootTrees === 1 ? {
              childFrames: [{ frame: { id: "moving-frame" } }],
            } : {}),
          } };
        }
        if (!call.target.sessionId && call.method === "Page.createIsolatedWorld"
          && call.params.frameId === "moving-frame" && !failedWorld) {
          failedWorld = true;
          if (change === "attached") browser.emit("Target.attachedToTarget", {
            sessionId: "child-session", targetInfo: {
              type: "iframe", targetId: "moving-frame", url: `${ORIGIN}/frame`,
            },
          });
          throw new Error("frame moved during observer installation");
        }
      });
      await expect(browser.attach()).resolves.toBeUndefined();
      expect(rootTrees).toBe(2);
      if (change === "attached") await vi.waitFor(() => expect(browser.evaluate(
        "claims.get(7).inputObservers.get('child-session').ready")).toBe(true));
      await expect(browser.run("click", { x: 10, y: 10 }))
        .resolves.toMatchObject({ x: 10, y: 10 });
      expect(browser.pressed()).toHaveLength(1);
    },
  );

  it.each([0, 20])("exempts one delayed Agent event but protects a real pointer event %i ms away", async offset => {
    const browser = inputGuardHarness();
    await browser.attach();
    await expect(browser.run("click", { x: 10, y: 10 })).resolves.toMatchObject({ x: 10, y: 10 });
    const agentAt = Number(browser.pressed()[0]?.params.timestamp) * 1000;
    expect(Number.isFinite(agentAt)).toBe(true);

    browser.advance(80); // The binding notification can arrive after the CDP command resolves.
    browser.input("pointerdown", agentAt);
    await expect(browser.run("resize", { width: 800, height: 600 })).resolves.toMatchObject({ width: 800 });

    browser.input("pointerdown", agentAt + offset); // A separate physical event, not a second Agent event.
    await expect(browser.run("resize", { width: 801, height: 600 }))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    expect(browser.calls.filter(call => call.method === "Emulation.setDeviceMetricsOverride")).toHaveLength(1);
  });

  it("blocks writes while a child observer installs, then allows them after it succeeds", async () => {
    let releaseChild!: () => void;
    const pendingChild = new Promise<void>(resolve => { releaseChild = resolve; });
    const browser = inputGuardHarness(async call => {
      if (call.target.sessionId === "child-session" && call.method === "Page.enable") await pendingChild;
    });
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    const click = browser.run("click", { x: 10, y: 10 });
    let settled = false;
    void click.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(browser.calls).toContainEqual(expect.objectContaining({
      target: { tabId: 7, sessionId: "child-session" }, method: "Page.enable",
    })));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(browser.pressed()).toHaveLength(0);

    releaseChild();
    await vi.waitFor(() => expect(browser.calls).toContainEqual(expect.objectContaining({
      target: { tabId: 7, sessionId: "child-session" }, method: "Runtime.evaluate",
      params: expect.objectContaining({ contextId: 22 }),
    })));
    await expect(click).resolves.toMatchObject({ x: 10, y: 10 });
    expect(browser.pressed()).toHaveLength(1);
  });

  it("keeps writes blocked when a child observer cannot be installed", async () => {
    const browser = inputGuardHarness(async call => {
      if (call.target.sessionId === "child-session" && call.method === "Page.enable") {
        throw new Error("child observer unavailable");
      }
    });
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    const click = browser.run("click", { x: 10, y: 10 });
    await expect(click).rejects.toThrow("INPUT_OBSERVER_UNAVAILABLE");
    expect(browser.pressed()).toHaveLength(0);
  });

  it.each(["succeeds", "fails"])("guards approved auth submission while a child observer %s", async outcome => {
    let releaseChild!: () => void;
    const pendingChild = new Promise<void>((resolve, reject) => {
      releaseChild = outcome === "succeeds" ? resolve : () => reject(new Error("child observer unavailable"));
    });
    const browser = inputGuardHarness(async call => {
      if (call.target.sessionId === "child-session" && call.method === "Page.enable") await pendingChild;
    });
    await browser.attach();
    browser.evaluate(`
      runningCommands.add('test-command');
      globalThis.authAnswer = new Promise(resolve => { globalThis.approveAuth = resolve; });
      collectAuth = () => { globalThis.authShown = true; return globalThis.authAnswer; };
    `);
    const auth = browser.run("authRequest", { origin: ORIGIN,
      fields: [{ id: "email", label: "Email", selector: "#email", type: "email", required: true }],
      submit: { selector: "#submit", action: "click" },
    });
    let settled = false;
    void auth.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(browser.evaluate("globalThis.authShown")).toBe(true));
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    await vi.waitFor(() => expect(browser.calls).toContainEqual(expect.objectContaining({
      target: { tabId: 7, sessionId: "child-session" }, method: "Page.enable",
    })));
    browser.evaluate("globalThis.approveAuth({ values: { email: 'test@example.test' } })");
    await vi.waitFor(() => expect(browser.calls.filter(call => call.method === "Runtime.evaluate"
      && call.params.expression?.includes("const controls="))).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    const submissions = () => browser.calls.filter(call => call.method === "Runtime.evaluate"
      && call.params.expression?.includes("const values=") && call.params.expression?.includes("const submit="));
    expect(submissions()).toHaveLength(0);

    releaseChild();
    if (outcome === "succeeds") {
      await expect(auth).resolves.toMatchObject({ status: "submitted" });
      expect(submissions()).toHaveLength(1);
    } else {
      await expect(auth).rejects.toThrow("INPUT_OBSERVER_UNAVAILABLE");
      expect(submissions()).toHaveLength(0);
    }
  });

  it("does not submit approved auth when real input arrives while credential protection persists", async () => {
    let browser!: ReturnType<typeof inputGuardHarness>;
    browser = inputGuardHarness(undefined, () => {
      browser.input("pointerdown", browser.clock.wall);
    });
    await browser.attach();
    browser.evaluate(`
      runningCommands.add('test-command');
      collectAuth = async () => ({ values: { email: 'test@example.test' } });
    `);
    await expect(browser.run("authRequest", { origin: ORIGIN,
      fields: [{ id: "email", label: "Email", selector: "#email", type: "email", required: true }],
      submit: { selector: "#submit", action: "click" },
    })).rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    expect(browser.evaluate("claims.get(7).credentialProtected")).toBe(true);
    expect(browser.calls.filter(call => call.method === "Runtime.evaluate"
      && call.params.expression?.includes("const values=") && call.params.expression?.includes("const submit=")))
      .toHaveLength(0);
  });

  it("does not resume a cancelled write after the child observer becomes ready", async () => {
    let releaseChild!: () => void;
    const pendingChild = new Promise<void>(resolve => { releaseChild = resolve; });
    const browser = inputGuardHarness(async call => {
      if (call.target.sessionId === "child-session" && call.method === "Page.enable") await pendingChild;
    });
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    const click = browser.run("click", { x: 10, y: 10 });
    await vi.waitFor(() => expect(browser.calls).toContainEqual(expect.objectContaining({
      target: { tabId: 7, sessionId: "child-session" }, method: "Page.enable",
    })));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(browser.pressed()).toHaveLength(0);
    browser.evaluate("cancelledCommands.add('test-command')");
    releaseChild();
    await expect(click).rejects.toThrow("Browser operation cancelled");
    expect(browser.pressed()).toHaveLength(0);
  });

  it("unblocks a root click when a pending child detaches without Page.enable finishing", async () => {
    const neverEnabled = new Promise<void>(() => undefined);
    const browser = inputGuardHarness(call => {
      if (call.target.sessionId === "child-session" && call.method === "Page.enable") return neverEnabled;
    });
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    const click = browser.run("click", { x: 10, y: 10 });
    await vi.waitFor(() => expect(browser.calls).toContainEqual(expect.objectContaining({
      target: { tabId: 7, sessionId: "child-session" }, method: "Page.enable",
    })));
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(browser.pressed()).toHaveLength(0);
    browser.emit("Target.detachedFromTarget", { sessionId: "child-session" });
    await expect(click).resolves.toMatchObject({ x: 10, y: 10 });
    expect(browser.pressed()).toHaveLength(1);
  });

  it("lets root writes resume when a failed child target detaches", async () => {
    const browser = inputGuardHarness(call => {
      if (call.target.sessionId === "child-session" && call.method === "Page.enable") {
        throw new Error("child observer unavailable");
      }
    });
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .rejects.toThrow("INPUT_OBSERVER_UNAVAILABLE");
    browser.emit("Target.detachedFromTarget", { sessionId: "child-session" });
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .resolves.toMatchObject({ width: 800 });
  });

  it("does not reserve a keydown exemption for an ignored modifier-only event", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    await expect(browser.run("pressKey", { key: "Shift+a" })).resolves.toMatchObject({ ok: true });
    const down = browser.calls.filter(call => call.method === "Input.dispatchKeyEvent"
      && call.params.type === "keyDown");
    expect(down.map(call => call.params.key)).toEqual(["Shift", "a"]);
    const agentAt = Number(down[1].params.timestamp) * 1000;
    browser.advance(80);
    browser.input("keydown", agentAt);
    await expect(browser.run("resize", { width: 800, height: 600 })).resolves.toMatchObject({ width: 800 });
    browser.input("keydown", agentAt);
    await expect(browser.run("resize", { width: 801, height: 600 }))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
  });

  it("retains recent real input across debugger detach and reattach until it expires", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    browser.input("keydown", browser.clock.wall);
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");

    browser.evaluate("markDebuggerDetached(claims.get(7))");
    await browser.attach();
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    browser.advance(2_001);
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .resolves.toMatchObject({ width: 800 });
  });

  it("keeps raw CDP away from the observer while allowing ordinary page writes", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    const denied = [
      ["Runtime.removeBinding", { name: "__memmyUserInput" }],
      ["Runtime.disable", {}],
      ["Page.removeScriptToEvaluateOnNewDocument", { identifier: "observer-script" }],
      ["Runtime.evaluate", { expression: "globalThis.__memmyUserInput('forged')", contextId: 11 }],
      ["Page.createIsolatedWorld", { frameId: "main-frame", worldName: "memmy-user-input" }],
    ] as const;
    for (const [method, params] of denied) {
      const before = browser.calls.length;
      await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN, method, params })).rejects.toThrow();
      expect(browser.calls.slice(before).some(call => call.method === method)).toBe(false);
    }
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.evaluate", params: { expression: "document.title = 'ok'" } }))
      .resolves.toMatchObject({ result: { value: true } });
    expect(browser.calls.some(call => call.method === "Runtime.evaluate"
      && call.params.expression === "document.title = 'ok'")).toBe(true);

    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.evaluate", params: { expression: "document.body" } }))
      .resolves.toMatchObject({ result: { objectId: "page-object-1" } });
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.callFunctionOn", params: {
        objectId: "page-object-1", functionDeclaration: "function(){ this.dataset.test = 'ok' }",
      } })).resolves.toEqual({});
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.callFunctionOn", params: {
        objectId: "page-object-1", functionDeclaration: "function(value){ this.dataset.id = value.objectId }",
        arguments: [{ value: { objectId: "business-record-7" } }],
      } })).resolves.toEqual({});
    for (const params of [
      { objectId: "unknown-object", functionDeclaration: "function(){ this.remove() }" },
      { objectId: "page-object-1", executionContextId: 11,
        functionDeclaration: "function(){ this.remove() }" },
    ]) {
      const before = browser.calls.length;
      await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
        method: "Runtime.callFunctionOn", params })).rejects.toThrow();
      expect(browser.calls.slice(before).some(call => call.method === "Runtime.callFunctionOn")).toBe(false);
    }

    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "DOM.resolveNode", params: { backendNodeId: 123 } }))
      .resolves.toMatchObject({ object: { objectId: "page-object-2" } });
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.callFunctionOn", params: {
        objectId: "page-object-2", functionDeclaration: "function(){ this.dataset.test = 'ok' }",
      } })).resolves.toEqual({});

    browser.emit("Runtime.executionContextsCleared", {});
    const before = browser.calls.length;
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.callFunctionOn", params: {
        objectId: "page-object-2", functionDeclaration: "function(){ this.remove() }",
      } })).rejects.toThrow();
    expect(browser.calls.slice(before).some(call => call.method === "Runtime.callFunctionOn")).toBe(false);
  });

  it("does not let a child session object ID be used in the root session", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    await vi.waitFor(() => expect(browser.evaluate(
      "claims.get(7).inputObservers.get('child-session').ready")).toBe(true));
    const approvedTarget = await browser.run("cdpTarget", {
      approvedOrigin: ORIGIN, target: { sessionId: "child-session" },
    });
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN, approvedTarget,
      target: { sessionId: "child-session" }, method: "Runtime.evaluate",
      params: { expression: "document.body" } }))
      .resolves.toMatchObject({ result: { objectId: "page-object-1" } });
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN, approvedTarget,
      target: { sessionId: "child-session" }, method: "Runtime.callFunctionOn",
      params: { objectId: "page-object-1", functionDeclaration: "function(){ return this.tagName }" } }))
      .resolves.toEqual({});
    const before = browser.calls.length;
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.callFunctionOn",
      params: { objectId: "page-object-1", functionDeclaration: "function(){ this.remove() }" } }))
      .rejects.toThrow();
    expect(browser.calls.slice(before).some(call => call.method === "Runtime.callFunctionOn")).toBe(false);
  });

  it("allows known page iframe contexts while keeping isolated and expired contexts inaccessible", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    for (const [id, name, uniqueId, isDefault] of [
      [11, "memmy-user-input", "observer-world", false],
      [31, "", "page-iframe", true],
      [32, "other-extension", "other-world", false],
    ] as const) browser.emit("Runtime.executionContextCreated", { context: {
      id, name, uniqueId, auxData: { isDefault, frameId: "same-process-frame" },
    } });
    const write = (method: string, params: Record<string, unknown>) => browser.run("cdpWrite", {
      approvedOrigin: ORIGIN, method, params,
    });
    await expect(write("Runtime.evaluate", { expression: "document.body", contextId: 31 }))
      .resolves.toMatchObject({ result: { objectId: "page-object-1" } });
    await expect(write("Runtime.evaluate", { expression: "document.title", uniqueContextId: "page-iframe" }))
      .resolves.toMatchObject({ result: { value: true } });
    await expect(write("Runtime.callFunctionOn", { executionContextId: 31,
      functionDeclaration: "function(){ document.title = 'ok' }" })).resolves.toEqual({});
    await expect(write("DOM.resolveNode", { backendNodeId: 123, executionContextId: 31 }))
      .resolves.toMatchObject({ object: { objectId: "page-object-2" } });
    for (const contextId of [11, 32, 99]) {
      const before = browser.calls.length;
      await expect(write("Runtime.evaluate", { expression: "globalThis", contextId }))
        .rejects.toThrow("CDP observer context is unavailable");
      expect(browser.calls.slice(before).some(call => call.method === "Runtime.evaluate")).toBe(false);
    }
    browser.emit("Runtime.executionContextDestroyed", { executionContextId: 31,
      executionContextUniqueId: "page-iframe" });
    await expect(write("Runtime.evaluate", { expression: "document.title", contextId: 31 }))
      .rejects.toThrow("CDP observer context is unavailable");
    await expect(write("Runtime.evaluate", { expression: "document.title", uniqueContextId: "page-iframe" }))
      .rejects.toThrow("CDP observer context is unavailable");
  });

  it("keeps observing a live child when the raw CDP origin registry is reset", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    browser.emit("Target.attachedToTarget", { sessionId: "child-session",
      targetInfo: { type: "iframe", targetId: "child-target", url: `${ORIGIN}/frame` } });
    await vi.waitFor(() => expect(browser.evaluate(
      "claims.get(7).inputObservers.get('child-session').ready")).toBe(true));
    browser.evaluate("resetCdpOrigin(claims.get(7), 'https://next.test')");
    browser.input("keydown", browser.clock.wall, "child-session");
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
    browser.emit("Target.detachedFromTarget", { sessionId: "child-session" });
    browser.advance(2_001);
    browser.input("keydown", browser.clock.wall, "child-session");
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .resolves.toMatchObject({ width: 800 });
  });

  it("does not turn a page returnByValue objectId field into a callable CDP handle", async () => {
    const browser = inputGuardHarness(call => {
      if (call.method === "Runtime.evaluate" && call.params.expression === "({ objectId: 'forged' })") {
        return { result: { value: { objectId: "forged" } } };
      }
    });
    await browser.attach();
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.evaluate", params: { expression: "({ objectId: 'forged' })",
        returnByValue: true } })).resolves.toMatchObject({ result: { value: { objectId: "forged" } } });
    const before = browser.calls.length;
    await expect(browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Runtime.callFunctionOn", params: {
        objectId: "forged", functionDeclaration: "function(){ this.remove() }",
      } })).rejects.toThrow("CDP object is unavailable");
    expect(browser.calls.slice(before).some(call => call.method === "Runtime.callFunctionOn")).toBe(false);
  });

  it("does not accept a raw CDP input timestamp as an Agent exemption", async () => {
    const browser = inputGuardHarness();
    await browser.attach();
    const spoofedAt = browser.clock.wall - 500;
    await browser.run("cdpWrite", { approvedOrigin: ORIGIN,
      method: "Input.dispatchMouseEvent", params: {
        type: "mousePressed", x: 10, y: 10, button: "left", timestamp: spoofedAt / 1000,
      } });
    expect(browser.pressed()).toHaveLength(1);
    expect(browser.pressed()[0].params.timestamp).toBe(browser.clock.wall / 1000);
    browser.input("pointerdown", spoofedAt);
    await expect(browser.run("resize", { width: 800, height: 600 }))
      .rejects.toThrow("USER_ACTIVE_ON_TARGET_TAB");
  });
});
