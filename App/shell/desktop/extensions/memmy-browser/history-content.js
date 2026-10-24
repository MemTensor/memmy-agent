/* global chrome */
"use strict";

(() => {
  // Static startup and a focused-tab upgrade injection may meet in the same
  // isolated world. Install listeners and polling only once per document.
  if (globalThis.__memmyBrowserHistoryContentInstalled) return;
  globalThis.__memmyBrowserHistoryContentInstalled = true;
  // This isolated script may exist on a page while recording is disabled. It
  // reads no DOM until background has checked History consent and browser focus.
  let configuration = null, expiryTimer = null, refreshTimer = null, revision = 0, closed = false;
  const stop = () => {
    configuration = null;
    clearTimeout(expiryTimer); expiryTimer = null;
    globalThis.__memmyBrowserHistorySensor?.stop?.();
  };
  const apply = value => {
    if (closed || value?.enabled !== true || typeof value.generation !== "string"
      || typeof value.documentId !== "string" || typeof value.leaseId !== "string"
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
      || value.expiresAt > Date.now() + 1_500 || typeof value.captureText !== "boolean") { stop(); return; }
    const sameSensor = configuration?.generation === value.generation && configuration?.documentId === value.documentId
      && configuration?.captureText === value.captureText;
    configuration = value;
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(stop, Math.max(0, value.expiresAt - Date.now()));
    if (sameSensor) return;
    globalThis.__memmyInstallBrowserHistorySensor?.({ generation: value.generation,
      documentId: value.documentId, captureText: value.captureText }, payload => {
      if (!configuration || configuration.expiresAt <= Date.now() || configuration.generation !== payload.generation) { stop(); return; }
      const dispatchedLease = configuration.leaseId;
      // Only this isolated world can call the extension runtime. There is no window message bridge.
      void chrome.runtime.sendMessage({ type: "memmy_history_event", leaseId: configuration.leaseId, payload })
        .then(result => { if (result?.accepted !== true && configuration?.leaseId === dispatchedLease) stop(); })
        .catch(() => { if (configuration?.leaseId === dispatchedLease) stop(); });
    });
  };
  // A recording frame renews its short lease. An idle one waits: the worker
  // wakes frames when History turns on, a tab or window gains focus, or a page
  // finishes loading.
  const scheduleRecheck = idle => {
    if (closed) return;
    if (configuration) refreshTimer = setTimeout(refresh, 600);
    else if (!idle) refreshTimer = setTimeout(refresh, 3_000);
  };
  const refresh = async () => {
    const current = ++revision;
    let idle = false;
    try {
      // Browser frame metadata, not page DOM: every ancestor frame's site must
      // also pass website exclusions before this frame gets a lease.
      const value = await chrome.runtime.sendMessage({ type: "memmy_history_config",
        ancestorOrigins: Array.from(globalThis.location?.ancestorOrigins ?? []) });
      idle = value?.idle === true;
      if (current === revision && !closed) apply(value);
    } catch { if (current === revision) stop(); }
    if (current === revision) scheduleRecheck(idle);
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "memmy_history_revoke") { ++revision; clearTimeout(refreshTimer); stop(); scheduleRecheck(false); }
    if (message?.type === "memmy_history_refresh" && !closed) { ++revision; clearTimeout(refreshTimer); void refresh(); }
    if (message?.type === "memmy_history_probe") { respond({ active: !closed, documentId: configuration?.documentId ?? null }); }
  });
  globalThis.addEventListener("pagehide", () => { closed = true; ++revision; clearTimeout(refreshTimer); stop(); });
  globalThis.addEventListener("pageshow", event => { if (event.persisted) { closed = false; void refresh(); } });
  globalThis.addEventListener("visibilitychange", () => { if (!closed) { ++revision; clearTimeout(refreshTimer); void refresh(); } });
  void refresh();
})();
