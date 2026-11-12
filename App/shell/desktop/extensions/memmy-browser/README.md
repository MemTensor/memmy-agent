# Memmy Chrome / Edge extension

This unpacked MV3 extension lets Memmy operate ordinary web pages in Chrome or Edge
after it is installed. Ordinary page actions use Playwright's public APIs through
a tab-scoped Chromium Debugger transport. Navigation and separately authorized
file/credential operations retain the Memmy bridge. It does not read the browser's
browsing-history database or cookies.
Browser internal pages, extension pages, and `file:` pages cannot be controlled.

When unified Computer History recording is enabled, isolated content scripts
observe bounded semantic page actions and states. This recording channel does not
attach the debugger and also works without an Agent task. The extension requests
HTTP(S) page access; Chrome/Edge may ask to confirm the expanded permissions on
update. No separate demonstration mode is required. History pause, stop, application
and site exclusions, private-page exclusion, and sensitive-value redaction apply.
The authenticated host authorizes a short-lived recording configuration before
the scripts read page content and rechecks the live policy before appending to the
same History event stream. Page event provenance remains unknown unless trusted
evidence attributes it to an actor.

## Install in a Memmy-managed browser profile

In **Settings → Computer Use**, choose **Install** and confirm. Memmy starts the
installed Chrome or Edge executable with a separate profile under its own local
application data, using a private DevTools pipe rather than a network debugging
port. It calls `Extensions.loadUnpacked` and verifies that the bundled extension
is enabled. The ordinary Chrome/Edge profile and its settings are not changed.
After installation, Memmy can operate ordinary web pages in that browser. The
separate browser closes when Memmy exits normally.

## Install in an existing browser profile

1. In Memmy, open **Settings → Computer Use** and select **Install** for Chrome or
   Edge. Memmy opens that browser's extensions page and copies the packaged
   extension folder path.
2. In Chrome open `chrome://extensions`, or in Edge open `edge://extensions`.
   Enable **Developer mode**, choose **Load unpacked**, and select that folder.
3. Leave Memmy open. The extension connects on its own. Ordinary web pages in
   that browser can then be operated, including pages opened later.

For Computer Use, the extension attaches the Chromium debugger to a page while Memmy runs a
command there and releases it 15 seconds after the last command. Chrome and Edge
show their system "started debugging this browser" bar when attached; its wording
and disappearance are controlled by the browser. Memmy cannot replace that text
with a custom operation status. Closing the bar stops Memmy on the attached pages;
**重新连接** in the extension popup is the explicit recovery path.

## Teach a workflow in a new window

Extension 1.2.0 advertises `teachingCapture/v2`. With explicit consent in the
conversation, Teach Mode creates a new ordinary window using `chrome.windows.create`.
It retains the selected existing profile's sign-in. The recording is bound to
that exact extension connection and window; multiple profile connections require
selection in the conversation. The original windows stay outside Teach capture.

The manifest bootstraps a small isolated content script on ordinary HTTP(S)
main documents. This changes the browser's website-access permission prompt;
it does not authorize Teach recording in existing windows. The bootstrap does
not inspect page targets, field values or text. The background checks the
browser-provided Port sender, document, profile and authorized window before
configuring and activating a collector. The Host independently validates scope.

The authorized collector records scoped user clicks,
inserted text, selections, submissions and navigation. Password/OTP/payment
fields are excluded. Full field values are never copied: only inserted text from
the current trusted input event is retained, so dragging a tab back in cannot
import text entered outside recording. The page displays a recording badge.

New tabs inside the teaching window are included. A new popup is included only
when browser-owned navigation-target metadata proves its source and it is a new
window whose first tab is that target. URL/time matching from Computer Use is
not used for Teach authorization. Moving a tab out revokes its collector;
moving it in installs a fresh collector. Private/unknown windows and excluded
sites remain excluded before content collection. Raw page-provided IDs cannot
authorize a window or document.

Events and document-close markers use native extension Ports. Each document
activation has an independent identity and contiguous event sequence, including
the final watermark on pagehide/freeze. A new document cannot stand in for an
old document's missing tail. A navigation that ends before collector readiness
leaves a gap unless its already scoped bootstrap sends a zero-interaction close
proof through the native Port. This proof reads no targets, values or page text;
it covers short automatic redirect documents only when no supported trusted
interaction occurred. Missing proof or early interactions retain a coverage gap.

Ending recording fences each document, drains the extension event queue, and
confirms the last sequence through the Host bridge before fsync and snapshot
hashing. Stop, cancel, plugin shutdown, disconnect, debugger loss and lease
expiry revoke recording. Windows and sign-in remain available after stop.
The Host stores coverage, current boundary confirmation and snapshot persistence
separately, with a hashed, content-free `capture-proof.jsonl`. Historical gaps
remain partial even if the final stop is confirmed. The v2 Host requires this
extension version; older extensions receive an update/reload message.
Teaching grants observation only; Computer Use commands cannot operate the
pages being demonstrated. The browser source does not acquire desktop History.

The Chrome and Edge build uses the same extension ID, derived from the public
manifest key. The private key used to generate that public key is not shipped.

Memmy does not silently install this extension into a user's existing Chrome or
Edge profile. Chrome on Windows/macOS restricts direct distribution of extensions
outside the Chrome Web Store to managed enterprise environments, and Edge has
similar constraints for self-hosted distribution. The browser's own **Load
unpacked** choice remains the user's confirmation step. The Memmy built-in
Electron browser uses its own bridge and does not load this extension: Electron
does not list the required `chrome.debugger` API among supported extension APIs.

The live acceptance fixture uses an isolated test profile, a private debugging
pipe and `Extensions.loadUnpacked` with `--enable-unsafe-extension-debugging` to
test the same-profile everyday/teaching window boundary. This is test setup;
production teaching uses the existing profile and user-installed extension.
The Host's separate Agent Chromium launcher is not an automatic extension
installer for the user's Chrome/Edge profile.

References: [Chrome distribution](https://developer.chrome.com/docs/extensions/how-to/distribute/),
[Chrome local loading](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world/#load-unpacked),
[Edge local loading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading),
[Chromium extension automation guidance](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY),
[Electron extension APIs](https://www.electronjs.org/docs/latest/api/extensions/).
