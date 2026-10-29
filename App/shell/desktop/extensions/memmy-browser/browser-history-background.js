/* global chrome */
"use strict";

(() => {
  const TTL_MS = 1_500, REQUEST_TIMEOUT_MS = 1_000, MAX_PAYLOAD_BYTES = 24_000, MAX_ANCESTORS = 32;
  const safeId = value => typeof value === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
  const webUrl = value => {
    if (typeof value !== "string" || value.length > 4096) return false;
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
    catch { return false; }
  };

  /** Dependencies are supplied by the extension worker after its authenticated bridge handshake. */
  globalThis.installMemmyBrowserHistoryBackground = dependencies => {
    const api = dependencies.chrome ?? chrome;
    let epoch = 0, sequence = 0, closed = false, wakeTimer = null;
    let intent = { enabled: false, generation: null, expiresAt: 0 };
    const leases = new Map(), pending = new Map(), tabEpochs = new Map(), tabOrigins = new Map();
    const originOf = value => { try { return new URL(value).origin; } catch { return null; } };
    // location.ancestorOrigins lists parent to top. Memmy checks each one against
    // website exclusions, so an opaque or non-web ancestor gets no lease.
    const ancestry = (value, frameId, topUrl) => Array.isArray(value) && value.length <= MAX_ANCESTORS
      && value.every(entry => webUrl(entry) && originOf(entry) === entry)
      && (frameId === 0 ? value.length === 0 : value.at(-1) === originOf(topUrl)) ? [...value] : null;
    const connected = () => !closed && dependencies.isConnected() === true;
    const currentIntent = () => connected() && intent.enabled === true && safeId(intent.generation) && intent.expiresAt > Date.now();
    const keyOf = context => `${context.tabId}:${context.frameId}:${context.documentId}`;
    const uuid = () => globalThis.crypto?.randomUUID?.() ?? `history-${Date.now()}-${++sequence}`;
    const captureEpoch = tabId => `${epoch}:${tabEpochs.get(tabId) ?? 0}`;
    const wakeActive = () => {
      if (!currentIntent() || wakeTimer !== null) return;
      // Metadata only: wake the focused tab's already-installed isolated scripts.
      // Background tabs retain the slower disabled polling cadence.
      wakeTimer = setTimeout(() => {
        wakeTimer = null;
        if (!currentIntent()) return;
        void (async () => {
          const focused = await api.windows.getLastFocused();
          if (!currentIntent() || focused?.focused !== true || focused.incognito !== false || focused.type !== "normal") return;
          const tabs = await api.tabs.query({ active: true, windowId: focused.id });
          if (!currentIntent() || tabs.length !== 1 || tabs[0].incognito !== false) return;
          try { await api.tabs.sendMessage(tabs[0].id, { type: "memmy_history_refresh" }); }
          catch (error) {
            if (!/Receiving end does not exist|Could not establish connection/i.test(String(error?.message || error))
              || !api.scripting?.executeScript) return;
            // An extension upgrade does not install static scripts into pages
            // already open. Add the same dormant scripts only after rechecking
            // current browser metadata; the scripts still require a DOM lease.
            const initialEpoch = captureEpoch(tabs[0].id), tab = await api.tabs.get(tabs[0].id);
            const [freshWindow, lastFocused] = await Promise.all([api.windows.get(tab.windowId), api.windows.getLastFocused()]);
            if (!currentIntent() || captureEpoch(tab.id) !== initialEpoch || tab.id !== tabs[0].id || tab.url !== tabs[0].url
              || tab.active !== true || tab.incognito !== false || tab.pendingUrl || tab.status !== "complete" || !webUrl(tab.url)
              || tab.windowId !== focused.id || freshWindow.focused !== true || freshWindow.incognito !== false
              || freshWindow.type !== "normal" || lastFocused.id !== tab.windowId || lastFocused.focused !== true
              || lastFocused.incognito !== false || lastFocused.type !== "normal" || await protectedPage(tab.id)) return;
            if (!currentIntent() || captureEpoch(tab.id) !== initialEpoch) return;
            await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: true },
              world: "ISOLATED", files: ["history-sensor.js", "history-content.js"] });
          }
        })().catch(() => undefined);
      }, 25);
    };
    const revoke = tabId => {
      // Preserve navigation races for this tab without invalidating another
      // focused page just because a background tab changed.
      if (tabId === undefined) { epoch++; tabEpochs.clear(); }
      else tabEpochs.set(tabId, (tabEpochs.get(tabId) ?? 0) + 1);
      for (const [key, lease] of leases) {
        if (tabId !== undefined && lease.tabId !== tabId) continue;
        leases.delete(key);
        void api.tabs.sendMessage(lease.tabId, { type: "memmy_history_revoke" },
          { frameId: lease.frameId, documentId: lease.documentId }).catch(() => undefined);
      }
    };
    const protectedPage = async tabId => {
      try { return await dependencies.isProtected(tabId) !== false; } catch { return true; }
    };
    const identity = sender => {
      if (sender?.id !== api.runtime.id || !Number.isSafeInteger(sender.tab?.id) || sender.tab.id < 0
        || !Number.isSafeInteger(sender.frameId) || sender.frameId < 0 || !safeId(sender.documentId)
        || sender.documentLifecycle !== "active" || !webUrl(sender.url)) return null;
      return { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, frameUrl: sender.url };
    };
    const contextFor = async sender => {
      const origin = identity(sender), initialEpoch = origin ? captureEpoch(origin.tabId) : null;
      if (!origin || !currentIntent()) return null;
      try {
        const tab = await api.tabs.get(origin.tabId);
        if (!tab || tab.id !== origin.tabId || tab.active !== true || tab.incognito !== false
          || !Number.isSafeInteger(tab.windowId) || tab.pendingUrl || tab.status !== "complete" || !webUrl(tab.url)
          || await protectedPage(tab.id)) return null;
        const [window, focused] = await Promise.all([api.windows.get(tab.windowId), api.windows.getLastFocused()]);
        if (window?.id !== tab.windowId || focused?.id !== tab.windowId || window.focused !== true
          || focused.focused !== true || window.incognito !== false || focused.incognito !== false
          || window.type !== "normal" || focused.type !== "normal") return null;
        const active = await api.tabs.query({ active: true, windowId: tab.windowId });
        if (active.length !== 1 || active[0].id !== tab.id) return null;
        // A reply targeted by Chrome's own documentId proves this frame document
        // still exists. A removed/navigated frame cannot reuse its old lease.
        const probe = await api.tabs.sendMessage(tab.id, { type: "memmy_history_probe" },
          { frameId: origin.frameId, documentId: origin.documentId });
        const [freshTab, freshWindow] = await Promise.all([api.tabs.get(tab.id), api.windows.get(tab.windowId)]);
        if (initialEpoch !== captureEpoch(tab.id) || !currentIntent() || probe?.active !== true || freshTab.url !== tab.url
          || freshTab.windowId !== tab.windowId || freshTab.active !== true || freshTab.incognito !== false
          || freshTab.pendingUrl || freshTab.status !== "complete" || freshWindow.focused !== true
          || freshWindow.incognito !== false || freshWindow.type !== "normal" || await protectedPage(tab.id)) return null;
        if (origin.frameId === 0 && origin.frameUrl !== tab.url) return null;
        return { ...origin, browser: dependencies.browserName(), windowId: tab.windowId,
          topUrl: tab.url, privateBrowsing: false, protected: false, epoch: initialEpoch };
      } catch { return null; }
    };
    const requestAuthorization = context => {
      if (dependencies.authorize) return dependencies.authorize(context);
      const id = uuid();
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, REQUEST_TIMEOUT_MS);
        pending.set(id, { timer, resolve });
        try { dependencies.send({ type: "browser_history_config_request", id, browser: context.browser,
          tabId: context.tabId, windowId: context.windowId, frameId: context.frameId,
          topUrl: context.topUrl, frameUrl: context.frameUrl, ancestorOrigins: context.ancestorOrigins,
          documentId: context.documentId, privateBrowsing: false, protected: false }); }
        catch { clearTimeout(timer); pending.delete(id); resolve(null); }
      });
    };
    const configure = async (sender, ancestorOrigins) => {
      // While History is off or Memmy is away, and in background tabs, frames
      // wait to be woken instead of rechecking.
      if (!currentIntent()) return { enabled: false, idle: true };
      const context = await contextFor(sender);
      const disabled = { enabled: false };
      if (!context) return { enabled: false, idle: sender?.tab?.active !== true };
      context.ancestorOrigins = ancestry(ancestorOrigins, context.frameId, context.topUrl);
      // A document's ancestry does not change, so rechecking would not help.
      if (!context.ancestorOrigins) return { enabled: false, idle: true };
      const authorization = await requestAuthorization(context);
      const fresh = await contextFor(sender);
      if (!fresh || fresh.epoch !== context.epoch || fresh.topUrl !== context.topUrl || fresh.frameUrl !== context.frameUrl
        || authorization?.enabled !== true || authorization.generation !== intent.generation
        || !Number.isFinite(authorization.expiresAt) || authorization.expiresAt <= Date.now()
        || typeof authorization.captureText !== "boolean") return disabled;
      const previous = leases.get(keyOf(fresh));
      const reusable = previous && previous.epoch === fresh.epoch && previous.topUrl === fresh.topUrl
        && previous.frameUrl === fresh.frameUrl && previous.generation === authorization.generation
        && previous.captureText === authorization.captureText;
      const lease = { ...fresh, ancestorOrigins: context.ancestorOrigins, leaseId: reusable ? previous.leaseId : uuid(),
        generation: authorization.generation, expiresAt: Math.min(authorization.expiresAt, intent.expiresAt, Date.now() + TTL_MS),
        captureText: authorization.captureText };
      if (reusable) Object.assign(previous, lease);
      else {
        for (const [key, existing] of leases) if (existing.expiresAt <= Date.now()) leases.delete(key);
        if (leases.size >= 128) return disabled;
        leases.set(keyOf(fresh), lease);
      }
      tabOrigins.set(fresh.tabId, originOf(fresh.topUrl));
      return { enabled: true, generation: lease.generation, documentId: fresh.documentId,
        leaseId: lease.leaseId, expiresAt: lease.expiresAt, captureText: lease.captureText };
    };
    const event = async (message, sender) => {
      const origin = identity(sender), payload = message.payload;
      const lease = origin ? leases.get(keyOf(origin)) : null;
      if (!lease || message.leaseId !== lease.leaseId || lease.expiresAt <= Date.now()
        || !currentIntent() || lease.generation !== intent.generation || !payload || typeof payload !== "object"
        || Array.isArray(payload) || payload.generation !== lease.generation || payload.documentId !== lease.documentId
        || typeof payload.observedAt !== "number" || !Number.isFinite(payload.observedAt)
        || payload.observedAt < Date.now() - TTL_MS || payload.observedAt > Date.now() + 1_000) return { accepted: false };
      // Bound an event before browser API checks; never queue/persist page observations.
      let encoded;
      try { encoded = JSON.stringify(payload); } catch { return { accepted: false }; }
      if (encoded.length > MAX_PAYLOAD_BYTES) return { accepted: false };
      const context = await contextFor(sender);
      // The lease is bound to one document by its Chrome document ID; an in-page
      // route change within that document keeps its origin and its lease.
      if (!context || context.epoch !== lease.epoch || originOf(context.topUrl) !== originOf(lease.topUrl)
        || originOf(context.frameUrl) !== originOf(lease.frameUrl)
        || leases.get(keyOf(context)) !== lease || lease.generation !== intent.generation || lease.expiresAt <= Date.now()) return { accepted: false };
      // Actor provenance comes only from worker-owned input dispatch evidence.
      const evidence = dependencies.activeCommand?.(context.tabId, payload.observedAt);
      const actorEvidence = evidence && safeId(evidence.commandId) ? { kind: "memmy_command", commandId: evidence.commandId,
        ...(safeId(evidence.taskId) ? { taskId: evidence.taskId } : {}) } : undefined;
      dependencies.send({ type: "browser_history", browser: context.browser, tabId: context.tabId,
        windowId: context.windowId, frameId: context.frameId, documentId: context.documentId,
        topUrl: context.topUrl, frameUrl: context.frameUrl, ancestorOrigins: lease.ancestorOrigins,
        privateBrowsing: false, protected: false, generation: lease.generation,
        actor: actorEvidence ? "agent" : "unknown", engine: "content_script",
        ...(actorEvidence ? { actorEvidence } : {}), payload });
      return { accepted: true };
    };
    const onMessage = (message, sender, respond) => {
      if (message?.type !== "memmy_history_config" && message?.type !== "memmy_history_event") return;
      void (message.type === "memmy_history_config" ? configure(sender, message.ancestorOrigins) : event(message, sender))
        .then(respond, () => respond(message.type === "memmy_history_config" ? { enabled: false } : { accepted: false }));
      return true;
    };
    api.runtime.onMessage.addListener(onMessage);
    api.tabs.onActivated.addListener(() => { revoke(); wakeActive(); });
    api.tabs.onUpdated.addListener((tabId, changes, tab) => {
      if (changes.url || changes.status === "loading") {
        // A reload or a different site starts over. A same-site route change
        // (pushState, a search box synced to the URL) keeps pending page events.
        const origin = originOf(changes.url ?? tab?.url ?? "");
        if (!origin || origin !== tabOrigins.get(tabId) || (changes.status === "loading" && !changes.url)) revoke(tabId);
        if (origin) tabOrigins.set(tabId, origin); else tabOrigins.delete(tabId);
      }
      if (changes.status === "complete") wakeActive();
    });
    api.tabs.onRemoved.addListener(tabId => { revoke(tabId); tabOrigins.delete(tabId); });
    api.windows.onFocusChanged.addListener(() => { revoke(); wakeActive(); });
    return {
      receive(message) {
        if (message?.type === "browser_history_config") {
          const request = pending.get(message.id);
          if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
          return true;
        }
        if (message?.type !== "browser_history_intent") return false;
        const value = message;
        const wasEnabled = currentIntent(), oldGeneration = intent.generation;
        if (!connected() || value.enabled !== true || !safeId(value.generation) || !Number.isFinite(value.expiresAt)
          || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + TTL_MS) {
          intent = { enabled: false, generation: null, expiresAt: 0 }; revoke();
        } else {
          if (value.generation !== intent.generation) revoke();
          intent = { enabled: true, generation: value.generation, expiresAt: value.expiresAt };
          if (!wasEnabled || value.generation !== oldGeneration) wakeActive();
        }
        return true;
      },
      revoke,
      disconnected() {
        clearTimeout(wakeTimer); wakeTimer = null;
        intent = { enabled: false, generation: null, expiresAt: 0 }; revoke();
        for (const request of pending.values()) { clearTimeout(request.timer); request.resolve(null); }
        pending.clear();
      },
      close() { closed = true; this.disconnected(); api.runtime.onMessage.removeListener?.(onMessage); },
    };
  };
})();
