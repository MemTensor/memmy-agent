import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupWindowsStoreDataTransition,
  parseWindowsStorePreparedDataTransition,
  planWindowsStoreDataTransition,
  prepareWindowsStoreDataTransition,
  readWindowsStorePreparedDataTransition,
  resolveWindowsStorePreparedDataTransitionStatePath,
  rollbackWindowsStoreDataTransition
} from "../src/main/windows-store-data-transition.js";

const transactionId = "33333333-3333-4333-8333-333333333333";

describe("Windows NSIS-to-MSIX data transition", () => {
  it("plans only the Electron profile when source and destination runtime are the same C-drive home", () => {
    const plan = planWindowsStoreDataTransition({
      transactionId,
      sourceUserDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
      sourceRuntimeHomePath: "C:\\Users\\lee\\.memmy",
      destinationUserDataPath: "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy",
      destinationRuntimeHomePath: "C:\\Users\\lee\\.memmy",
      migrateRuntime: false
    });

    expect(plan.copies).toEqual([{
      category: "user-data",
      sourcePath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
      destinationPath: "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy",
      stagingPath: `C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy.store-staging-${transactionId}`,
      backupPath: `C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy.store-backup-${transactionId}`,
      recoveryPath: `C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.Memmy_eyack96k521x2\\LocalState\\Memmy.store-recovery-${transactionId}`
    }]);
  });

  it("plans both profile and runtime for a non-C runtime source", () => {
    const plan = planWindowsStoreDataTransition({
      transactionId,
      sourceUserDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
      sourceRuntimeHomePath: "E:\\MemmyData\\.memmy",
      destinationUserDataPath: "C:\\Users\\lee\\AppData\\Local\\Packages\\Memtensor.MemmyAgent_eyack96k521x2\\LocalState\\Memmy",
      destinationRuntimeHomePath: "C:\\Users\\lee\\.memmy",
      migrateRuntime: true
    });

    expect(plan.copies.map((copy) => copy.category)).toEqual(["user-data", "runtime"]);
    expect(plan.copies[1]).toEqual({
      category: "runtime",
      sourcePath: "E:\\MemmyData\\.memmy",
      destinationPath: "C:\\Users\\lee\\.memmy",
      stagingPath: `C:\\Users\\lee\\.memmy.store-staging-${transactionId}`,
      backupPath: `C:\\Users\\lee\\.memmy.store-backup-${transactionId}`,
      recoveryPath: `C:\\Users\\lee\\.memmy.store-recovery-${transactionId}`
    });
  });

  it("resolves the prepared journal beside the shared transition journal without a versioned package path", () => {
    expect(resolveWindowsStorePreparedDataTransitionStatePath(
      "C:\\Users\\lee\\AppData\\Local",
      transactionId
    )).toBe(
      `C:\\Users\\lee\\AppData\\Local\\Memmy\\store-transition\\prepared-data-${transactionId}.json`
    );
    expect(() => resolveWindowsStorePreparedDataTransitionStatePath("C:\\", transactionId))
      .toThrow("drive root");
  });

  it("rejects contradictory runtime intent, relative paths, and overlapping roots", () => {
    const base = {
      transactionId,
      sourceUserDataPath: "C:\\Source\\Memmy",
      sourceRuntimeHomePath: "E:\\MemmyData\\.memmy",
      destinationUserDataPath: "C:\\Destination\\Memmy",
      destinationRuntimeHomePath: "C:\\Users\\lee\\.memmy",
      migrateRuntime: true
    };
    expect(() => planWindowsStoreDataTransition({
      ...base,
      migrateRuntime: false
    })).toThrow("migrateRuntime=false");
    expect(() => planWindowsStoreDataTransition({
      ...base,
      sourceRuntimeHomePath: base.destinationRuntimeHomePath,
      migrateRuntime: true
    })).toThrow("migrateRuntime=true");
    expect(() => planWindowsStoreDataTransition({
      ...base,
      sourceUserDataPath: "relative\\Memmy"
    })).toThrow("absolute");
    expect(() => planWindowsStoreDataTransition({
      ...base,
      destinationUserDataPath: "C:\\Source\\Memmy\\StoreTarget"
    })).toThrow("overlap");
    expect(() => planWindowsStoreDataTransition({
      ...base,
      sourceUserDataPath: "C:\\Users\\lee",
      sourceRuntimeHomePath: "C:\\Users\\lee\\.memmy",
      destinationRuntimeHomePath: "C:\\Users\\lee\\.memmy",
      migrateRuntime: false
    })).toThrow("shared runtime overlaps");
  });

  it.runIf(process.platform === "win32")(
    "stages and verifies a Chinese/space profile, preserves a non-empty target backup, and cleans only when eligible",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-中文 空格-"));
      const sourceUserDataPath = join(root, "来源 资料", "Memmy");
      const destinationUserDataPath = join(root, "Store LocalState", "Memmy");
      const sharedRuntimeHomePath = join(root, "用户 Home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, {
          "app.sqlite": "sqlite-new",
          "nested/账户.json": "账户数据"
        });
        await writeTree(destinationUserDataPath, { "old.txt": "old-target" });

        const plan = planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        });
        const preparedStatePath = join(root, "transition", "prepared.json");
        const prepared = await prepareWindowsStoreDataTransition(plan, { preparedStatePath });

        expect(prepared.copies[0]?.sourceManifest).toMatchObject({
          totalBytes: Buffer.byteLength("sqlite-new") + Buffer.byteLength("账户数据"),
          fileCount: 2
        });
        expect(prepared.schemaVersion).toBe(2);
        expect(prepared.copies[0]?.sourceManifest.entries).toEqual(expect.arrayContaining([
          expect.objectContaining({
            relativePath: "app.sqlite",
            type: "file",
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
          }),
          expect.objectContaining({
            relativePath: "nested",
            type: "directory",
            sha256: null
          })
        ]));
        expect(prepared.copies[0]?.previousDestinationManifest).toMatchObject({
          totalBytes: Buffer.byteLength("old-target"),
          fileCount: 1
        });
        await expect(readWindowsStorePreparedDataTransition(preparedStatePath)).resolves.toEqual(prepared);
        expect(await readdir(dirname(preparedStatePath))).toEqual(["prepared.json"]);
        expect(() => parseWindowsStorePreparedDataTransition(JSON.stringify({
          ...prepared,
          unexpected: true
        }))).toThrow("state is invalid");
        const oldSchema = JSON.parse(JSON.stringify(prepared)) as Record<string, unknown>;
        oldSchema.schemaVersion = 1;
        expect(() => parseWindowsStorePreparedDataTransition(JSON.stringify(oldSchema)))
          .toThrow("state is invalid");
        const missingHash = JSON.parse(JSON.stringify(prepared)) as {
          copies: Array<{ sourceManifest: { entries: Array<Record<string, unknown>> } }>;
        };
        delete missingHash.copies[0]!.sourceManifest.entries.find(
          (entry) => entry.type === "file"
        )!.sha256;
        expect(() => parseWindowsStorePreparedDataTransition(JSON.stringify(missingHash)))
          .toThrow("state is invalid");
        await expect(readFile(join(destinationUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("sqlite-new");
        await expect(readFile(join(plan.copies[0]!.backupPath, "old.txt"), "utf8")).resolves.toBe("old-target");
        expect(await exists(sourceUserDataPath)).toBe(true);

        const removePath = vi.fn(async (path: string) => rm(path, { recursive: true, force: true }));
        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: false,
          removePath
        })).resolves.toEqual({ cleaned: false, removedSources: [], removedBackups: [] });
        expect(removePath).not.toHaveBeenCalled();
        expect(await exists(sourceUserDataPath)).toBe(true);
        expect(await exists(plan.copies[0]!.backupPath)).toBe(true);

        await writeTree(destinationUserDataPath, { "boot/session.json": "written-after-successful-boot" });

        await expect(cleanupWindowsStoreDataTransition(prepared, { cleanupEligible: true })).resolves.toMatchObject({
          cleaned: true,
          removedSources: [sourceUserDataPath],
          removedBackups: [plan.copies[0]!.backupPath]
        });
        expect(await exists(sourceUserDataPath)).toBe(false);
        expect(await exists(plan.copies[0]!.backupPath)).toBe(false);
        await expect(cleanupWindowsStoreDataTransition(prepared, { cleanupEligible: true })).resolves.toEqual({
          cleaned: true,
          removedSources: [],
          removedBackups: []
        });
        await expect(readFile(join(destinationUserDataPath, "nested", "账户.json"), "utf8")).resolves.toBe("账户数据");
        await expect(readFile(join(destinationUserDataPath, "boot", "session.json"), "utf8"))
          .resolves.toBe("written-after-successful-boot");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "can retire transition backups while preserving the verified NSIS recovery baseline",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-preserve-source-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      const preparedStatePath = join(root, "transition", "prepared.json");
      try {
        await writeTree(sourceUserDataPath, { "app.sqlite": "signed-in-baseline" });
        await mkdir(sharedRuntimeHomePath, { recursive: true });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        }), { preparedStatePath });

        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: true,
          preserveSources: true
        })).resolves.toEqual({
          cleaned: true,
          removedSources: [],
          removedBackups: []
        });
        await expect(readFile(join(sourceUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
        await expect(readFile(join(destinationUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "retries preserved-source cleanup after an owned backup was already removed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-preserved-cleanup-retry-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      const preparedStatePath = join(root, "transition", "prepared.json");
      try {
        await writeTree(sourceUserDataPath, { "app.sqlite": "signed-in-baseline" });
        await writeTree(destinationUserDataPath, { "old-store.txt": "preexisting-store-data" });
        await mkdir(sharedRuntimeHomePath, { recursive: true });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        }), { preparedStatePath });
        const backupPath = prepared.copies[0]!.backupPath;
        await rm(backupPath, { recursive: true, force: true });

        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: true,
          preserveSources: true
        })).resolves.toEqual({
          cleaned: true,
          removedSources: [],
          removedBackups: []
        });
        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: true,
          preserveSources: true
        })).resolves.toEqual({
          cleaned: true,
          removedSources: [],
          removedBackups: []
        });
        await expect(readFile(join(sourceUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
        await expect(readFile(join(destinationUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects preserved-source cleanup when the recovery baseline disappeared",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-preserved-source-missing-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, { "app.sqlite": "signed-in-baseline" });
        await writeTree(destinationUserDataPath, { "old-store.txt": "preexisting-store-data" });
        await mkdir(sharedRuntimeHomePath, { recursive: true });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        }), { preparedStatePath: join(root, "transition", "prepared.json") });
        await rm(sourceUserDataPath, { recursive: true, force: true });

        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: true,
          preserveSources: true
        })).rejects.toThrow("preserved source is missing");
        expect(await exists(prepared.copies[0]!.backupPath)).toBe(true);
        await expect(readFile(join(destinationUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "retries preserved-source cleanup after one of two backup removals failed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-partial-cleanup-retry-"));
      const paths = {
        sourceUserDataPath: join(root, "source", "Memmy"),
        sourceRuntimeHomePath: join(root, "source-runtime", ".memmy"),
        destinationUserDataPath: join(root, "destination", "Memmy"),
        destinationRuntimeHomePath: join(root, "destination-runtime", ".memmy")
      };
      try {
        await writeTree(paths.sourceUserDataPath, { "app.sqlite": "signed-in-baseline" });
        await writeTree(paths.sourceRuntimeHomePath, { "config.yaml": "source-runtime" });
        await writeTree(paths.destinationUserDataPath, { "old-store.txt": "old-store" });
        await writeTree(paths.destinationRuntimeHomePath, { "old-runtime.txt": "old-runtime" });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          ...paths,
          migrateRuntime: true
        }), { preparedStatePath: join(root, "transition", "prepared.json") });
        let backupRemovalCount = 0;

        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: true,
          preserveSources: true,
          removePath: async (path) => {
            backupRemovalCount += 1;
            if (backupRemovalCount === 2) {
              throw new Error("injected second backup removal failure");
            }
            await rm(path, { recursive: true, force: true });
          }
        })).rejects.toThrow("injected second backup removal failure");
        expect(await exists(prepared.copies[0]!.backupPath)).toBe(false);
        expect(await exists(prepared.copies[1]!.backupPath)).toBe(true);

        await expect(cleanupWindowsStoreDataTransition(prepared, {
          cleanupEligible: true,
          preserveSources: true
        })).resolves.toEqual({
          cleaned: true,
          removedSources: [],
          removedBackups: [prepared.copies[1]!.backupPath]
        });
        await expect(readFile(join(paths.sourceUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
        await expect(readFile(join(paths.sourceRuntimeHomePath, "config.yaml"), "utf8"))
          .resolves.toBe("source-runtime");
        await expect(readFile(join(paths.destinationUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("signed-in-baseline");
        await expect(readFile(join(paths.destinationRuntimeHomePath, "config.yaml"), "utf8"))
          .resolves.toBe("source-runtime");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "atomically persists the complete prepared state before the first destination rename",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-persist-before-commit-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      const preparedStatePath = join(root, "transition", "prepared.json");
      try {
        await expect(readWindowsStorePreparedDataTransition(preparedStatePath)).resolves.toBeNull();
        await writeTree(sourceUserDataPath, { "profile.txt": "new" });
        await writeTree(destinationUserDataPath, { "profile.txt": "old" });
        const plan = planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        });
        let observedPersistedState = false;

        const prepared = await prepareWindowsStoreDataTransition(plan, {
          preparedStatePath,
          renamePath: async (sourcePath, destinationPath) => {
            if (!observedPersistedState) {
              const persisted = await readWindowsStorePreparedDataTransition(preparedStatePath);
              expect(persisted?.plan.transactionId).toBe(transactionId);
              expect(persisted?.copies[0]?.previousDestinationManifest?.fileCount).toBe(1);
              observedPersistedState = true;
            }
            await rename(sourcePath, destinationPath);
          }
        });

        expect(observedPersistedState).toBe(true);
        await expect(readWindowsStorePreparedDataTransition(preparedStatePath)).resolves.toEqual(prepared);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "rolls back every committed target when the second category promotion fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-rollback-"));
      const paths = resolveFixturePaths(root);
      try {
        await writeTree(paths.sourceUserDataPath, { "profile.txt": "new-profile" });
        await writeTree(paths.sourceRuntimeHomePath, { "config.yaml": "new-runtime" });
        await writeTree(paths.destinationUserDataPath, { "profile.txt": "old-profile" });
        await writeTree(paths.destinationRuntimeHomePath, { "config.yaml": "old-runtime" });
        const plan = planWindowsStoreDataTransition({ transactionId, ...paths, migrateRuntime: true });
        const runtimeCopy = plan.copies[1]!;

        await expect(prepareWindowsStoreDataTransition(plan, {
          preparedStatePath: join(root, "transition", "prepared.json"),
          renamePath: async (sourcePath, destinationPath) => {
            if (sourcePath === runtimeCopy.stagingPath && destinationPath === runtimeCopy.destinationPath) {
              throw new Error("injected runtime promotion failure");
            }
            await rename(sourcePath, destinationPath);
          }
        })).rejects.toThrow("injected runtime promotion failure");

        await expect(readFile(join(paths.destinationUserDataPath, "profile.txt"), "utf8")).resolves.toBe("old-profile");
        await expect(readFile(join(paths.destinationRuntimeHomePath, "config.yaml"), "utf8")).resolves.toBe("old-runtime");
        await expect(readFile(join(paths.sourceUserDataPath, "profile.txt"), "utf8")).resolves.toBe("new-profile");
        await expect(readFile(join(paths.sourceRuntimeHomePath, "config.yaml"), "utf8")).resolves.toBe("new-runtime");
        for (const copy of plan.copies) {
          expect(await exists(copy.stagingPath)).toBe(false);
          expect(await exists(copy.backupPath)).toBe(false);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects a staging tree/size mismatch before touching the existing target",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-manifest-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, { "app.sqlite": "source" });
        await writeTree(destinationUserDataPath, { "old.txt": "target-before" });
        const plan = planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        });

        await expect(prepareWindowsStoreDataTransition(plan, {
          preparedStatePath: join(root, "transition", "prepared.json"),
          copyTree: async (sourcePath, stagingPath) => {
            await cp(sourcePath, stagingPath, { recursive: true, errorOnExist: true, force: false });
            await writeFile(join(stagingPath, "unexpected.bin"), "x", "utf8");
          }
        })).rejects.toThrow("tree manifest");

        await expect(readFile(join(destinationUserDataPath, "old.txt"), "utf8")).resolves.toBe("target-before");
        expect(await exists(sourceUserDataPath)).toBe(true);
        expect(await exists(plan.copies[0]!.stagingPath)).toBe(false);
        expect(await exists(plan.copies[0]!.backupPath)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects same-size staging content corruption before touching the existing target",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-hash-mismatch-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, { "app.sqlite": "source" });
        await writeTree(destinationUserDataPath, { "old.txt": "target-before" });
        const plan = planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        });

        await expect(prepareWindowsStoreDataTransition(plan, {
          preparedStatePath: join(root, "transition", "prepared.json"),
          copyTree: async (sourcePath, stagingPath) => {
            await cp(sourcePath, stagingPath, { recursive: true, errorOnExist: true, force: false });
            await writeFile(join(stagingPath, "app.sqlite"), "staged", "utf8");
          }
        })).rejects.toThrow("tree manifest mismatch");

        await expect(readFile(join(destinationUserDataPath, "old.txt"), "utf8")).resolves.toBe("target-before");
        await expect(readFile(join(sourceUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("source");
        expect(await exists(plan.copies[0]!.stagingPath)).toBe(false);
        expect(await exists(plan.copies[0]!.backupPath)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "rejects a same-size source change that happens while the staging copy is made",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-source-race-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, { "app.sqlite": "before" });
        await writeTree(destinationUserDataPath, { "old.txt": "target-before" });
        const plan = planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        });

        await expect(prepareWindowsStoreDataTransition(plan, {
          preparedStatePath: join(root, "transition", "prepared.json"),
          copyTree: async (sourcePath, stagingPath) => {
            await cp(sourcePath, stagingPath, { recursive: true, errorOnExist: true, force: false });
            await writeFile(join(sourcePath, "app.sqlite"), "after!", "utf8");
          }
        })).rejects.toThrow("source changed while staging");

        await expect(readFile(join(destinationUserDataPath, "old.txt"), "utf8")).resolves.toBe("target-before");
        await expect(readFile(join(sourceUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("after!");
        expect(await exists(plan.copies[0]!.stagingPath)).toBe(false);
        expect(await exists(plan.copies[0]!.backupPath)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "supports explicit idempotent rollback after a successful prepare",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-explicit-rollback-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, { "profile.txt": "new" });
        await writeTree(destinationUserDataPath, { "profile.txt": "old" });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        }), { preparedStatePath: join(root, "transition", "prepared.json") });

        await rollbackWindowsStoreDataTransition(prepared);
        await rollbackWindowsStoreDataTransition(prepared);
        await expect(readFile(join(destinationUserDataPath, "profile.txt"), "utf8")).resolves.toBe("old");
        await expect(readFile(join(sourceUserDataPath, "profile.txt"), "utf8")).resolves.toBe("new");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "quarantines a boot-mutated destination before restoring its manifest-bound backup",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-post-boot-rollback-"));
      const sourceUserDataPath = join(root, "source", "Memmy");
      const destinationUserDataPath = join(root, "destination", "Memmy");
      const sharedRuntimeHomePath = join(root, "home", ".memmy");
      try {
        await writeTree(sourceUserDataPath, { "profile.txt": "new" });
        await writeTree(destinationUserDataPath, { "profile.txt": "old" });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          sourceUserDataPath,
          sourceRuntimeHomePath: sharedRuntimeHomePath,
          destinationUserDataPath,
          destinationRuntimeHomePath: sharedRuntimeHomePath,
          migrateRuntime: false
        }), { preparedStatePath: join(root, "transition", "prepared.json") });
        await writeTree(destinationUserDataPath, { "boot/session.json": "boot-write" });

        await rollbackWindowsStoreDataTransition(prepared);
        await rollbackWindowsStoreDataTransition(prepared);
        await expect(readFile(join(destinationUserDataPath, "profile.txt"), "utf8")).resolves.toBe("old");
        await expect(readFile(join(prepared.copies[0]!.recoveryPath, "profile.txt"), "utf8")).resolves.toBe("new");
        await expect(readFile(join(prepared.copies[0]!.recoveryPath, "boot", "session.json"), "utf8"))
          .resolves.toBe("boot-write");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "win32")(
    "prevalidates every source before cleanup and preserves all rollback data when one source changed",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memmy-store-data-cleanup-guard-"));
      const paths = resolveFixturePaths(root);
      try {
        await writeTree(paths.sourceUserDataPath, { "profile.txt": "new-profile" });
        await writeTree(paths.sourceRuntimeHomePath, { "config.yaml": "new-runtime" });
        await writeTree(paths.destinationUserDataPath, { "profile.txt": "old-profile" });
        await writeTree(paths.destinationRuntimeHomePath, { "config.yaml": "old-runtime" });
        const prepared = await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
          transactionId,
          ...paths,
          migrateRuntime: true
        }), { preparedStatePath: join(root, "transition", "prepared.json") });
        await writeFile(join(paths.sourceRuntimeHomePath, "config.yaml"), "changed-after-prepare", "utf8");

        await expect(cleanupWindowsStoreDataTransition(prepared, { cleanupEligible: true }))
          .rejects.toThrow("tree manifest changed");
        expect(await exists(paths.sourceUserDataPath)).toBe(true);
        expect(await exists(paths.sourceRuntimeHomePath)).toBe(true);
        for (const copy of prepared.copies) {
          expect(await exists(copy.backupPath)).toBe(true);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );
});

function resolveFixturePaths(root: string) {
  return {
    sourceUserDataPath: join(root, "source-profile", "Memmy"),
    sourceRuntimeHomePath: join(root, "source-runtime", ".memmy"),
    destinationUserDataPath: join(root, "destination-profile", "Memmy"),
    destinationRuntimeHomePath: join(root, "destination-runtime", ".memmy")
  };
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  await mkdir(root, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = join(root, ...relativePath.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, contents, "utf8");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
