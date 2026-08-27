import { describe, expect, it } from "vitest";
import {
  cloudServiceFromDesktopRuntimeManifest,
  normalizePublicCloudService,
} from "../src/desktop-runtime-manifest.js";

describe("desktop runtime manifest", () => {
  it("normalizes the single public cloud-service origin", () => {
    expect(normalizePublicCloudService(" https://api.example.test/ ")).toBe(
      "https://api.example.test",
    );
    expect(
      cloudServiceFromDesktopRuntimeManifest(
        JSON.stringify({ edition: "cn", cloudService: "https://api.example.test" }),
      ),
    ).toBe("https://api.example.test");
  });

  it.each([
    "",
    "http://api.example.test",
    "https://user:password@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?token=secret",
    "https://api.example.test/#secret",
  ])("rejects a non-public runtime value without echoing it: %s", (value) => {
    expect(() => normalizePublicCloudService(value)).toThrow(/MEMMY_CLOUD_SERVICE/);
    try {
      normalizePublicCloudService(value);
    } catch (error) {
      if (value) expect(String(error)).not.toContain(value);
    }
  });

  it("rejects invalid or missing manifest data", () => {
    expect(() => cloudServiceFromDesktopRuntimeManifest("not-json")).toThrow(/valid JSON/);
    expect(() => cloudServiceFromDesktopRuntimeManifest("[]")).toThrow(/JSON object/);
    expect(() => cloudServiceFromDesktopRuntimeManifest("{}"))
      .toThrow(/MEMMY_CLOUD_SERVICE/);
  });
});
