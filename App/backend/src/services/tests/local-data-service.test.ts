/** Local data service tests. */
import { describe, expect, it } from "vitest";
import { createLocalDataService } from "../local-data-service.js";
import type { MemoryClient } from "../../adapters/outbound/memory-client/index.js";

describe("LocalDataService", () => {
  it("returns the local data path without revealing it", async () => {
    const calls: string[] = [];
    const service = createLocalDataService({
      memoryClient: {} as MemoryClient,
      localDataStore: {
        getDataPath() {
          calls.push("path");
          return "C:\\Users\\memmy-user\\.memmy\\memory-service";
        },
        revealDataPath(dataPath) {
          calls.push(`reveal:${dataPath}`);
        },
        exportData() {
          return { exportPath: "/tmp/export/memmy-export-1", bytes: 128 };
        },
        clearImportState() {
          calls.push("clear");
        }
      }
    });

    await expect(service.getPath()).resolves.toEqual({
      ok: true,
      dataPath: "C:\\Users\\memmy-user\\.memmy\\memory-service"
    });
    expect(calls).toEqual(["path"]);
  });

  it("reveals, exports, and clears through the local data store", async () => {
    const calls: string[] = [];
    const service = createLocalDataService({
      memoryClient: {
        async exportBundle() {
          calls.push("memory:export");
          return { manifest: { service: "memmy-memory-service" } };
        },
        async clearAllData() {
          calls.push("memory:clear");
          return { ok: true, clearedAt: "2026-06-02T10:00:00.000Z", cleared: {} };
        }
      } as MemoryClient,
      localDataStore: {
        getDataPath() {
          calls.push("path");
          return "/tmp/memmy-data";
        },
        revealDataPath(dataPath) {
          calls.push(`reveal:${dataPath}`);
        },
        exportData(input, bundle) {
          calls.push(`export:${input.targetPath}`);
          expect(bundle).toMatchObject({ manifest: { service: "memmy-memory-service" } });
          return { exportPath: "/tmp/export/memmy-export-1", bytes: 128 };
        },
        clearImportState() {
          calls.push("clear-import-state");
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
    expect(calls).toEqual([
      "path",
      "reveal:/tmp/memmy-data",
      "memory:export",
      "export:/tmp/export",
      "memory:clear",
      "clear-import-state"
    ]);
  });
});
