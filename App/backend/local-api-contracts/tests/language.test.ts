import { describe, expect, it } from "vitest";
import { resolveMemoryLanguage } from "../src/index.js";

describe("resolveMemoryLanguage", () => {
  it("keeps an explicit interface language", () => {
    expect(resolveMemoryLanguage("zh-CN", "email")).toBe("zh-CN");
    expect(resolveMemoryLanguage("en-US", "phone")).toBe("en-US");
  });

  it("maps system and unset language to the package channel default", () => {
    expect(resolveMemoryLanguage("system")).toBe("zh-CN");
    expect(resolveMemoryLanguage(undefined, "phone")).toBe("zh-CN");
    expect(resolveMemoryLanguage("system", "email")).toBe("en-US");
    expect(resolveMemoryLanguage(undefined, "email")).toBe("en-US");
  });
});
