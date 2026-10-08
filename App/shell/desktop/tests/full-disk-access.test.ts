import { describe, expect, it, vi } from "vitest";
import { hasFullDiskAccess } from "../src/main/full-disk-access.js";

const denied = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
const missing = Object.assign(new Error("no such file"), { code: "ENOENT" });

describe("Full Disk Access probe", () => {
  it("does not touch protected files off macOS", async () => {
    const probe = vi.fn(async () => undefined);
    await expect(hasFullDiskAccess({ platform: "win32", paths: ["/protected"], probe })).resolves.toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });

  it("treats a readable protected file as granted", async () => {
    const probe = vi.fn(async () => undefined);
    await expect(hasFullDiskAccess({ platform: "darwin", paths: ["/tcc.db"], probe })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledExactlyOnceWith("/tcc.db");
  });

  it("treats a permission error as not granted and does not continue", async () => {
    const probe = vi.fn(async () => { throw denied; });
    await expect(hasFullDiskAccess({
      platform: "darwin", paths: ["/tcc.db", "/bookmarks"], probe,
    })).resolves.toBe(false);
    expect(probe).toHaveBeenCalledExactlyOnceWith("/tcc.db");
  });

  it("skips a missing path and accepts the next readable one", async () => {
    const probe = vi.fn(async (path: string) => {
      if (path === "/tcc.db") throw missing;
    });
    await expect(hasFullDiskAccess({
      platform: "darwin", paths: ["/tcc.db", "/bookmarks"], probe,
    })).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("stays denied when every probe path is missing", async () => {
    const probe = vi.fn(async () => { throw missing; });
    await expect(hasFullDiskAccess({ platform: "darwin", paths: ["/tcc.db"], probe })).resolves.toBe(false);
  });
});
