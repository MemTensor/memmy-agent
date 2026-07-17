import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createStorageBackend
} from "../../src/index.js";

describe("local/cloud storage backend parity", () => {
  it("exposes compatible capabilities for sqlite and cloud REST backends", () => {
    const root = mkdtempSync(join(tmpdir(), "mindock-backend-parity-"));
    try {
      const sqliteBackend = createStorageBackend({
        mode: "dev",
        backend: "sqlite",
        sqlitePath: join(root, "sqlite.sqlite")
      });
      expect(sqliteBackend.capabilities()).toMatchObject({
        backendId: "sqlite-local",
        backend: "sqlite",
        changeLog: true,
        idempotency: true,
        jobs: true
      });
      sqliteBackend.close();

      const restBackend = createStorageBackend({
        mode: "cloud",
        backend: "openmem-cloud-rest",
        endpoint: "https://memory.example.test",
        token: "cloud-token",
        schemaVersion: "runtime-v1"
      });
      expect(restBackend.capabilities()).toMatchObject({
        backendId: "openmem-cloud-rest",
        backend: "openmem-cloud-rest",
        fullText: "remote",
        vector: "remote",
        changeLog: true,
        idempotency: true,
        jobs: true
      });
      expect(() => restBackend.repositories()).toThrow(/agent-side REST backend/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
