import { describe, expect, it } from "vitest";
import { isMacNativeRuntimeSupported } from "../../../src/tools/computer-use/mac-native-runtime-support.js";

describe("optional macOS native helper compatibility", () => {
  it.each([["21.6.0", false], ["22.6.0", false], ["23.0.0", true], ["24.6.0", true], ["26.0.0", true], ["", false]])(
    "handles Darwin %s without invoking a native helper", (release, supported) => {
      expect(isMacNativeRuntimeSupported("darwin", release)).toBe(supported);
    },
  );
  it("leaves other platforms to their own compatibility checks", () => {
    expect(isMacNativeRuntimeSupported("win32", "10.0.26100")).toBe(true);
    expect(isMacNativeRuntimeSupported("linux", "6.8.0")).toBe(true);
  });
});
