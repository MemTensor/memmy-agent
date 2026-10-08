import { describe, expect, it } from "vitest";
import { migrateLegacyBrowserHistory, normalizeBrowserAddress, readBrowserPreferences } from "../browser-panel.js";

describe("built-in browser address and profile state", () => {
  it("opens local development addresses over HTTP and public addresses over HTTPS", () => {
    expect(normalizeBrowserAddress("localhost:3000/settings")).toBe("http://localhost:3000/settings");
    expect(normalizeBrowserAddress("127.0.0.1:4173/")).toBe("http://127.0.0.1:4173/");
    expect(normalizeBrowserAddress("example.com/path")).toBe("https://example.com/path");
    expect(normalizeBrowserAddress("https://example.com/a?q=1#part")).toBe("https://example.com/a?q=1#part");
  });

  it("rejects script, file and unsupported address schemes", () => {
    expect(normalizeBrowserAddress("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserAddress("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserAddress("data:text/html,hello")).toBeNull();
  });

  it("preserves preference defaults", () => {
    const storage = { getItem: () => JSON.stringify({ webLinks: "memmy", localLinks: "unknown", showFullUrl: true }) };
    expect(readBrowserPreferences(storage)).toEqual({ webLinks: "memmy", localLinks: "memmy", showFullUrl: true });
  });

  it('removes legacy history only after a successful host import', async () => {
    const raw = JSON.stringify([{ url: 'https://example.com/', title: 'Old visit', visitedAt: 10 }]);
    let saved: string | null = raw;
    const storage = { getItem: () => saved, removeItem: () => { saved = null; } };
    const importEntries = async () => false;
    expect(await migrateLegacyBrowserHistory(storage, importEntries)).toBe(false);
    expect(saved).toBe(raw);
    expect(await migrateLegacyBrowserHistory(storage, async entries => {
      expect(entries).toEqual(JSON.parse(raw));
      return true;
    })).toBe(true);
    expect(saved).toBeNull();
  });

  it('keeps oversize legacy data local without sending it to the host', async () => {
    const raw = JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ url: `https://example.com/${i}`,
      title: 'Example', visitedAt: i })));
    const storage = { getItem: () => raw, removeItem: () => { throw new Error('unexpected removal'); } };
    let called = false;
    expect(await migrateLegacyBrowserHistory(storage, async () => { called = true; return true; })).toBe(false);
    expect(called).toBe(false);
  });

});
