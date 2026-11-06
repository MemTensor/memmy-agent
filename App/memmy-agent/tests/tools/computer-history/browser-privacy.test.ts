import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_AUTHORITY_MAX_AGE_MS, addressBarUrlFromTree, bridgeBrowserId,
  buildBrowserAuthoritySnapshot, defaultBrowserAuthorityPath, isPrivateBrowsingTitle,
  readBrowserAuthority, resolveBrowserContext, sanitizeBrowserUrl, treeHasPrivateControl,
  writeBrowserAuthority, type BrowserFocusObservation, type BrowserContextInput,
} from "../../../src/tools/computer-history/browser-privacy.js";

const now = 100_000;
function row(role: string, name = "", value = ""): string {
  return `${role}||${name}||view_1|${value}`;
}
function focus(overrides: Partial<BrowserFocusObservation> = {}): BrowserFocusObservation {
  return { connectionId: "profile-1", browser: "chrome", focused: true, tabId: 7, windowId: 3,
    title: "Shop", url: "https://shop.example/product?tracking=1", mode: "normal",
    observedAt: now, receivedAt: now, ...overrides };
}
function normal(overrides: Partial<BrowserContextInput> = {}): BrowserContextInput {
  return { browserName: "chrome", title: "Shop - Google Chrome", axText: "", now,
    windowId: "1234", processId: 20,
    nativeContext: { url: "https://shop.example/product", mode: "normal", complete: true,
      windowId: "1234", processId: 20 }, ...overrides };
}

it("recognizes private title markers across browsers/locales without matching guest checkout", () => {
  for (const title of ["Example - [InPrivate] - Microsoft Edge", "Example - [访客]", "无痕模式 - Chrome",
    "Navigation privée - exemple", "[ゲスト] - Chrome", "[guest] - Chrome"]) {
    expect(isPrivateBrowsingTitle(title)).toBe(true);
  }
  expect(isPrivateBrowsingTitle("Guest checkout - Shop - Chrome")).toBe(false);
  expect(isPrivateBrowsingTitle("")).toBe(false);
});

it("excludes private/guest indicators including Chrome's English Guest profile button", () => {
  for (const name of ["无痕模式", "Incognito", "Guest", "guest profile", "访客", "ゲスト"]) {
    expect(treeHasPrivateControl(row("ControlType.Button", name))).toBe(true);
  }
  expect(treeHasPrivateControl(row("ControlType.Text", "What is incognito mode?"))).toBe(false);
  expect(treeHasPrivateControl(row("ControlType.Button", "Continue as guest"))).toBe(false);
});

it("sanitizes only http(s) addresses and removes query, fragment and credentials", () => {
  expect(sanitizeBrowserUrl("https://user:pass@example.com/a?q=1#top")).toBe("https://example.com/a");
  expect(sanitizeBrowserUrl("taobao.com")).toBe("https://taobao.com/");
  for (const value of ["chrome://settings", "录音卡", ""]) expect(sanitizeBrowserUrl(value)).toBe("");
});

it("never takes an arbitrary page URL input as the browser address", () => {
  expect(addressBarUrlFromTree(row("ControlType.Edit", "Website", "https://allowed.example/"))).toBe("");
  expect(addressBarUrlFromTree(row("ControlType.Edit", "URL", "https://allowed.example/"))).toBe("");
  expect(addressBarUrlFromTree(row("ControlType.Edit", "地址和搜索栏", "s.taobao.com/search?q=1")))
    .toBe("https://s.taobao.com/search");
});

it("maps supported extension browser process names", () => {
  expect(bridgeBrowserId("chrome.exe")).toBe("chrome");
  expect(bridgeBrowserId("win32.msedge")).toBe("edge");
  expect(bridgeBrowserId("firefox")).toBeNull();
});

describe("window-bound browser capture", () => {
  it.each(["", row("ControlType.Edit", "Address and search bar", "https://allowed.example/"),
    row("ControlType.Button", "您"), row("ControlType.Edit", "URL", "https://allowed.example/")])("never proves normal mode from a flat/empty/page-controlled tree: %s", axText => {
      const result = resolveBrowserContext(normal({ axText, nativeContext: undefined }));
      expect(result).toEqual({ private: null, url: "", source: "unknown" });
    });

  it("rejects a legacy extension URL instead of vouching for a different foreground window", () => {
    const result = resolveBrowserContext(normal({ nativeContext: undefined, authority: {
      updatedAt: now, browsers: { chrome: { connected: true, activeUrl: "https://allowed.example/" } },
    } }));
    expect(result.private).toBeNull();
    expect(result.url).toBe("");
  });

  it("requires complete chrome proof bound to this native window and process", () => {
    const base = normal();
    for (const nativeContext of [
      { ...base.nativeContext!, complete: false }, { ...base.nativeContext!, mode: "unknown" as const },
      { ...base.nativeContext!, windowId: "other-window" }, { ...base.nativeContext!, processId: 21 },
      { ...base.nativeContext!, url: "chrome://settings" },
    ]) expect(resolveBrowserContext({ ...base, nativeContext })).toMatchObject({ private: null, url: "" });
    expect(resolveBrowserContext(base)).toEqual({ private: false, url: "https://shop.example/product", source: "native_context" });
  });

  it("does not permit fresh extension focus to authorize an unknown native browser window", () => {
    const result = resolveBrowserContext(normal({ nativeContext: { ...normal().nativeContext!, mode: "unknown" },
      authority: buildBrowserAuthoritySnapshot(["chrome"], [focus()], now) }));
    expect(result).toMatchObject({ private: null, url: "", source: "unknown" });
  });

  it("excludes a newly forbidden foreground page despite the prior allowed extension URL", () => {
    const result = resolveBrowserContext(normal({ nativeContext: {
      ...normal().nativeContext!, url: "https://company.example/private" },
      authority: buildBrowserAuthoritySnapshot(["chrome"], [focus()], now) }));
    expect(result).toEqual({ private: null, url: "", source: "extension_mismatch" });
  });

  it("uses extension corroboration only when native normal chrome URL matches", () => {
    expect(resolveBrowserContext(normal({ authority: buildBrowserAuthoritySnapshot(["chrome"], [focus()], now) })))
      .toEqual({ private: false, url: "https://shop.example/product", source: "extension" });
  });

  it("private/guest evidence always wins over normal native/extension information", () => {
    const authority = buildBrowserAuthoritySnapshot(["chrome"], [focus()], now);
    expect(resolveBrowserContext(normal({ title: "Shop - [Incognito]", authority }))).toMatchObject({ private: true, url: "" });
    expect(resolveBrowserContext(normal({ axText: row("ControlType.Button", "Guest"), authority })))
      .toMatchObject({ private: true, url: "" });
    expect(resolveBrowserContext(normal({ nativeContext: { ...normal().nativeContext!, mode: "private" }, authority })))
      .toMatchObject({ private: true, url: "" });
    expect(resolveBrowserContext(normal({ authority: buildBrowserAuthoritySnapshot(["chrome"], [focus({ mode: "private" })], now) })))
      .toMatchObject({ private: true, url: "" });
    expect(resolveBrowserContext(normal({ authority: buildBrowserAuthoritySnapshot(["chrome"], [focus({ mode: "unknown" })], now) })))
      .toMatchObject({ private: null, url: "" });
  });
});

describe("browser authority lifetime and profile identity", () => {
  const made: string[] = [];
  afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
  const file = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-authority-")); made.push(dir);
    return path.join(dir, "browser-authority.json");
  };

  it("retains real observation time and never re-freshens stale focus when rewriting the file", () => {
    const stale = focus({ observedAt: now - BROWSER_AUTHORITY_MAX_AGE_MS - 1, receivedAt: now - 1 });
    expect(buildBrowserAuthoritySnapshot(["chrome"], [stale], now).browsers.chrome?.focusedTab).toBeNull();
    const fresh = buildBrowserAuthoritySnapshot(["chrome"], [focus()], now + 100);
    expect(fresh.browsers.chrome?.focusedTab?.observedAt).toBe(now);
    expect(fresh.browsers.chrome?.activeUrl).toBeNull();
  });

  it("does not choose by array order when two Chrome profiles both report focus", () => {
    const observations = [focus(), focus({ connectionId: "profile-2", tabId: 8, windowId: 4 })];
    expect(buildBrowserAuthoritySnapshot(["chrome"], observations, now).browsers.chrome?.focusedTab).toBeNull();
    expect(buildBrowserAuthoritySnapshot(["chrome"], observations.reverse(), now).browsers.chrome?.focusedTab).toBeNull();
  });

  it("ignores a background tab and requires tab/window identity and sane timestamps", () => {
    for (const invalid of [focus({ focused: false }), focus({ tabId: null }), focus({ windowId: null }),
      focus({ observedAt: now + 100_000 }), focus({ observedAt: NaN }), focus({ receivedAt: 0 })]) {
      expect(buildBrowserAuthoritySnapshot(["chrome"], [invalid], now).browsers.chrome?.focusedTab).toBeNull();
    }
  });

  it("round-trips valid focus while sanitizing URL and rejecting stale/future/legacy snapshots", () => {
    const target = file();
    writeBrowserAuthority(target, buildBrowserAuthoritySnapshot(["chrome"], [focus()], now));
    expect(readBrowserAuthority(target, now)?.browsers.chrome?.focusedTab).toMatchObject({
      connectionId: "profile-1", tabId: 7, windowId: 3, url: "https://shop.example/product", observedAt: now,
    });
    expect(readBrowserAuthority(target, now + BROWSER_AUTHORITY_MAX_AGE_MS + 1)).toBeNull();
    writeBrowserAuthority(target, { version: 2, updatedAt: now + 100_000, browsers: {} });
    expect(readBrowserAuthority(target, now)).toBeNull();
    writeBrowserAuthority(target, { updatedAt: now, browsers: { chrome: { connected: true, activeUrl: "https://x/" } } });
    expect(readBrowserAuthority(target, now)).toBeNull();
    fs.writeFileSync(target, "{ not json");
    expect(readBrowserAuthority(target, now)).toBeNull();
  });

  it("does not keep a source-stale focused tab in a newly written snapshot", () => {
    const target = file();
    writeBrowserAuthority(target, { version: 2, updatedAt: now,
      browsers: { chrome: { connected: true, focusedTab: focus({ observedAt: now - 10_000 }) } } });
    expect(readBrowserAuthority(target, now)?.browsers.chrome?.focusedTab).toBeNull();
  });

  it("redacts focus content for private or unclassified pages", () => {
    for (const mode of ["private", "unknown"] as const) {
      const tab = buildBrowserAuthoritySnapshot(["chrome"], [focus({ mode, title: "secret", url: "https://secret.example/" })], now)
        .browsers.chrome?.focusedTab;
      expect(tab).toMatchObject({ mode, url: "", title: "" });
    }
  });

  it("derives the authority path under MEMMY_HOME", () => {
    const previous = process.env.MEMMY_HOME;
    try {
      process.env.MEMMY_HOME = "/tmp/memmy-home-probe";
      expect(defaultBrowserAuthorityPath()).toBe(path.join("/tmp/memmy-home-probe", "computer-history", "browser-authority.json"));
    } finally {
      if (previous === undefined) delete process.env.MEMMY_HOME; else process.env.MEMMY_HOME = previous;
    }
  });
});
