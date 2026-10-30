/* global chrome */
"use strict";

// Runs in the extension isolated world, only after the background authorizes this document.
function memmyTeachingPage(binding, control, lifetime, earlyInteractions = 0) {
  if (window !== window.top) return;
  if (globalThis[control]) return;
  let enabled = false, expires = Date.now() + lifetime, expectedUrl = "", count = 0, bucket = Date.now();
  // randomUUID is unavailable in insecure documents (including an initial opaque about:blank).
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  let epoch = 0, sequence = 0, closed = false, revoked = false, missed = earlyInteractions;
  const listeners = [];
  const sensitive = /password|passwd|secret|token|api.?key|credit.?card|card.?number|cvc|cvv|one.?time|otp|verification|验证码|密码|口令|密钥|银行卡|信用卡|安全码/i;
  const redact = value => String(value ?? "").slice(0, 1000)
    .replace(/\bBearer\s+[a-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/\b[a-z0-9]+[-_](?:secret|token)(?:[-_][a-z0-9]+)+\b/gi, "[REDACTED]")
    .replace(/((?:password|secret|token|api.?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  const send = value => { try { globalThis[binding](JSON.stringify(value)); } catch { stop(); } };
  const badge = document.createElement("div");
  badge.id = "memmy-teaching-recording";
  badge.textContent = "Memmy 正在准备教学窗口 · 尚未开始录制";
  badge.setAttribute("role", "status");
  badge.style.cssText = "position:fixed;top:8px;right:8px;z-index:2147483647;background:#9f1c28;color:white;padding:8px 12px;border-radius:8px;font:13px system-ui;pointer-events:none";
  function show() { if (document.documentElement && !badge.isConnected) document.documentElement.appendChild(badge); }
  function stop() {
    enabled = false;
    for (const [type, fn, owner = document] of listeners) owner.removeEventListener(type, fn, true);
    badge.remove();
    revoked = true;
    clearInterval(expiryTimer);
  }
  const state = () => ({ nonce, epoch, sequence, closed, revoked, missed });
  function close(reason, id) {
    if (closed || revoked) return;
    enabled = false; closed = true;
    send({ kind: "closed", nonce, epoch, documentSequence: sequence, missed, reason, id });
    badge.remove();
  }
  function target(event) {
    const el = event.composedPath?.().find(node => node instanceof Element) ?? event.target;
    return el instanceof Element ? el.closest("button,a,input,select,textarea,[role],[contenteditable]") || el : null;
  }
  function blocked(el) {
    if (!el) return true;
    const name = [el.getAttribute("type"), el.getAttribute("name"), el.id, el.getAttribute("autocomplete"),
      el.getAttribute("aria-label"), ...Array.from(el.labels || [], label => label.textContent || "")].join(" ");
    if (sensitive.test(name) || /^(password|hidden|file)$/i.test(el.getAttribute("type") || "")) return true;
    const form = el.closest("form");
    return !!form?.querySelector('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"]');
  }
  function copiedDocumentText() {
    // Read only a deliberate, trusted copy selection, never the clipboard or page body.
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0), node = range.commonAncestorContainer;
    const root = node.nodeType === 1 ? node : node.parentElement;
    if (!(root instanceof Element) || root === badge
      || root.closest("input,textarea,select,[contenteditable]")) return null;
    for (let ancestor = root; ancestor; ancestor = ancestor.parentElement) if (blocked(ancestor)) return null;
    // Triple-click selections can end at offset zero in the next block. That
    // boundary touches the element but includes none of its contents.
    const endsBeforeContents = el => {
      if (range.endOffset !== 0) return false;
      for (let node = range.endContainer; node; node = node.parentNode) {
        if (node === el) return true;
        if (node.previousSibling) break;
      }
      return false;
    };
    const descendants = Array.from(root.querySelectorAll("*"));
    if (descendants.length > 200 || descendants.some(el => range.intersectsNode(el) && !endsBeforeContents(el) && (blocked(el)
      || /^(input|textarea|select)$/i.test(el.tagName) || el.getAttribute("contenteditable") !== null))) return null;
    return range.toString().trim();
  }
  function observe(type, event) {
    // Focus/lease checks precede all page text/value reads. Background pages aren't polled.
    if (revoked || closed) return;
    if (Date.now() > expires) { close("lease_expired"); stop(); return; }
    if (!enabled) { if (event.isTrusted && document.hasFocus() && document.visibilityState === "visible") missed++; return; }
    if (!event.isTrusted || !document.hasFocus() || document.visibilityState !== "visible" || !/^https?:$/.test(location.protocol)) return;
    const current = new URL(location.href); current.search = ""; current.hash = ""; current.username = ""; current.password = "";
    if (current.href !== expectedUrl) return;
    const el = target(event);
    if (!el || el === badge || blocked(el)) return;
    if (Date.now() - bucket >= 1000) { bucket = Date.now(); count = 0; }
    if (++count > 100) { if (count === 101) send({ kind: "fault", code: "browser_capture_page_overflow" }); return; }
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const label = el.getAttribute("aria-label") || Array.from(el.labels || [], item => item.textContent || "").join(" ")
      || el.getAttribute("title") || (/^(button|a|option)$/i.test(el.tagName) ? el.textContent : "");
    const details = { role, label: redact(label).slice(0, 200), inputType: el.getAttribute("type") || "",
      selector: el.id && /^[a-zA-Z][\w-]{0,79}$/.test(el.id) && !sensitive.test(el.id) ? `#${el.id}` : "", redacted: false };
    const nativeDate = el instanceof HTMLInputElement && /^(date|datetime-local|time|month|week)$/i.test(details.inputType);
    let eventType = type;
    if (type === "text_input") {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || blocked(el)) return;
      // Native date/time input events have no inserted text. Capture their committed
      // canonical value only on a trusted change, after the same scope/privacy checks.
      if (nativeDate) return;
      // Keep only text inserted by this trusted input event. Reading the whole
      // field would also retain values entered before recording or while the tab was outside scope.
      details.text = typeof event.data === "string" ? redact(event.data) : "[REDACTED]";
      details.redacted = typeof event.data !== "string";
      details.textSource = "input_event";
    }
    if (type === "selection_changed") {
      if (event.type === "copy") {
        const text = copiedDocumentText();
        if (!text) return;
        details.text = redact(text); details.textSource = "document_copy";
        details.redacted = details.text !== text; details.role = "document-text";
      } else if (nativeDate) {
        const value = el.value;
        if (typeof value !== "string" || value.length > 32 || !/^[0-9T:W.\-]*$/.test(value)) return;
        details.text = value; details.textSource = "control_change"; eventType = "text_input";
      } else {
        details.text = redact(el instanceof HTMLSelectElement ? el.selectedOptions[0]?.textContent : "");
        if (el instanceof HTMLSelectElement) details.textSource = "control_change";
      }
    }
    if (type === "key_press") { if (!["Enter", "Tab", "Escape"].includes(event.key)) return; details.key = event.key; }
    send({ kind: "event", nonce, epoch, documentSequence: ++sequence, eventType, observedAt: Date.now(), details });
  }
  for (const [type, semantic] of [["click", "click"], ["input", "text_input"], ["submit", "submit"], ["change", "selection_changed"], ["copy", "selection_changed"], ["keydown", "key_press"]]) {
    const fn = event => observe(semantic, event);
    document.addEventListener(type, fn, true); listeners.push([type, fn]);
  }
  Object.defineProperty(globalThis, control, { configurable: true, value: {
    state,
    activate(url, expectedEpoch) { if (revoked || closed || expectedEpoch !== epoch) return state();
      expectedUrl = url; enabled = true; expires = Date.now() + lifetime;
      badge.textContent = "● Memmy 正在记录本教学窗口 · 在对话中结束录制"; show(); return state(); },
    ready() { badge.textContent = "● Memmy 已开始录制 · 请在本教学窗口中操作"; expires = Date.now() + lifetime; show(); }, show,
    checkpoint(id, nextLifetime) {
      if (revoked || closed) return state();
      if (nextLifetime === 0) { close("stop", id); stop(); }
      else { expires = Date.now() + nextLifetime; send({ kind: "fence", id, nonce, epoch, documentSequence: sequence }); }
      return state();
    }, stop,
  } });
  for (const type of ["pagehide", "freeze"]) {
    const fn = event => { if (event.isTrusted) close(type); };
    window.addEventListener(type, fn, true); listeners.push([type, fn, window]);
  }
  const resume = event => {
    if (!event.isTrusted || !closed || revoked) return;
    closed = false; enabled = false; epoch++; sequence = 0; missed = 0; expires = Date.now() + lifetime;
    send({ kind: "resume", nonce, epoch });
  };
  window.addEventListener("pageshow", resume, true); listeners.push(["pageshow", resume, window]);
  const showWhenReady = () => { if (enabled && !closed && !revoked) show(); };
  document.addEventListener("DOMContentLoaded", showWhenReady, true); listeners.push(["DOMContentLoaded", showWhenReady]);
  const expiryTimer = setInterval(() => { if (!closed && Date.now() > expires) { close("lease_expired"); stop(); } }, 1000);
}

// Native extension ports survive the navigation handoff that drops CDP binding notifications.
(() => {
  if (window !== window.top) return;
  let current = null;
  // This local count detects startup gaps without inspecting targets, values or page text.
  // It is never sent for an unauthorized document, and is reset on an explicit new scope entry.
  let earlyInteractions = 0, watching = true;
  const earlyTypes = ["click", "input", "submit", "change", "copy", "keydown"];
  const early = event => { if (watching && event.isTrusted && document.hasFocus() && document.visibilityState === "visible") earlyInteractions++; };
  for (const type of earlyTypes) document.addEventListener(type, early, true);
  const watch = () => { watching = true; earlyInteractions = 0; };
  function connect() {
    if (current) return;
    const port = chrome.runtime.connect({ name: "memmy-teaching/v2" });
    const connection = { port, sessionId: null, scopeSessionId: null, bootstrapClosed: false, control: null, binding: null, controller: null, sendPayload: null };
    current = connection;
    port.onMessage.addListener(message => {
      if (current !== connection || !message || typeof message !== "object") return;
      if (message.type === "scope" && !connection.scopeSessionId) {
        if (typeof message.sessionId === "string" && /^[0-9a-f-]{36}$/.test(message.sessionId)) connection.scopeSessionId = message.sessionId;
      } else if (message.type === "configure" && !connection.sessionId && !connection.bootstrapClosed) {
        if (typeof message.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(message.sessionId)) return;
        connection.sessionId = message.sessionId;
        connection.control = `__memmy_teach_control_${message.sessionId.replaceAll("-", "")}`;
        connection.binding = `__memmy_teach_${message.sessionId.replaceAll("-", "")}`;
        globalThis[connection.control]?.stop(); delete globalThis[connection.control];
        connection.sendPayload = payload => port.postMessage({ type: "observation", sessionId: connection.sessionId, payload });
        globalThis[connection.binding] = connection.sendPayload;
        watching = false;
        memmyTeachingPage(connection.binding, connection.control, 7000, earlyInteractions);
        connection.controller = globalThis[connection.control];
        port.postMessage({ type: "ready", sessionId: connection.sessionId, state: globalThis[connection.control].state() });
      } else if (message.type === "command" && message.sessionId === connection.sessionId) {
        const control = globalThis[connection.control];
        if (!control) return;
        if (message.action === "activate") control.activate(message.url, message.epoch);
        else if (message.action === "checkpoint") control.checkpoint(message.checkpointId, message.lifetime);
        else if (message.action === "stop") control.stop();
        else if (message.action !== "state") return;
        port.postMessage({ type: "reply", id: message.id, sessionId: connection.sessionId, state: control.state() });
      }
    });
    port.onDisconnect.addListener(() => {
      // A disconnected page never grants itself a new lease; a new Port must be authorized again.
      connection.controller?.stop();
      if (connection.binding && globalThis[connection.binding] === connection.sendPayload) delete globalThis[connection.binding];
      if (current === connection) current = null;
      watch();
    });
  }
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === chrome.runtime.id && message?.type === "memmy.teaching.connect") { if (!current) watch(); connect(); }
  });
  for (const type of ["pagehide", "freeze"]) window.addEventListener(type, event => {
    const connection = current;
    if (!event.isTrusted || !connection?.scopeSessionId || connection.controller || connection.bootstrapClosed) return;
    connection.bootstrapClosed = true;
    // No page content is read. Only an already scoped Port may prove that this
    // document closed without any supported trusted interaction since document_start.
    try { connection.port.postMessage({type: "bootstrap-closed", sessionId: connection.scopeSessionId, interactions: earlyInteractions}); } catch {}
  }, true);
  window.addEventListener("pageshow", event => {
    if (!event.isTrusted) return;
    if (current?.bootstrapClosed && !current.controller) current.port.disconnect();
    connect();
  }, true);
  connect();
})();
