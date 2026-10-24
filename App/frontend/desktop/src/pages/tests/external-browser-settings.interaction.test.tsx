// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExternalBrowserSettings } from "../external-browser-settings.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const labels = {
  chrome: "Chrome", edge: "Edge", description: "Ordinary web pages", notInstalled: "Memmy extension is not installed",
  connected: "Ready for web pages", disconnected: "Not connected", install: "Show extension folder",
  copy: "Copy", copied: "Copied", loadError: "Unavailable",
  setupTitle: "Set up", setupIntro: "Load the bundled extension.",
  developerModeStep: "Turn on Developer mode.",
  dragFolderStep: "Drag the entire selected extension folder onto the extensions page.",
  managerStep: "Open the browser extension page", copyAddress: "Copy address",
  unpackedStep: "Turn on Developer mode and choose Load unpacked.",
  folderStep: "Choose the folder containing manifest.json", folderMissing: "Folder missing",
  macFolderHint: "Press Command + Shift + G in the folder picker, paste the path, press Return, then click Select.",
  copyPath: "Copy folder path",
  openPage: "Open extensions page", preparing: "Opening", prepared: "Page requested; connect after adding the extension",
  browserNotFound: "Browser not found; use fallback steps", launchFailed: "Could not open browser; use fallback steps",
  manualGuide: "Drag didn't work? Select the folder step by step",
  installButton: "Install",
  installationUnavailable: "Memmy extension status is unreadable",
  disabled: "Memmy extension is disabled",
  dragCardTitle: "Memmy browser extension", dragCardHint: "Hold the icon and drag",
  installTarget: "Empty area of the browser extensions page you just opened", demo: "Watch demo",
  demoTitle: "Installation demo", demoBack: "Back to installation", demoReplay: "Replay",
  demoInstruction: "Drag from Memmy to the {browser} extensions page",
  demoDescription: "Demo: drag out of Memmy to an empty area of the {browser} extensions page.",
  demoDragging: "Drag out of Memmy", demoRelease: "Release on the browser extensions page",
  demoExtensionsHeading: "Extensions", demoDeveloperMode: "Developer mode",
};

const absentInstallation = async () => ({
  chrome: { installed: false, enabled: false }, edge: { installed: false, enabled: false },
});

let container: HTMLDivElement;
let root: Root;
let clipboardDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;
let animateDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  animateDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
  sessionStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  if (animateDescriptor) Object.defineProperty(HTMLElement.prototype, "animate", animateDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "animate");
  sessionStorage.clear();
});

it("shows the extension as ready after it connects, without a pairing code", async () => {
  const getStatus = vi.fn(async () => ({ connected: ["edge" as const], claims: [
    { browser: "edge" as const, title: "Local test", url: "https://example.test/" },
  ] }));
  const revealExtensionFolder = vi.fn(async () => undefined);
  const getExtensionDirectory = vi.fn(async () => "/Applications/Memmy.app/Contents/Resources/browser-extension");
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation} getStatus={getStatus}
    revealExtensionFolder={revealExtensionFolder} getExtensionDirectory={getExtensionDirectory} labels={labels} />));
  expect(container.textContent).toContain("Ready for web pages");
  expect(container.textContent).not.toContain("Pairing code");
  const edgeRow = Array.from(container.querySelectorAll("strong")).find(node => node.textContent === "Edge")!.parentElement!.parentElement!;
  expect(edgeRow.querySelector("button")?.textContent).toBe("Manage");
  const setup = Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!;
  await act(async () => { setup.click(); });
  expect(container.textContent).toContain("chrome://extensions");
  expect(container.textContent).toContain("manifest.json");
  expect(container.textContent).toContain("/Applications/Memmy.app/Contents/Resources/browser-extension");
  expect(container.textContent).not.toContain("1234:secret");
  expect(getExtensionDirectory).toHaveBeenCalledOnce();
  await act(async () => { container.querySelector("summary")!.click(); });
  expect(container.querySelector("details")!.open).toBe(true);
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Copy address"))!.click();
  });
  expect(writeText).toHaveBeenCalledWith("chrome://extensions");
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Copy folder path"))!.click();
  });
  expect(writeText).toHaveBeenCalledWith("/Applications/Memmy.app/Contents/Resources/browser-extension");
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Show extension folder"))!.click();
  });
  expect(revealExtensionFolder).toHaveBeenCalledOnce();
});

it("shows installed browsers as disconnected until they have a live connection", async () => {
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    getInstallation={async () => ({ chrome: { installed: true, enabled: true }, edge: { installed: true, enabled: true } })}
    revealExtensionFolder={async () => undefined}
    labels={labels} />));
  expect(container.textContent).not.toContain("Ready for web pages");
  expect(container.textContent).toContain("Installed. Waiting for the browser to connect.");
  expect(container.textContent).not.toContain(labels.notInstalled);
  expect(container.textContent).toContain("Edge");
  const installButtons = Array.from(container.querySelectorAll("button")).filter(button => button.textContent === "Reinstall");
  expect(installButtons).toHaveLength(2);
  expect(container.textContent).not.toContain("Check connection");
  expect(container.textContent).not.toContain("Repair connection");
  expect(installButtons.every(button => button.className.includes("primaryButton"))).toBe(true);
  expect(installButtons[0]?.getAttribute("aria-expanded")).toBe("false");
});

it("shows manage for a closed installed browser instead of opening it", async () => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const, directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    getInstallation={async () => ({ chrome: { installed: true, enabled: true }, edge: { installed: false, enabled: false } })}
    getRunning={async () => []}
    revealExtensionFolder={async () => undefined}
    prepareInstall={prepareInstall}
    labels={labels} />));
  const chrome = Array.from(container.querySelectorAll("strong")).find(node => node.textContent === "Chrome")!.parentElement!.parentElement!.parentElement!;
  expect(chrome.textContent).toContain("Installed. Open the browser to connect.");
  expect(chrome.textContent).not.toContain("Open browser");
  expect(chrome.querySelector("button")?.textContent).toBe("Manage");
  await act(async () => { chrome.querySelector("button")!.click(); });
  const actions = Array.from(chrome.querySelectorAll("button")).map(button => button.textContent);
  expect(actions).toEqual(["Done", "Reinstall"]);
  expect(prepareInstall).not.toHaveBeenCalled();
  await act(async () => { Array.from(chrome.querySelectorAll("button")).find(button => button.textContent === "Reinstall")!.click(); });
  expect(prepareInstall).toHaveBeenCalledExactlyOnceWith("chrome");
});

it("shows Edge's address and explains when the bundled extension is missing", async () => {
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    getExtensionDirectory={async () => null}
    platform="darwin"
    labels={labels} />));
  const setup = Array.from(container.querySelectorAll("button")).filter(button => button.textContent?.includes("Install"))[1]!;
  await act(async () => { setup.click(); });
  expect(container.textContent).toContain("edge://extensions");
  expect(container.textContent).toContain("Folder missing");
  expect(container.textContent).not.toContain(labels.macFolderHint);
  expect(container.textContent).not.toContain("Pairing code");
});

it("shows two drag-install steps with directory selection folded away and waits for a connection", async () => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const,
    directory: "C:\\Program Files\\Memmy\\resources\\browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    prepareInstall={prepareInstall}
    platform="win32"
    labels={labels} />));
  expect(container.querySelector("#memmy-chrome-extension-guide")).toBeNull();
  expect(container.querySelector("#memmy-edge-extension-guide")).toBeNull();
  expect(prepareInstall).not.toHaveBeenCalled();
  const prepareButton = Array.from(container.querySelectorAll("button"))
    .find(button => button.textContent?.includes("Install"))!;
  await act(async () => { prepareButton.click(); });
  expect(prepareInstall).toHaveBeenCalledWith("chrome");
  expect(container.querySelector("#memmy-edge-extension-guide")).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  const guide = container.querySelector("#memmy-chrome-extension-guide")!;
  expect(Array.from(guide.querySelectorAll(":scope > ol > li")).map(node => node.textContent)).toEqual([
    labels.developerModeStep, labels.dragFolderStep,
  ]);
  const fallback = guide.querySelector("details")!;
  expect(fallback.open).toBe(false);
  expect(fallback.querySelector("summary")?.textContent).toBe(labels.manualGuide);
  expect(fallback.textContent).toContain(labels.unpackedStep);
  expect(fallback.textContent).not.toContain("Command + Shift + G");
  expect(container.textContent).toContain("C:\\Program Files\\Memmy\\resources\\browser-extension");
  expect(container.textContent).toContain(labels.notInstalled);
  expect(container.textContent).not.toContain(labels.connected);
  expect(writeText).not.toHaveBeenCalled();
});

it("falls back to manual steps when a browser executable is not found", async () => {
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    prepareInstall={async () => ({ status: "browser-not-found", directory: "/app/browser-extension" })}
    labels={labels} />));
  const prepareButton = Array.from(container.querySelectorAll("button"))
    .filter(button => button.textContent?.includes("Install"))[1]!;
  await act(async () => { prepareButton.click(); });
  expect(container.textContent).toContain(labels.browserNotFound);
  expect(container.textContent).toContain("edge://extensions");
  expect(container.textContent).not.toContain(labels.prepared);
  expect(container.textContent).not.toContain(labels.connected);
});

it("keeps the existing browser route and gives the Mac folder picker shortcut in the fallback", async () => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const,
    directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined} getExtensionDirectory={async () => "/app/browser-extension"}
    prepareInstall={prepareInstall} platform="darwin" labels={labels} />));
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!.click();
  });
  expect(prepareInstall).toHaveBeenCalledWith("chrome");
  expect(container.textContent).toContain(labels.dragFolderStep);
  const fallback = container.querySelector("details")!;
  expect(fallback.open).toBe(false);
  expect(fallback.textContent).toContain(labels.macFolderHint);
});

it("hides installation actions and guide after the extension connects", async () => {
  vi.useFakeTimers();
  const getStatus = vi.fn()
    .mockResolvedValueOnce({ connected: [], claims: [] })
    .mockResolvedValueOnce({ connected: ["chrome"], claims: [] })
    .mockResolvedValue({ connected: [], claims: [] });
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={getStatus}
    revealExtensionFolder={async () => undefined}
    prepareInstall={async () => ({ status: "browser-opened", directory: "/app/browser-extension" })}
    dragExtension={() => true}
    labels={labels} />));
  await act(async () => {
    Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!.click();
  });
  expect(container.querySelector("#memmy-chrome-extension-guide")).not.toBeNull();
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === labels.demo)!.click(); });
  expect(container.querySelector('[aria-label="Installation demo"]')).not.toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector("#memmy-chrome-extension-guide")).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(container.textContent).toContain(labels.connected);
  const chromeRow = Array.from(container.querySelectorAll("strong")).find(node => node.textContent === "Chrome")!.parentElement!.parentElement!;
  expect(chromeRow.querySelector("button")?.textContent).toBe("Manage");
  expect(Array.from(container.querySelectorAll("button")).filter(button => button.textContent?.includes("Install"))).toHaveLength(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(container.querySelector("#memmy-chrome-extension-guide")).toBeNull();
  expect(container.querySelector('[role="status"]')).toBeNull();
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!.click(); });
  expect(container.querySelector('[draggable="true"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Installation demo"]')).toBeNull();
});


it("drags the bundled extension through the native bridge and reports native drag failures", async () => {
  const dragExtension = vi.fn(() => true);
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const, directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined} prepareInstall={prepareInstall}
    dragExtension={dragExtension} labels={labels} />));
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("Install"))!.click(); });
  const card = container.querySelector('[draggable="true"]')!;
  expect(card.textContent).toContain("Memmy browser extension");
  expect(card.querySelector("img")?.getAttribute("src")).toContain("memmy-app-icon.png");
  expect(container.textContent).not.toContain(labels.setupIntro);
  expect(dragExtension).not.toHaveBeenCalled();
  const event = new Event("dragstart", { bubbles: true, cancelable: true });
  await act(async () => { card.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  expect(dragExtension).toHaveBeenCalledOnce();
  expect(dragExtension).toHaveBeenCalledWith();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  dragExtension.mockReturnValue(false);
  await act(async () => { card.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true })); });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(labels.loadError);
  expect(container.querySelector("details")!.open).toBe(false);
});

it.each(["chrome", "edge"] as const)("keeps the %s demo separate and returns focus to its entry", async browser => {
  const animations: Array<{ onfinish: (() => void) | null; cancel: ReturnType<typeof vi.fn> }> = [];
  const animate = vi.fn(() => {
    const animation = { onfinish: null as (() => void) | null, cancel: vi.fn() };
    animations.push(animation);
    return animation;
  });
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const dragExtension = vi.fn(() => true);
  const revealExtensionFolder = vi.fn(async () => undefined);
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const, directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={revealExtensionFolder} prepareInstall={prepareInstall}
    dragExtension={dragExtension} labels={labels} />));
  const install = Array.from(container.querySelectorAll("button")).filter(button => button.textContent === labels.installButton)[browser === "chrome" ? 0 : 1]!;
  await act(async () => { install.click(); });
  const guide = container.querySelector(`#memmy-${browser}-extension-guide`)!;
  expect(guide.querySelectorAll('[draggable="true"]')).toHaveLength(1);
  expect(guide.textContent).not.toContain(labels.installTarget);
  const entry = () => Array.from(guide.querySelectorAll("button")).find(button => button.textContent === labels.demo)!;
  await act(async () => { entry().click(); });
  expect(guide.querySelector('[draggable="true"]')).toBeNull();
  expect(guide.querySelector("details")).toBeNull();
  expect(guide.querySelector("input, [contenteditable=true]")).toBeNull();
  expect(guide.textContent).not.toContain("/app/browser-extension");
  expect(guide.textContent).not.toContain(labels.openPage);
  expect(guide.textContent).toContain(`${browser}://extensions`);
  expect(guide.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(labels[browser]);
  const back = Array.from(guide.querySelectorAll("button")).find(button => button.textContent === labels.demoBack)!;
  expect(document.activeElement).toBe(back);
  const replay = Array.from(guide.querySelectorAll("button")).find(button => button.textContent === labels.demoReplay)!;
  expect(replay.disabled).toBe(true);
  await act(async () => { animations[0]!.onfinish!(); });
  expect(replay.disabled).toBe(false);
  await act(async () => { replay.click(); });
  expect(animate).toHaveBeenCalledTimes(2);
  await act(async () => { back.click(); });
  expect(animations[1]!.cancel).toHaveBeenCalled();
  expect(document.activeElement).toBe(entry());
  expect(guide.querySelector('[draggable="true"]')).not.toBeNull();
  expect(guide.querySelector("details")!.open).toBe(false);
  await act(async () => { entry().click(); });
  const outside = Array.from(container.querySelectorAll("button")).find(button =>
    button.textContent === labels.installButton && !guide.contains(button))!;
  outside.focus();
  await act(async () => { outside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(document.activeElement).toBe(entry());
  expect(guide.querySelector('[aria-label="Installation demo"]')).toBeNull();
  expect(prepareInstall).toHaveBeenCalledExactlyOnceWith(browser);
  expect(dragExtension).not.toHaveBeenCalled();
  expect(revealExtensionFolder).not.toHaveBeenCalled();
  expect(writeText).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain(labels.connected);
});

it("shows static demo instructions with reduced motion without disabling replay", async () => {
  const animate = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
  const matchMedia = window.matchMedia.bind(window);
  vi.spyOn(window, "matchMedia").mockImplementation(query => {
    const result = matchMedia(query);
    Object.defineProperty(result, "matches", { value: true });
    return result;
  });
  await act(async () => root.render(<ExternalBrowserSettings getInstallation={absentInstallation}
    getStatus={async () => ({ connected: [], claims: [] })}
    revealExtensionFolder={async () => undefined}
    prepareInstall={async () => ({ status: "browser-opened", directory: "/app/browser-extension" })}
    dragExtension={() => true} labels={labels} />));
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === labels.installButton)!.click(); });
  await act(async () => { Array.from(container.querySelectorAll("button")).find(button => button.textContent === labels.demo)!.click(); });
  const replay = Array.from(container.querySelectorAll("button")).find(button => button.textContent === labels.demoReplay)!;
  expect(container.querySelector('[role="status"]')?.textContent).toBe(labels.demoRelease);
  expect(replay.disabled).toBe(false);
  await act(async () => { replay.click(); });
  expect(animate).not.toHaveBeenCalled();
  expect(replay.disabled).toBe(false);
});

function browserRow(name: string): HTMLElement {
  return Array.from(container.querySelectorAll("strong")).find(node => node.textContent === name)!.parentElement!.parentElement!.parentElement!;
}

it.each(["darwin", "win32"])("keeps unreadable and absent extension states separate on %s", async platform => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const, directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    getInstallation={async () => ({ chrome: { installed: null, enabled: null }, edge: { installed: false, enabled: false } })}
    getRunning={async () => ["chrome", "edge"]}
    revealExtensionFolder={async () => undefined} prepareInstall={prepareInstall} platform={platform} labels={labels} />));
  expect(browserRow("Chrome").textContent).toContain(labels.installationUnavailable);
  expect(browserRow("Chrome").textContent).not.toContain(labels.notInstalled);
  expect(browserRow("Chrome").querySelector("button")?.textContent).toBe("Manage");
  expect(browserRow("Edge").textContent).toContain(labels.notInstalled);
  expect(browserRow("Edge").querySelector("button")?.textContent).toBe("Install");
  expect(prepareInstall).not.toHaveBeenCalled();
  await act(async () => { browserRow("Chrome").querySelector("button")!.click(); });
  expect(prepareInstall).toHaveBeenCalledExactlyOnceWith("chrome");
  expect(browserRow("Chrome").textContent).toContain("chrome://extensions");
});

it.each(["darwin", "win32"])("offers management for disabled and unknown enabled states on %s", async platform => {
  const prepareInstall = vi.fn(async () => ({ status: "browser-opened" as const, directory: "/app/browser-extension" }));
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: [], claims: [] })}
    getInstallation={async () => ({ chrome: { installed: true, enabled: false }, edge: { installed: true, enabled: null } })}
    getRunning={async () => []}
    revealExtensionFolder={async () => undefined} prepareInstall={prepareInstall} platform={platform} labels={labels} />));
  expect(browserRow("Chrome").textContent).toContain(labels.disabled);
  expect(browserRow("Edge").textContent).toContain(labels.installationUnavailable);
  expect(container.textContent).not.toContain(labels.notInstalled);
  expect(container.textContent).not.toContain("Connecting automatically");
  expect(container.textContent).not.toContain("Open the browser to connect");
  expect(Array.from(container.querySelectorAll("button")).map(button => button.textContent)).toEqual(["Manage", "Manage"]);
  expect(prepareInstall).not.toHaveBeenCalled();
});

it.each(["darwin", "win32"])("uses live connections ahead of unreadable or disabled metadata on %s", async platform => {
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: ["chrome", "edge"], claims: [] })}
    getInstallation={async () => ({ chrome: { installed: null, enabled: null }, edge: { installed: true, enabled: false } })}
    getRunning={async () => []}
    revealExtensionFolder={async () => undefined} platform={platform} labels={labels} />));
  for (const name of ["Chrome", "Edge"]) expect(browserRow(name).textContent).toContain(labels.connected);
  expect(container.textContent).not.toContain(labels.installationUnavailable);
  expect(container.textContent).not.toContain(labels.disabled);
  expect(container.textContent).not.toContain(labels.notInstalled);
});

it.each(["darwin", "win32"])("recovers from installation read failures without claiming absence on %s", async platform => {
  vi.useFakeTimers();
  const available = { chrome: { installed: true, enabled: true }, edge: { installed: true, enabled: true } };
  const getInstallation = vi.fn().mockResolvedValueOnce(available)
    .mockRejectedValueOnce(new Error("EPERM")).mockResolvedValue(available);
  const getStatus = vi.fn().mockResolvedValue({ connected: [], claims: [] });
  const getRunning = vi.fn().mockResolvedValue(["chrome", "edge"]);
  await act(async () => root.render(<ExternalBrowserSettings getStatus={getStatus}
    getInstallation={getInstallation} getRunning={getRunning}
    revealExtensionFolder={async () => undefined} platform={platform} labels={labels} />));
  expect(browserRow("Chrome").textContent).toContain("Connecting automatically");
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(browserRow("Chrome").textContent).toContain(labels.installationUnavailable);
  expect(container.textContent).not.toContain(labels.notInstalled);
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(browserRow("Chrome").textContent).toContain("Connecting automatically");
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(browserRow("Chrome").textContent).toContain("Connection has not recovered");
  expect(container.textContent).not.toContain("Check connection");
  expect(container.textContent).not.toContain("Repair connection");
  getStatus.mockResolvedValue({ connected: ["chrome"], claims: [] });
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(browserRow("Chrome").textContent).toContain(labels.connected);
  getStatus.mockResolvedValue({ connected: [], claims: [] });
  getRunning.mockResolvedValue([]);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(browserRow("Chrome").textContent).toContain("Open the browser to connect");
  expect(browserRow("Chrome").querySelector("button")?.textContent).toBe("Manage");
});

it("leaves a stalled installation probe unknown while preserving a live connection", async () => {
  vi.useFakeTimers();
  await act(async () => root.render(<ExternalBrowserSettings
    getStatus={async () => ({ connected: ["chrome"], claims: [] })}
    getInstallation={() => new Promise(() => undefined)}
    revealExtensionFolder={async () => undefined} labels={labels} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  expect(browserRow("Chrome").textContent).toContain(labels.connected);
  expect(browserRow("Edge").textContent).toContain(labels.installationUnavailable);
  expect(container.textContent).not.toContain(labels.notInstalled);
});
