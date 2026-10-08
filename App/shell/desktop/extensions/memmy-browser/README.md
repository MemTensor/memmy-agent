# Memmy Chrome / Edge extension

This unpacked MV3 extension lets Memmy operate ordinary web pages in Chrome or Edge
after it is installed. It uses the Chromium Debugger API for accessibility snapshots,
targeted input, navigation, and screenshots. It does not read browsing history or cookies.
Browser internal pages, extension pages, and `file:` pages cannot be controlled.

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

The Chrome and Edge build uses the same extension ID, derived from the public
manifest key. The private key used to generate that public key is not shipped.

Memmy does not silently install this extension into a user's existing Chrome or
Edge profile. Chrome on Windows/macOS restricts direct distribution of extensions
outside the Chrome Web Store to managed enterprise environments, and Edge has
similar constraints for self-hosted distribution. The browser's own **Load
unpacked** choice remains the user's confirmation step. The Memmy built-in
Electron browser uses its own bridge and does not load this extension: Electron
does not list the required `chrome.debugger` API among supported extension APIs.

The managed profile uses the programmatic CDP `Extensions.loadUnpacked`
method with `--remote-debugging-pipe` and
`--enable-unsafe-extension-debugging`. The debugging pipe is retained inside
Memmy's process. A browser left running after an abnormal Memmy crash may
need to be closed before automatic setup can restart the same profile.
Chrome-branded builds also removed
the older `--load-extension` startup switch in Chrome 137.

References: [Chrome distribution](https://developer.chrome.com/docs/extensions/how-to/distribute/),
[Chrome local loading](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world/#load-unpacked),
[Edge local loading](https://learn.microsoft.com/en-us/microsoft-edge/extensions/getting-started/extension-sideloading),
[Chromium extension automation guidance](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY),
[Electron extension APIs](https://www.electronjs.org/docs/latest/api/extensions/).
