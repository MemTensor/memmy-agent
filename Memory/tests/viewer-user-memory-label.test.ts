// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { locale, t } from "../viewer/src/stores/i18n.js";
import { userMemoryTypeLabel } from "../viewer/src/views/user-memory-label.js";

describe("Viewer user memory type labels", () => {
  afterEach(() => {
    locale.value = "zh";
  });

  it("uses the same Chinese labels as Memmy", () => {
    locale.value = "zh";
    expect(userMemoryTypeLabel("User Fact", t)).toBe("用户事实");
    expect(userMemoryTypeLabel("User Preference", t)).toBe("用户偏好");
    expect(userMemoryTypeLabel("User Directive", t)).toBe("用户指令");
  });

  it("keeps localized English labels in English mode", () => {
    locale.value = "en";
    expect(userMemoryTypeLabel("User Fact", t)).toBe("User fact");
  });
});
