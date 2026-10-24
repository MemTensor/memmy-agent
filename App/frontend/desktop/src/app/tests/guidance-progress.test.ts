import { describe, expect, it } from "vitest";
import {
  clearDeferredGuidanceStep,
  GUIDANCE_PROGRESS_STORAGE_KEY,
  readDeferredGuidanceStep,
  readGuidanceCompleted,
  writeDeferredGuidanceStep,
  writeGuidanceCompleted,
} from "../routes.js";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe("deferred guidance progress", () => {
  it("restores unfinished guidance after session storage is lost on restart", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    writeDeferredGuidanceStep(session, "product_tour", local);
    session.clear();

    expect(readDeferredGuidanceStep(session, local)).toBe("product_tour");
    expect(readDeferredGuidanceStep(new MemoryStorage(), local)).toBe("product_tour");
  });

  it("uses the latest persisted step across windows with older session state", () => {
    const local = new MemoryStorage();
    const firstWindow = new MemoryStorage();
    const secondWindow = new MemoryStorage();
    writeDeferredGuidanceStep(firstWindow, "product_tour", local);
    writeDeferredGuidanceStep(secondWindow, "nickname", local);

    expect(readDeferredGuidanceStep(firstWindow, local)).toBe("nickname");
    expect(readDeferredGuidanceStep(secondWindow, local)).toBe("nickname");
  });

  it.each(["unexpected", "", "{\"step\":\"product_tour\"}"])(
    "falls back to the legacy session step for invalid persistent progress %j",
    (invalid) => {
      const local = new MemoryStorage();
      const session = new MemoryStorage();
      session.setItem("memmy.deferredGuidanceStep", "product_tour");
      local.setItem(GUIDANCE_PROGRESS_STORAGE_KEY, invalid);

      expect(readDeferredGuidanceStep(session, local)).toBe("product_tour");
    },
  );

  it("finishing guidance overrides stale pending session state in other windows", () => {
    const local = new MemoryStorage();
    const oldWindow = new MemoryStorage();
    writeDeferredGuidanceStep(oldWindow, "product_tour", local);

    writeGuidanceCompleted(local);

    expect(readGuidanceCompleted(local)).toBe(true);
    expect(readDeferredGuidanceStep(oldWindow, local)).toBeNull();
    expect(readDeferredGuidanceStep(new MemoryStorage(), local)).toBeNull();
  });

  it("clearing guidance keeps its completion authoritative over another window's old session", () => {
    const local = new MemoryStorage();
    const firstWindow = new MemoryStorage();
    const oldWindow = new MemoryStorage();
    writeDeferredGuidanceStep(oldWindow, "product_tour", local);
    writeDeferredGuidanceStep(firstWindow, "nickname", local);

    clearDeferredGuidanceStep(firstWindow, local);

    expect(readDeferredGuidanceStep(firstWindow, local)).toBeNull();
    expect(readDeferredGuidanceStep(oldWindow, local)).toBeNull();
    expect(readDeferredGuidanceStep(new MemoryStorage(), local)).toBeNull();
  });

  it("preserves a legacy completion mark without replaying guidance after an upgrade", () => {
    const local = new MemoryStorage();
    const oldWindow = new MemoryStorage();
    local.setItem("memmy.guidanceCompleted", "1");
    oldWindow.setItem("memmy.deferredGuidanceStep", "product_tour");

    expect(readGuidanceCompleted(local)).toBe(true);
    expect(readDeferredGuidanceStep(oldWindow, local)).toBeNull();
    expect(readDeferredGuidanceStep(new MemoryStorage(), local)).toBeNull();
  });

  it("keeps explicitly started guidance active despite a legacy completion mark", () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem("memmy.guidanceCompleted", "1");
    writeDeferredGuidanceStep(session, "product_tour", local);

    expect(readDeferredGuidanceStep(session, local)).toBe("product_tour");
  });

  it("retains the legacy session-only API for storage without a persistent layer", () => {
    const session = new MemoryStorage();
    writeDeferredGuidanceStep(session, "armed");
    expect(readDeferredGuidanceStep(session)).toBe("armed");

    clearDeferredGuidanceStep(session);
    expect(readDeferredGuidanceStep(session)).toBeNull();
  });
});
