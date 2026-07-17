/** Browser update fallback tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareUpdateVersions,
  parseBrowserUpdateManifest,
  readBrowserUpdateManifestUrl
} from "../browser-update.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("browser update fallback", () => {
  it("builds the cloud manifest request from the configured service", () => {
    vi.stubEnv("MEMMY_CLOUD_SERVICE", "https://updates.example.com/");
    vi.stubEnv("MEMMY_PACKAGE_SIGNING", "unsigned");

    const manifestUrl = readBrowserUpdateManifestUrl("1.4.2");
    expect(manifestUrl).not.toBeNull();
    const url = new URL(manifestUrl!);
    expect(url.origin).toBe("https://updates.example.com");
    expect(url.pathname).toBe("/api/memmy/desktop/latest");
    expect(url.searchParams.get("version")).toBe("1.4.2");
    expect(url.searchParams.get("platformType")).toMatch(/-(cn|intl)-unsigned$/u);
  });

  it("normalizes available and force-update manifest fields", () => {
    const result = parseBrowserUpdateManifest({
      code: 0,
      data: {
        version: "2.0.0",
        minSupportedVersion: "1.5.0",
        updateMode: "silent",
        releaseNotes: "Important fixes",
        downloads: {
          fallback: "https://updates.example.com/Memmy.dmg"
        }
      }
    }, "1.4.2");

    expect(result).toEqual({
      status: "available",
      currentVersion: "1.4.2",
      latestVersion: "2.0.0",
      minSupportedVersion: "1.5.0",
      updateMode: "silent",
      force: true,
      downloadUrl: "https://updates.example.com/Memmy.dmg",
      releaseNotes: "Important fixes"
    });
  });

  it("returns latest for equal or older remote versions and rejects failed envelopes", () => {
    expect(parseBrowserUpdateManifest({ code: 0, data: { version: "1.4.2" } }, "1.4.2")).toEqual({
      status: "latest",
      currentVersion: "1.4.2",
      latestVersion: "1.4.2"
    });
    expect(compareUpdateVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(() => parseBrowserUpdateManifest({ code: 500, data: {} }, "1.4.2"))
      .toThrow("update manifest response code is not ok");
  });
});
