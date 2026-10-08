// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExternalBrowserSettings } from "../external-browser-settings.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const labels = {
  chrome: "Chrome", edge: "Edge", description: "Ordinary web pages", notInstalled: "Extension not installed",
  moreBrowsers: "More browsers",
  connected: "Ready for web pages", disconnected: "Not connected", install: "Open extension folder",
  copy: "Copy", copied: "Copied", loadError: "Unavailable",
  setupTitle: "Set up", setupIntro: "Load the bundled extension.",
  managerStep: "Open the browser extension page", copyAddress: "Copy address",
  unpackedStep: "Turn on Developer mode and choose Load unpacked.",
  folderStep: "Choose the folder containing manifest.json", folderMissing: "Folder missing",
  copyPath: "Copy folder path",
  autoPrepare: "Open install page", preparing: "Opening", prepared: "Page opened; folder copied",
  browserNotFound: "Browser not found; folder copied", launchFailed: "Could not open browser; folder copied",
  manualGuide: "Manual steps",
  managedInstall: "Install in separate browser", managedConsent: "Install the extension?",
  managedConfirm: "Allow and install", managedCancel: "Cancel",
  managedInstalled: "Installed in separate browser", managedFailed: "Automatic install failed",
  managedInstalledIntro: "Ordinary web pages are ready",
};

let container: HTMLDivElement;
let root: Root;
let clipboardDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
});

it("shows the extension as ready after it connects, without a pairing code", async () => {
  const getStatus = vi.fn(async () => ({ connected: ["edge" as const], claims: [
    { browser: "edge" as const, title: "Local test", url: "https://example.test/" },
  ] }));
  const revealExtensionFolder = vi.fn(async () => undefined);
  const getExtensionDirectory = vi.fn(async () => "/Applications/Memmy.app/Contents/Resources/browser-extension");
  await act(async () => root.render(<ExternalBrowserSettings getStatus={getStatus}
    revealExtensionFolder={revealExtensionFolder} getExtensionDirectory={getExtensionDirectory} labels={labels} />));
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("More browsers"))?.click();
  });
  expect(container.textContent).toContain("Ready for web pages");
  expect(container.textContent).not.toContain("Pairing code");
  const setup = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!;
  await act(async () => { setup.click(); });
  expect(container.textContent).toContain("chrome://extensions");
  expect(container.textContent).toContain("manifest.json");
  expect(container.textContent).toContain("/Applications/Memmy.app/Contents/Resources/browser-extension");
  expect(container.textContent).not.toContain("1234:secret");
  expect(getExtensionDirectory).toHaveBeenCalledOnce();
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Copy address"))!.click();
  });
  expect(writeText).toHaveBeenCalledWith("chrome://extensions");
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Copy folder path"))!.click();
  });
  expect(writeText).toHaveBeenCalledWith("/Applications/Memmy.app/Contents/Resources/browser-extension");
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Open extension folder"))!.click();
  });
  expect(revealExtensionFolder).toHaveBeenCalledOnce();
});

it("shows Edge's address and explains when the bundled extension is missing", async () => {
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    getExtensionDirectory={async () => null}
    labels={labels} />));
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("More browsers"))?.click(); });
  const setup = Array.from(container.querySelectorAll("button")).filter(button => button.textContent?.includes("Install"))[1]!;
  await act(async () => { setup.click(); });
  expect(container.textContent).toContain("edge://extensions");
  expect(container.textContent).toContain("Folder missing");
  expect(container.textContent).not.toContain("Pairing code");
});

it("prepares browser setup and reports that browser confirmation is still needed", async () => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const,
    directory: "C:\\Program Files\\Memmy\\resources\\browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    prepareInstall={prepareInstall}
    labels={labels} />));
  const prepareButton = Array.from(container.querySelectorAll("button"))
    .find(button => button.textContent?.includes("Install"))!;
  await act(async () => { prepareButton.click(); });
  expect(prepareInstall).toHaveBeenCalledWith("chrome");
  expect(container.textContent).toContain("Page opened; folder copied");
  expect(container.textContent).toContain("Turn on Developer mode and choose Load unpacked.");
  expect(container.textContent).toContain("C:\\Program Files\\Memmy\\resources\\browser-extension");
  expect(container.textContent).toContain("Extension not installed");
});

it("falls back to manual steps when a browser executable is not found", async () => {
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    prepareInstall={async () => ({ status: "browser-not-found", directory: "/app/browser-extension" })}
    labels={labels} />));
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("More browsers"))?.click(); });
  const prepareButton = Array.from(container.querySelectorAll("button"))
    .filter(button => button.textContent?.includes("Install"))[1]!;
  await act(async () => { prepareButton.click(); });
  expect(container.textContent).toContain("Browser not found; folder copied");
  expect(container.textContent).toContain("edge://extensions");
});

it("asks before installing into a separate browser and verifies the result", async () => {
  const installManaged = vi.fn(async () => ({ status: "managed-installed" as const, directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    installManaged={installManaged} labels={labels} />));
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!.click();
  });
  expect(installManaged).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Install the extension?");
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Allow and install"))!.click();
  });
  expect(installManaged).toHaveBeenCalledWith("chrome");
  expect(container.textContent).toContain("Installed in separate browser");
  expect(container.textContent).toContain("Ordinary web pages are ready");
  expect(container.textContent).not.toContain("1234:secret");
  expect(container.textContent).not.toContain("Turn on Developer mode and choose Load unpacked.");
  expect(container.textContent).toContain("Extension not installed");
});

it("uses the bundled manual path when the extension is not published", async () => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const,
    directory: "/app/browser-extension" }));
  const installManaged = vi.fn(async () => ({ status: "managed-installed" as const,
    directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined} getExtensionDirectory={async () => "/app/browser-extension"}
    prepareInstall={prepareInstall} installManaged={installManaged} manualOnly labels={labels} />));
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!.click();
  });
  expect(prepareInstall).toHaveBeenCalledWith("chrome");
  expect(installManaged).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Turn on Developer mode and choose Load unpacked.");
});
