/* global chrome */
"use strict";

/** Scoped observation lease; no Computer Use command is granted by a Teach session. */
function createMemmyTeachingRecorder(services) {
  const sessions = new Map(), tabOwners = new Map(), stopped = new Map();
  const WINDOW_LEASE_MS = 15000, PAGE_LEASE_MS = 7000, HANDOFF_MS = 2000;
  const emit = (session, value) => services.send({ type: "teaching_event", sessionId: session.id, sequence: ++session.sequence, ...value });
  const error = (session, code, terminal = false) => { if (!session.issues.has(code)) { session.issues.add(code); emit(session, { kind: "fault", code, terminal }); } };
  const proof = (session, doc, status, extra = {}) => emit(session, { kind: "proof", status,
    ...(doc ? { tabId: doc.tabId, documentId: doc.id, contextId: doc.contextId, epoch: doc.epoch, documentSequence: doc.sequence } : {}), ...extra });
  const detached = failure => /not attached|no tab with|target closed|target_closed|debugger.*detach/i.test(String(failure?.message || failure));
  const missingContext = failure => /cannot find context|execution context.*(destroyed|not found)|cannot find.*unique.*context/i.test(String(failure?.message || failure));
  function confirmNavigation(session, id) {
    const candidate = session.navigationDocuments.get(id);
    if (!candidate) return;
    candidate.ready = true; clearTimeout(candidate.timer);
    for (const resolve of candidate.waiters) resolve();
    candidate.waiters.clear();
  }
  function checkNavigation(session, candidate) {
    if (candidate.ready || candidate.reported || session.closed || (session.through !== null && candidate.at > session.through)) return;
    candidate.reported = true;
    proof(session, null, "collector_not_ready", { tabId: candidate.tabId, documentId: candidate.id });
    error(session, "browser_capture_collector_not_ready");
  }
  function trackNavigation(session, tabId, id, url) {
    if (session.closed || session.stopping || !session.active || !safeUrl(url) || !allowed(session, url) || typeof id !== "string") return;
    if (session.navigationDocuments.has(id)) return;
    const info = session.tabs.get(tabId);
    const candidate = {id, tabId, at: Date.now(), ready: session.emptyDocuments.get(id) === tabId || (!!info && [...info.documents.values()].some(doc => doc.browserDocumentId === id && doc.collectorReady)), waiters: new Set(), timer: null};
    session.navigationDocuments.set(id, candidate);
    if (!candidate.ready) candidate.timer = setTimeout(() => checkNavigation(session, candidate), HANDOFF_MS);
    for (const [key, old] of session.navigationDocuments) if (old.ready && Date.now() - old.at > 10000) { session.navigationDocuments.delete(key); session.emptyDocuments.delete(key); }
    if (session.navigationDocuments.size > 4096) { error(session, "browser_capture_document_limit", true); void end(session); }
  }
  function serial(session, fn) {
    const next = session.pending.then(fn);
    session.pending = next.catch(() => { if (!session.closed) error(session, "browser_capture_observation_failed"); });
    return next;
  }
  const validId = value => Number.isSafeInteger(value) && value >= 0;
  const safeUrl = value => { try { const url = new URL(value); if (!/^https?:$/.test(url.protocol)) return ""; url.search = ""; url.hash = ""; url.username = ""; url.password = ""; return url.href; } catch { return ""; } };
  function allowed(session, url) {
    const site = safeUrl(url);
    if (!site) return false;
    const observation = session.settings?.observation;
    if (!observation) return false;
    const host = new URL(site).hostname.toLowerCase().replace(/^www\./, "");
    const appRules = observation.rules.filter(rule => rule.scope === "app" && rule.bundleID?.toLowerCase() === session.bundleId.toLowerCase());
    const urlRules = observation.rules.filter(rule => rule.scope === "url" && typeof rule.urlDomain === "string" && (() => {
      const domain = rule.urlDomain.toLowerCase().replace(/^www\./, ""); return host === domain || host.endsWith(`.${domain}`);
    })());
    return [ [appRules, observation.defaultApplicationBehavior], [urlRules, observation.defaultURLBehavior] ].every(([rules, fallback]) =>
      !rules.some(rule => rule.behavior === "do_not_observe") && (rules.some(rule => rule.behavior === "observe") || fallback === "observe"));
  }
  function privateOrProtected(tab) {
    return tab.incognito !== false || services.protected(tab.id);
  }
  async function eligible(session, tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (session.closed || !session.windows.has(tab.windowId) || privateOrProtected(tab)) return null;
    const window = await chrome.windows.get(tab.windowId);
    return window.incognito === false ? tab : null;
  }
  function pageCommand(doc, action, input = {}) {
    return new Promise((resolve, reject) => {
      const id = `${doc.id}:${++doc.requestSequence}`;
      const timer = setTimeout(() => { doc.requests.delete(id); reject(Error("browser_capture_page_reply_timeout")); }, 2000);
      doc.requests.set(id, { resolve: value => { clearTimeout(timer); doc.requests.delete(id); resolve(value); },
        reject: error => { clearTimeout(timer); doc.requests.delete(id); reject(error); } });
      try { doc.port.postMessage({ type: "command", sessionId: doc.session.id, id, action, ...input }); }
      catch { doc.requests.get(id)?.reject(Error("browser_capture_page_port_disconnected")); }
    });
  }
  function settleDocument(doc) {
    if (doc.finalSequence !== null && doc.finalSequence === doc.sequence && !doc.buffer.size) {
      if (!doc.closed) {
        doc.closed = true; clearTimeout(doc.retireTimer);
        emit(doc.session, { kind: "document-closed", tabId: doc.tabId, documentId: doc.id,
          documentSequence: doc.sequence, confirmed: !doc.gap });
        if (!doc.gap) confirmNavigation(doc.session, doc.browserDocumentId);
      }
      for (const resolve of [...doc.waiters]) resolve(!doc.gap);
    }
  }
  function retire(session, doc) {
    if (doc.retired) return;
    doc.retired = true; doc.retiredAt = Date.now();
    // An opaque blank document never enables HTTP input collection, so it has no user-event tail.
    if (doc.url === "about:blank" && !doc.sequence) { doc.finalSequence = 0; settleDocument(doc); }
    if (!doc.closed) doc.retireTimer = setTimeout(() => {
      if (session.closed || doc.closed) return;
      doc.expired = true; doc.gap = true;
      proof(session, doc, "tail_unconfirmed"); error(session, "browser_capture_document_tail_unconfirmed");
      for (const resolve of [...doc.waiters]) resolve(false);
    }, HANDOFF_MS);
  }
  async function registerPage(session, info, sender, port, state) {
    if (session.closed || session.stopping || info.revoked || !session.active) return;
    const tab = await eligible(session, info.tabId).catch(() => null);
    const frame = typeof chrome.webNavigation.getFrame === "function"
      ? await chrome.webNavigation.getFrame({tabId: info.tabId, documentId: sender.documentId}).catch(() => null) : null;
    const url = safeUrl(frame?.url || sender.url);
    if (!tab || !url || !allowed(session, url)) return;
    if (!state || typeof state.nonce !== "string" || !/^[a-f0-9]{32}$/.test(state.nonce) || !validId(state.epoch)) throw Error("browser_capture_invalid_page_identity");
    if (state.missed) error(session, "browser_capture_collector_not_ready");
    const key = `${state.nonce}:${state.epoch}`, id = `${sender.documentId}:${key}`;
    let doc = info.documents.get(id);
    if (!doc) {
      if (info.documents.size >= 256) throw Error("browser_capture_document_limit");
      doc = { session, tabId: info.tabId, id, nonce: state.nonce, epoch: state.epoch,
        contextId: ++info.contextSequence, port, browserDocumentId: sender.documentId,
        requestSequence: 0, requests: new Map(), url, sequence: 0, buffer: new Map(), finalSequence: null,
        closed: false, retired: false, expired: false, gap: false, waiters: new Set(), retireTimer: null };
      if (info.current && info.current !== doc) retire(session, info.current);
      info.documents.set(id, doc); info.byNonce.set(key, doc); info.current = doc;
      emit(session, { kind: "document", tabId: info.tabId, windowId: info.windowId, documentId: id,
        url, incognito: false, epoch: doc.epoch });
      proof(session, doc, "installed");
      emit(session, { kind: "event", eventType: "navigation", observedAt: Date.now(), details: {},
        tabId: info.tabId, windowId: info.windowId, documentId: id, url });
    }
    if (state.closed || state.revoked || session.stopping || session.closed || info.revoked
      || (frame && frame.documentLifecycle !== "active")) return;
    let activated;
    try { activated = await pageCommand(doc, "activate", { url, epoch: doc.epoch }); }
    catch (failure) {
      if (/page_port_disconnected/.test(String(failure)) || doc.retired || doc.closed) {
        proof(session, doc, "activation_interrupted"); retire(session, doc); return;
      }
      throw failure;
    }
    if (activated.revoked || activated.closed) return;
    doc.collectorReady = true;
    confirmNavigation(session, sender.documentId);
    // Early interactions are a coverage gap, not a missing tail in this document's issued sequence.
    if (activated.missed) error(session, "browser_capture_collector_not_ready");
  }
  async function install(session, tabId, initial = false) {
    if (session.closed || session.stopping || session.tabs.has(tabId)) return;
    const tab = await eligible(session, tabId);
    if (!tab || (!initial && !allowed(session, tab.url))) return;
    if (tabOwners.has(tabId)) throw Error("browser_capture_tab_busy");
    const info = { tabId, windowId: tab.windowId, documents: new Map(), byNonce: new Map(), fences: new Map(),
      ports: new Map(), current: null, contextSequence: 0, revoked: false };
    session.tabs.set(tabId, info); tabOwners.set(tabId, session);
    try {
      // Keep the debugger's user-revocation signal; page content and tail proofs use native Ports.
      await services.attach(tabId);
      if (session.closed || info.revoked) throw Error("browser_capture_binding_revoked");
      await services.command(tabId, "Page.enable");
      const tree = await services.command(tabId, "Page.getFrameTree"); info.mainFrameId = tree.frameTree?.frame?.id;
      if (initial && tab.url === "about:blank") await services.command(tabId, "Runtime.evaluate", {
        expression: `(()=>{const b=document.createElement('div');b.id='memmy-teaching-recording';b.textContent='Memmy 已准备教学窗口 · 请打开普通网页';b.style.cssText='position:fixed;top:8px;right:8px;background:#9f1c28;color:white;padding:8px 12px;font:13px system-ui';document.documentElement.appendChild(b)})()` });
      void chrome.tabs.sendMessage?.(tabId, { type: "memmy.teaching.connect" }).catch(() => undefined);
    } catch (failure) { await remove(session, tabId, info); throw failure; }
  }
  async function connectPage(port) {
    const sender = port.sender;
    if (port.name !== "memmy-teaching/v2" || sender?.id !== chrome.runtime.id || sender.frameId !== 0
      || typeof sender.documentId !== "string" || !/^[a-f0-9-]{16,64}$/i.test(sender.documentId)
      || !validId(sender.tab?.id) || privateOrProtected(sender.tab) || !safeUrl(sender.url)) { port.disconnect(); return; }
    const session = [...sessions.values()].find(s => s.active && !s.closed && !s.stopping && s.windows.has(sender.tab.windowId));
    if (!session) { port.disconnect(); return; }
    let info, configured = false, disconnected = false;
    // Listener registration precedes async browser authorization. Unconfigured ports cannot emit evidence.
    port.onMessage.addListener(message => {
      if (disconnected || message?.sessionId !== session.id) return;
      if (message.type === "bootstrap-closed") {
        // The sender identity/window came from the browser, never from the page.
        void serial(session, async () => {
          const tab = await eligible(session, sender.tab.id).catch(() => null);
          if (!tab || session.closed || !allowed(session, sender.url)) return;
          if (!validId(message.interactions) || message.interactions !== 0) { error(session, "browser_capture_collector_not_ready"); return; }
          if (session.emptyDocuments.has(sender.documentId)) return;
          session.emptyDocuments.set(sender.documentId, sender.tab.id);
          if (session.emptyDocuments.size > 4096) { error(session, "browser_capture_document_limit", true); void end(session); return; }
          confirmNavigation(session, sender.documentId);
          proof(session, null, "empty_document_closed", {tabId: sender.tab.id, documentId: sender.documentId, documentSequence: 0});
        }).catch(() => undefined);
        return;
      }
      if (!configured || !info) return;
      if (message.type === "reply") {
        const doc = [...info.documents.values()].find(d => d.port === port && d.requests.has(message.id));
        doc?.requests.get(message.id)?.resolve(message.state); return;
      }
      if (session.closed) return;
      if (message.type === "ready") {
        void serial(session, () => registerPage(session, info, sender, port, message.state)).catch(() => undefined);
      } else if (message.type === "observation" && typeof message.payload === "string") {
        onPageObservation(session, info, port, sender, message.payload);
      }
    });
    port.onDisconnect.addListener(() => {
      disconnected = true;
      if (!info) return;
      if (info.ports.get(sender.documentId) === port) info.ports.delete(sender.documentId);
      // Earlier Port messages are already enqueued; retirement must not erase their document identity.
      for (const doc of info.documents.values()) if (doc.port === port) {
        for (const request of [...doc.requests.values()]) request.reject(Error("browser_capture_page_port_disconnected"));
        retire(session, doc);
      }
    });
    try {
      // This preliminary scope permits content-free lifecycle proof only. Actual
      // content collection still waits for the asynchronous browser checks below.
      if (!allowed(session, sender.url)) { port.disconnect(); return; }
      port.postMessage({type: "scope", sessionId: session.id});
      await serial(session, async () => {
        const tab = await eligible(session, sender.tab.id).catch(() => null);
        if (!tab || session.stopping || !allowed(session, sender.url) || disconnected) return;
        if (!session.tabs.has(tab.id)) await install(session, tab.id);
        info = session.tabs.get(tab.id);
        if (!info || info.revoked || info.ports.has(sender.documentId) || session.stopping || disconnected) return;
        info.ports.set(sender.documentId, port); configured = true;
        port.postMessage({ type: "configure", sessionId: session.id });
      });
      if (!configured) port.disconnect();
    } catch { port.disconnect(); }
  }
  async function remove(session, tabId, captured) {
    const info = captured || session.tabs.get(tabId);
    if (!info) return;
    if (session.tabs.get(tabId) === info) session.tabs.delete(tabId);
    if (tabOwners.get(tabId) === session) tabOwners.delete(tabId);
    if (!info.revoked) emit(session, { kind: "tab-left", tabId });
    info.revoked = true;
    for (const doc of info.documents.values()) {
      clearTimeout(doc.retireTimer);
      for (const resolve of [...doc.waiters]) resolve(false);
    }
    const cleanup = [...info.documents.values()].filter(doc => !doc.retired).map(doc => pageCommand(doc, "stop").catch(() => undefined));
    await bounded(Promise.all(cleanup), Date.now() + 500).catch(() => undefined);
    for (const port of info.ports.values()) { try { port.disconnect(); } catch {} }
    await bounded(services.detach(tabId), Date.now() + 500).catch(() => undefined);
  }
  function bounded(promise, deadline) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("browser_capture_deadline")), Math.max(0, deadline - Date.now()));
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  async function end(session) {
    if (session.closed) return;
    session.closed = true; sessions.delete(session.id);
    for (const popup of session.pendingPopups) clearTimeout(popup.timer);
    for (const candidate of session.navigationDocuments.values()) clearTimeout(candidate.timer);
    await Promise.all([...session.tabs.keys()].map(tabId => remove(session, tabId)));
  }
  function fence(session, info, doc, final, deadline) {
    if (doc.closed) return Promise.resolve(!doc.gap);
    if (doc.expired) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = `${session.id}:${++session.fenceSequence}`, at = Date.now();
      const done = ok => {
        if (!doc.waiters.delete(done)) return;
        clearTimeout(timer); info.fences.delete(id);
        proof(session, doc, ok ? "confirmed" : "unconfirmed", { checkpointId: id, elapsedMs: Date.now() - at });
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), Math.max(0, deadline - Date.now()));
      doc.waiters.add(done); info.fences.set(id, { doc, done });
      if (doc.retired) return; // Its close marker, never a new page's marker, must settle the old document.
      const issue = async (attempt = 0) => {
        try {
          await pageCommand(doc, "checkpoint", { checkpointId: id, lifetime: final ? 0 : PAGE_LEASE_MS });
        } catch (failure) {
          if (!doc.waiters.has(done)) return;
          proof(session, doc, "command_error", { checkpointId: id,
            errorCode: /page_port_disconnected/.test(String(failure)) ? "page_port_disconnected" : missingContext(failure) ? "context_destroyed" : detached(failure) ? "debugger_detached" : "evaluation_failed" });
          if (session.closed) return done(false);
          if (missingContext(failure) || /page_port_disconnected/.test(String(failure))) { retire(session, doc); return; }
          if (detached(failure)) { error(session, "browser_capture_debugger_detached", true); void end(session); return done(false); }
          if (!attempt && !doc.retired && Date.now() + 100 < deadline) return issue(1);
          done(false);
        }
      };
      void issue();
    });
  }
  async function checkpoint(session, final) {
    const deadline = Date.now() + (final ? 4000 : 2000);
    if (final && session.pendingPopups.length) error(session, "browser_capture_popup_unconfirmed");
    let boundaryConfirmed = true;
    await bounded(session.pending, deadline).catch(() => { boundaryConfirmed = false; });
    // A departing tab loses content authority immediately, but its old document
    // must still close before the Host receives tab-left or the final fence.
    await bounded(Promise.all([...session.departures]), deadline).catch(() => { boundaryConfirmed = false; });
    if (final) {
      const pending = [...session.navigationDocuments.values()].filter(candidate => !candidate.ready && !candidate.reported);
      await Promise.all(pending.map(candidate => bounded(new Promise(resolve => candidate.waiters.add(resolve)), Math.min(deadline, Date.now() + HANDOFF_MS)).catch(() => undefined)));
      await bounded(session.pending, deadline).catch(() => { boundaryConfirmed = false; });
      for (const candidate of session.navigationDocuments.values()) checkNavigation(session, candidate);
    }
    const work = [...session.tabs.values()].map(async info => {
      const tab = await bounded(eligible(session, info.tabId), deadline).catch(() => null);
      if (!tab) { await remove(session, info.tabId); return false; }
      if (safeUrl(tab.url) && !allowed(session, tab.url)) { error(session, "browser_capture_site_excluded"); await remove(session, info.tabId); return false; }
      // Retired documents that already timed out are historical coverage gaps, not a failed current flush.
      const docs = [...info.documents.values()].filter(doc => !doc.expired && !doc.closed);
      return (await Promise.all(docs.map(doc => fence(session, info, doc, final, deadline)))).every(Boolean);
    });
    if (!(await bounded(Promise.all(work), deadline).catch(() => [false])).every(Boolean)) boundaryConfirmed = false;
    await bounded(session.pending, deadline).catch(() => { boundaryConfirmed = false; });
    if (!boundaryConfirmed) error(session, "browser_capture_document_fence_failed");
    if (final) await end(session);
    const result = { protocolVersion: 2, boundaryConfirmed, coverageComplete: !session.issues.size,
      complete: boundaryConfirmed && !session.issues.size, lastSequence: session.sequence };
    return result;
  }
  async function handle(message) {
    const { sessionId: id, action, input = {} } = message;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw Error("browser_capture_invalid_identity");
    if (action === "prepare") {
      if (input.protocolVersion !== 2) throw Error("browser_capture_protocol_update_required");
      if (sessions.has(id) || sessions.size || stopped.has(id)) throw Error("browser_capture_profile_busy");
      const session = { id, sequence: 0, fenceSequence: 0,
        windows: new Set(), tabs: new Map(), departures: new Set(), issues: new Set(), navigationDocuments: new Map(), emptyDocuments: new Map(), pending: Promise.resolve(), stopping: false, stopPromise: null,
        binding: `__memmy_teach_${id.replaceAll("-", "")}`, control: `__memmy_teach_control_${id.replaceAll("-", "")}`,
        world: `memmy.teaching.${id}`, settings: input.settings, bundleId: input.bundleId, active: false, closed: false, touched: Date.now(), through: null,
        existingWindows: new Set(), firstTabs: new Map(), pendingPopups: [], popupProofs: [] };
      sessions.set(id, session);
      try {
        for (const window of await chrome.windows.getAll()) session.existingWindows.add(window.id);
        const window = await chrome.windows.create({ url: "about:blank", type: "normal", focused: true, incognito: false });
        if (session.closed) throw Error("browser_capture_cancelled");
        if (!validId(window?.id) || window.incognito !== false) throw Error("browser_capture_window_binding_failed");
        session.windows.add(window.id);
        const tabs = await chrome.tabs.query({ windowId: window.id });
        if (tabs.length !== 1) throw Error("browser_capture_initial_tab_unavailable");
        await install(session, tabs[0].id, true);
        return { protocolVersion: 2, windowId: window.id, incognito: false };
      } catch (failure) { await end(session); throw failure; }
    }
    const session = sessions.get(id);
    if (!session) {
      if (action === "stop" && stopped.has(id)) return stopped.get(id).result;
      if (action === "cancel") return { cancelled: true };
      throw Error("browser_capture_session_expired");
    }
    session.touched = Date.now();
    if (action === "cancel") { await end(session); return { cancelled: true }; }
    if (action === "start") {
      if (session.stopping) throw Error("browser_capture_session_expired");
      session.active = true;
      await session.pending;
      for (const info of session.tabs.values()) void chrome.tabs.sendMessage?.(info.tabId, {type: "memmy.teaching.connect"}).catch(() => undefined);
      return { protocolVersion: 2, recording: true };
    }
    if (action !== "checkpoint" && action !== "stop") throw Error("browser_capture_unknown_action");
    if (input.settings) session.settings = input.settings;
    if (action === "stop") {
      if (session.stopPromise) return session.stopPromise;
      if (!Number.isFinite(Date.parse(input.through))) throw Error("browser_capture_invalid_cutoff");
      session.through = Date.parse(input.through); session.stopping = true;
      session.stopPromise = checkpoint(session, true).then(result => {
        stopped.set(id, { at: Date.now(), result }); return result;
      });
      return session.stopPromise;
    }
    if (session.stopping) return session.stopPromise;
    return checkpoint(session, false);
  }
  function onDebuggerEvent(source, method, data) {
    const session = tabOwners.get(source.tabId), info = session?.tabs.get(source.tabId);
    if (!session || !info || source.sessionId) return;
    if (method === "Page.windowOpen") {
      const proof = session.popupProofs.findIndex(item => item.tabId === source.tabId && Date.now() - item.at < 2000);
      if (proof >= 0) session.popupProofs.splice(proof, 1);
      else {
        const popup = { tabId: source.tabId, timer: null };
        popup.timer = setTimeout(() => {
          if (!session.closed && session.pendingPopups.includes(popup)) {
            session.pendingPopups.splice(session.pendingPopups.indexOf(popup), 1); error(session, "browser_capture_popup_unconfirmed");
          }
        }, 2000);
        session.pendingPopups.push(popup);
      }
    } else if (method === "Page.frameNavigated" && !data.frame?.parentId) {
      info.mainFrameId = data.frame.id;
      for (const doc of info.documents.values()) if (!doc.retired) retire(session, doc);
      if (safeUrl(data.frame.url) && !allowed(session, data.frame.url)) void serial(session, async () => {
        error(session, "browser_capture_site_excluded"); await remove(session, source.tabId);
      }).catch(() => undefined);
    } else if (method === "Page.navigatedWithinDocument" && data.frameId === info.mainFrameId) {
      void serial(session, async () => {
        const tab = await eligible(session, source.tabId).catch(() => null), doc = info.current, url = safeUrl(data.url);
        if (!tab || !url || !doc || doc.retired || doc.closed || session.stopping) return;
        if (!allowed(session, url)) { error(session, "browser_capture_site_excluded"); await remove(session, source.tabId); return; }
        doc.url = url;
        emit(session, { kind: "document", tabId: info.tabId, windowId: info.windowId, documentId: doc.id, url, incognito: false, epoch: doc.epoch });
        if (session.active) {
          await pageCommand(doc, "activate", {url, epoch: doc.epoch});
          emit(session, { kind: "event", eventType: "navigation", observedAt: Date.now(), details: {},
            tabId: info.tabId, windowId: info.windowId, documentId: doc.id, url });
        }
      }).catch(() => undefined);
    }
  }
  function onPageObservation(session, info, port, sender, payload) {
      // Markers and input enter the same queue. The coordinator waits outside this queue.
      void serial(session, async () => {
        let value; try { if (typeof payload !== "string" || payload.length > 8000) throw Error(); value = JSON.parse(payload); } catch { error(session, "browser_capture_invalid_payload"); return; }
        if (session.closed || (info.revoked && value.kind !== "closed" && value.kind !== "fence")) return;
        if (value.kind === "resume") {
          if (session.active && !session.stopping) {
            const state = JSON.parse(payload);
            await registerPage(session, info, sender, port, {nonce: state.nonce, epoch: state.epoch});
          }
          return;
        }
        if (value.kind === "fault") { error(session, "browser_capture_page_overflow"); return; }
        const doc = info.byNonce.get(`${value.nonce}:${value.epoch}`);
        if (!doc || doc.port !== port || doc.expired) { error(session, "browser_capture_unknown_document"); return; }
        if (value.kind === "fence" || value.kind === "closed") {
          if (!validId(value.documentSequence) || value.documentSequence < doc.sequence) {
            doc.gap = true; error(session, "browser_capture_document_sequence_gap"); return;
          }
          if (value.kind === "closed") {
            if (!validId(value.missed) || value.missed > 0) error(session, "browser_capture_collector_not_ready");
            if (doc.finalSequence !== null && doc.finalSequence !== value.documentSequence) { doc.gap = true; error(session, "browser_capture_invalid_close"); return; }
            doc.finalSequence = value.documentSequence;
            proof(session, doc, "closing", { finalSequence: value.documentSequence });
            if (value.reason === "lease_expired") { doc.gap = true; error(session, "browser_capture_page_lease_expired"); }
            settleDocument(doc);
          }
          const pending = info.fences.get(value.id);
          if (pending?.doc === doc) {
            if (value.documentSequence === doc.sequence && !doc.buffer.size) pending.done(!doc.gap);
            else doc.pendingFence = { id: value.id, sequence: value.documentSequence };
          }
          return;
        }
        if (!session.active || value.kind !== "event" || !validId(value.documentSequence) || !value.documentSequence
          || !validId(value.observedAt) || doc.closed || (doc.finalSequence !== null && value.documentSequence > doc.finalSequence)) return;
        if (value.documentSequence <= doc.sequence || doc.buffer.has(value.documentSequence)) { error(session, "browser_capture_duplicate_event"); return; }
        if (doc.buffer.size >= 100) { doc.gap = true; error(session, "browser_capture_document_sequence_gap"); return; }
        doc.buffer.set(value.documentSequence, value);
        while (doc.buffer.has(doc.sequence + 1)) {
          const event = doc.buffer.get(++doc.sequence); doc.buffer.delete(doc.sequence);
          const tab = await eligible(session, info.tabId).catch(() => null);
          if (!tab || info.revoked || tab.windowId !== info.windowId || !allowed(session, doc.url)) continue;
          if (!["click", "text_input", "submit", "selection_changed", "key_press"].includes(event.eventType)) { doc.gap = true; error(session, "browser_capture_invalid_payload"); continue; }
          emit(session, { kind: "event", eventType: event.eventType, observedAt: event.observedAt,
            details: session.through !== null && event.observedAt > session.through ? {} : event.details,
            documentSequence: doc.sequence, tabId: info.tabId, windowId: info.windowId, documentId: doc.id, url: doc.url });
        }
        settleDocument(doc);
        const pending = doc.pendingFence && info.fences.get(doc.pendingFence.id);
        if (pending && doc.pendingFence.sequence === doc.sequence && !doc.buffer.size) { pending.done(!doc.gap); doc.pendingFence = null; }
      }).catch(() => undefined);
  }
  chrome.debugger.onEvent.addListener(onDebuggerEvent);
  chrome.webNavigation.onCommitted?.addListener(detail => {
    if (detail.frameId !== 0 || (detail.documentLifecycle && detail.documentLifecycle !== "active")) return;
    const owner = tabOwners.get(detail.tabId);
    if (owner) trackNavigation(owner, detail.tabId, detail.documentId, detail.url);
    else void chrome.tabs.get(detail.tabId).then(tab => {
      for (const session of sessions.values()) if (session.windows.has(tab.windowId) && !privateOrProtected(tab)) trackNavigation(session, tab.id, detail.documentId, detail.url);
    }).catch(() => undefined);
  });
  chrome.debugger.onDetach.addListener(source => {
    const session = tabOwners.get(source.tabId);
    if (session && !session.closed) { error(session, "browser_capture_debugger_detached", true); void end(session); }
  });
  chrome.tabs.onUpdated.addListener(tabId => {
    for (const session of sessions.values()) void serial(session, async () => {
      const tab = await eligible(session, tabId).catch(() => null);
      if (tab && !session.tabs.has(tabId) && allowed(session, tab.url)) await install(session, tabId);
    }).catch(() => undefined);
  });
  chrome.tabs.onCreated.addListener(tab => {
    for (const session of sessions.values()) {
      if (!session.existingWindows.has(tab.windowId) && !session.firstTabs.has(tab.windowId)) session.firstTabs.set(tab.windowId, tab.id);
      if (session.windows.has(tab.windowId)) void serial(session, () => install(session, tab.id)).catch(() => undefined);
    }
  });
  chrome.tabs.onDetached?.addListener(tabId => {
    const session = tabOwners.get(tabId);
    const info = session?.tabs.get(tabId);
    if (info) {
      info.revoked = true; tabOwners.delete(tabId);
      const departure = (async () => {
        const deadline = Date.now() + HANDOFF_MS;
        const closed = await Promise.all([...info.documents.values()].map(doc => fence(session, info, doc, true, deadline)));
        await session.pending;
        if (!closed.every(Boolean)) error(session, "browser_capture_document_tail_unconfirmed");
        emit(session, { kind: "tab-left", tabId });
        await remove(session, tabId, info);
      })();
      info.departure = departure; session.departures.add(departure);
      void departure.catch(() => error(session, "browser_capture_document_tail_unconfirmed"))
        .finally(() => session.departures.delete(departure));
    }
  });
  chrome.tabs.onAttached?.addListener((tabId, detail) => {
    for (const session of sessions.values()) if (session.windows.has(detail.newWindowId)) {
      const departure = session.tabs.get(tabId)?.departure;
      void Promise.resolve(departure).then(() => serial(session, () => install(session, tabId))).catch(() => undefined);
    }
  });
  chrome.tabs.onRemoved.addListener(tabId => { const session = tabOwners.get(tabId); if (session) void remove(session, tabId); });
  chrome.windows.onRemoved?.addListener(windowId => {
    for (const session of sessions.values()) if (session.windows.delete(windowId)) {
      if (!session.windows.size) { error(session, "browser_capture_windows_closed", true); void end(session); }
    }
  });
  chrome.webNavigation.onCreatedNavigationTarget.addListener(detail => {
    const session = tabOwners.get(detail.sourceTabId);
    if (!session) return;
    void serial(session, async () => {
      const source = await eligible(session, detail.sourceTabId).catch(() => null);
      const tab = await chrome.tabs.get(detail.tabId);
      if (!source || privateOrProtected(tab)) return;
      const pending = session.pendingPopups.findIndex(item => item.tabId === detail.sourceTabId);
      if (pending >= 0) { clearTimeout(session.pendingPopups[pending].timer); session.pendingPopups.splice(pending, 1); }
      else { session.popupProofs = session.popupProofs.filter(item => Date.now() - item.at < 2000); session.popupProofs.push({ tabId: detail.sourceTabId, at: Date.now() }); }
      if (!session.windows.has(tab.windowId)) {
        // The browser says this is a newly created navigation target, not an existing named window.
        if (session.existingWindows.has(tab.windowId) || session.firstTabs.get(tab.windowId) !== tab.id) {
          error(session, "browser_capture_popup_unconfirmed"); return;
        }
        const window = await chrome.windows.get(tab.windowId, { populate: true });
        if (window.incognito !== false || !window.tabs || window.tabs.some(item => item.id !== tab.id)) return;
        session.windows.add(tab.windowId);
        emit(session, { kind: "window", windowId: tab.windowId, sourceTabId: source.id, sourceWindowId: source.windowId });
      }
      await install(session, tab.id);
    }).catch(() => undefined);
  });
  const watchdog = setInterval(() => {
    for (const session of sessions.values()) {
      if (Date.now() - session.touched > WINDOW_LEASE_MS) { error(session, "browser_capture_host_lease_expired", true); void end(session); }
      for (const info of session.tabs.values()) for (const [id, doc] of info.documents) {
        if (doc.retired && (doc.closed || doc.expired) && Date.now() - doc.retiredAt > 10000) { info.documents.delete(id); info.byNonce.delete(`${doc.nonce}:${doc.epoch}`); }
      }
    }
    for (const [id, value] of stopped) if (Date.now() - value.at > 30000) stopped.delete(id);
  }, 1000);
  return { handle, connectPage, active: () => sessions.size > 0, owns: tabId => tabOwners.has(tabId),
    disconnect() { for (const session of [...sessions.values()]) void end(session); },
    async close() { clearInterval(watchdog); await Promise.all([...sessions.values()].map(end)); } };
}
