/** Memory panel cache tests. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMemoryPanelCache, memoryPanelCacheKey, readMemoryPanelCache, writeMemoryPanelCache } from "../memory-panel-cache.js";

describe("memory panel cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("discards fresh previews cached before source-envelope filtering", () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    const key = memoryPanelCacheKey("memories", "latest");
    storage.setItem(`memmy.memory-panel.${key}`, JSON.stringify({
      version: 1, savedAt: new Date().toISOString(),
      data: { sourceText: '<in-app-browser-context source="ambient-ui-state">' }
    }));
    expect(readMemoryPanelCache(key)).toBeNull();
    expect(storage.getItem(`memmy.memory-panel.${key}`)).toBeNull();
    writeMemoryPanelCache(key, { sourceText: "请修复标题" });
    expect(readMemoryPanelCache(key)).toEqual({ sourceText: "请修复标题" });
  });

  it("clears only memory panel cache entries", () => {
    const storage = createMemoryStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    writeMemoryPanelCache(memoryPanelCacheKey("overview"), { counts: { memories: 1 } });
    storage.setItem("unrelated", "keep");

    clearMemoryPanelCache();

    expect(readMemoryPanelCache(memoryPanelCacheKey("overview"))).toBeNull();
    expect(storage.getItem("unrelated")).toBe("keep");
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}
