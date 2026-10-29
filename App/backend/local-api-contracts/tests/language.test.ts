import { describe, expect, it } from "vitest";
import { LanguageSchema, normalizeOutputLanguage, resolveMemoryLanguage } from "../src/index.js";

describe("normalizeOutputLanguage", () => {
  it("canonicalizes concrete future output languages without enabling untranslated App UI locales", () => {
    expect(normalizeOutputLanguage(" ja-jp ")).toBe("ja-JP");
    expect(normalizeOutputLanguage("fr-fr")).toBe("fr-FR");
    expect(normalizeOutputLanguage("pt-br")).toBe("pt-BR");
    expect(normalizeOutputLanguage("zh-hant-tw")).toBe("zh-Hant-TW");
    expect(normalizeOutputLanguage("iw-il")).toBe("he-IL");
    expect(LanguageSchema.safeParse("ja-JP").success).toBe(false);
  });

  it.each([undefined, null, 42, {}, "", "  ", "system", "SYSTEM", "default", "auto",
    "not a locale", "en_US", "made-up", "und", "mul", "zxx", "qaa", "qps-ploc", "en-XA", "ar-XB"])(
    "rejects settings sentinels, invalid tags and pseudo-locales: %s", (value) => {
      expect(normalizeOutputLanguage(value)).toBeUndefined();
    });
});

describe("resolveMemoryLanguage", () => {
  it("keeps an explicit interface language", () => {
    expect(resolveMemoryLanguage("zh-CN", "email")).toBe("zh-CN");
    expect(resolveMemoryLanguage("en-US", "phone")).toBe("en-US");
  });

  it("preserves future explicit App output languages instead of replacing them with the package default", () => {
    expect(resolveMemoryLanguage("ja-JP", "phone")).toBe("ja-JP");
    expect(resolveMemoryLanguage("fr-fr", "email")).toBe("fr-FR");
  });

  it("maps system and unset language to the package channel default", () => {
    expect(resolveMemoryLanguage("system")).toBe("zh-CN");
    expect(resolveMemoryLanguage(undefined, "phone")).toBe("zh-CN");
    expect(resolveMemoryLanguage("system", "email")).toBe("en-US");
    expect(resolveMemoryLanguage(undefined, "email")).toBe("en-US");
  });
});
