/** Local data service tests. */
import { describe, expect, it } from "vitest";
import { createLocalDataService } from "../local-data-service.js";

describe("LocalDataService", () => {
  it("reveals, exports, and clears through the local data store", async () => {
    const calls: string[] = [];
    const service = createLocalDataService({
      now: () => new Date("2026-06-02T10:00:00.000Z"),
      localDataStore: {
        getDataPath() {
          calls.push("path");
          return "/tmp/memmy-data";
        },
        revealDataPath(dataPath) {
          calls.push(`reveal:${dataPath}`);
        },
        exportData(input) {
          calls.push(`export:${input.targetPath}`);
          return { exportPath: "/tmp/export/memmy-export-1", bytes: 128 };
        },
        clearMemoryDatabase(clearedAt) {
          calls.push(`clear:${clearedAt}`);
        }
      }
    });

    await expect(service.reveal()).resolves.toEqual({ ok: true, dataPath: "/tmp/memmy-data" });
    await expect(service.export({ targetPath: "/tmp/export" })).resolves.toEqual({
      exportPath: "/tmp/export/memmy-export-1",
      bytes: 128
    });
    await expect(service.clear({ confirm: true })).resolves.toEqual({
      ok: true,
      clearedAt: "2026-06-02T10:00:00.000Z"
    });
    expect(calls).toEqual(["path", "reveal:/tmp/memmy-data", "export:/tmp/export", "clear:2026-06-02T10:00:00.000Z"]);
  });
});
