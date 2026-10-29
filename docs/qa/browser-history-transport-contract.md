# Passive browser History transport

## Ownership and activation

History capture is independent of an Agent conversation and does not use `chrome.debugger`. The MV3 manifest loads `history-sensor.js` and `history-content.js` into the isolated world of ordinary HTTP(S) frames. Merely loading these scripts does not read the page DOM. The sensor starts only after a short authorization lease from the authenticated background worker.

The sensor has one source implementation in `App/memmy-agent/src/tools/computer-history/browser-history-sensor.ts`. `scripts/generate-browser-history-sensor.mjs` emits its JavaScript function into `history-sensor.js`. `copy-build-assets.mjs` regenerates that static file for both packages. The browser does not use eval, injected page scripts, `window.postMessage`, or a DOM event as an authorization channel.

## Runtime integration hooks

`connectBrowserHistoryBridge(service, transport)` in `src/tools/computer-history/browser-history-bridge.ts` installs these transport hooks:

```ts
setBrowserHistoryIntentProvider(provider: () => BrowserHistoryCaptureIntent): () => void;
subscribeBrowserHistory(listener: (payload: unknown, context: BrowserHistoryTrustedContext) => void): () => void;
refreshBrowserHistoryIntent(): void;
```

The connection refreshes the intent every 500 ms, rechecks the current policy before forwarding each event to the service, and removes the timer/provider/subscription when closed. Active authorized frames renew their lease every 600 ms; disabled/inactive frames poll every 3 seconds, and focus/activation/enable events wake the focused tab using browser metadata only. The service repeats generation, document, settings, redaction, actor and deduplication checks before appending to the ordinary Computer History event stream.

`installMemmyBrowserHistoryBackground(dependencies)` in `browser-history-background.js` receives:

```js
{
  chrome,
  isConnected: () => boolean, // authenticated WebSocket ready, not merely TCP open
  send: message => void,
  isProtected: async tabId => boolean, // true/unknown blocks, false permits the next checks
  browserName: () => "chrome" | "edge",
  activeCommand: (tabId, observedAt) => ({ commandId, taskId } | undefined)
}
```

The worker calls `receive(message)` for History WebSocket messages, `disconnected()` on loss of its authenticated connection, and `revoke(tabId)` before entering credential protection or explicitly stopping a page. Browser focus, activation, loading/navigation and removal events also revoke pending leases. `activeCommand` may return evidence only for an input dispatch associated with that tab and event time. Reads and snapshots do not establish an Agent actor.

## Authenticated bridge messages

The server broadcasts `browser_history_intent` with `{enabled, generation, expiresAt}`. Its expiry is at most 1500 ms. A disabled or changed generation revokes existing leases. The root bridge must use its live provider when answering configuration requests; an old broadcast is not authority for a new grant.

The extension sends browser API metadata, with no DOM content, to request a lease:

```js
{
  type: "browser_history_config_request", id,
  browser, tabId, windowId, frameId, documentId,
  topUrl, frameUrl, ancestorOrigins, privateBrowsing: false, protected: false
}
```

`ancestorOrigins` is the frame's `location.ancestorOrigins`, parent to top: empty for the top frame (`frameId` 0); for a subframe, at most 32 HTTP(S) origins whose last entry is the origin of `topUrl`. The worker requires the list and, like the server, refuses an opaque (`"null"`), non-web, oversized or inconsistent one. The server treats a missing list as empty, so an older extension's top frames still record and its subframes do not.

The server uses the authenticated client browser identity and `browserHistoryConfiguration(intent, context)` to apply the existing `evaluateObservation` policy to the top page, the frame and every ancestor origin, so a frame nested inside an excluded site's iframe gets no lease. `context.url` is `topUrl`. It returns:

```js
{ type: "browser_history_config", id, enabled, generation, expiresAt, captureText }
```

The background checks sender extension ID, Chrome tab/frame/document identity and active document lifecycle. It verifies the current tab, focused normal window, explicit non-private state, no pending navigation, and credential protection. A Chrome `tabs.sendMessage` probe addressed to the frame and document ID rejects a removed or navigated iframe. It repeats current browser checks after the asynchronous policy response. Only then does it issue an isolated content-script lease, including the document ID and an ephemeral lease ID.

For each event the worker repeats those checks, compares its current document/URL/epoch/lease/generation, bounds event size and age, and sends the `ancestorOrigins` recorded on the lease (never a list supplied with the event):

```js
{
  type: "browser_history", browser, tabId, windowId, frameId, documentId,
  topUrl, frameUrl, ancestorOrigins, privateBrowsing: false, protected: false,
  generation, actor: "agent" | "unknown", engine: "content_script",
  actorEvidence: { kind: "memmy_command", commandId, taskId }, // optional, worker-owned
  payload
}
```

The server supplies `connectionId` and browser identity from the authenticated connection, and checks the top page, frame and ancestor origins against the live policy again before append. Page payload fields cannot grant permission or supply trusted identity/actor provenance. Without worker-owned input evidence the actor is `unknown`; `Event.isTrusted` is used only to filter web-page synthetic events. It does not prove a human actor.

Events remain in memory only until the immediate send. The extension does not persist or replay a queue of History events. The sensor removes pending timers on revoke/expiry and excludes password/OTP values before a message leaves the isolated content script; backend validation/redaction repeats that protection before durable append.

## Upgrade and acceptance handoff

Extension version `1.0.5` introduces static scripts matching HTTP(S) pages in all ordinary frames and the `scripting` permission for upgrading already-open pages. Chrome/Edge may require one extension update/permission confirmation for the new website-reading scope. The user should reload/update the Memmy extension once and complete any browser permission confirmation. A previously installed worker may otherwise continue to run older files. When History is enabled, a focused normal active HTTP(S) page lacking the new content script receives those same dormant isolated scripts after a second browser metadata/private/credential check. It still reads no DOM until the regular History policy grants a short lease. Existing pages do not require a manual page refresh.

Both package scripts run `verify-browser-extension.mjs` against the final `browser-extension` resources. The verifier checks isolated HTTP(S) scope, extension/worker version agreement, presence of all History files, and SHA-256 equality with the frozen source.

The browser's fixed debugger infobar remains browser-owned whenever Memmy actively operates a page. Passive History should produce no debugger infobar. Memmy's own operation status may say `Memmy 操作中`.

User GUI acceptance should cover: History on with no Agent chat; manual checkbox/text/date/dropdown navigation recorded with local before/after evidence; off/pause stops capture; excluded applications/sites/iframes, including frames nested inside an excluded site's iframe, stay excluded; private windows and protected login/OTP inputs produce no content; switching windows/tabs or navigating an iframe invalidates old leases; disconnect/reconnect does not replay old events; ordinary Agent browser actions still obey page ownership and permissions.
