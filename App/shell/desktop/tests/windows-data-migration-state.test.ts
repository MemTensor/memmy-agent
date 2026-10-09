import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advanceWindowsDataMigrationAfterBoot,
  readWindowsDataMigrationConsistency,
  recoverWindowsDataMigrationForStartup,
  type WindowsDataLayout
} from "../src/main/windows-data-layout.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe.runIf(process.platform === "win32")("Windows data migration boot verification", () => {
  it("rolls a valid inconsistent migration back before startup continues", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const userBackup = `${layout.userDataPath}.migration-backup-0123456789abcdef0123456789abcdef`;
    const runtimeBackup = `${layout.runtimeHomePath}.migration-backup-fedcba9876543210fedcba9876543210`;
    await Promise.all([
      mkdir(layout.userDataPath, { recursive: true }),
      mkdir(layout.runtimeHomePath, { recursive: true }),
      mkdir(userBackup, { recursive: true }),
      mkdir(runtimeBackup, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(layout.userDataPath, "app.sqlite"), "migrated-account", "utf8"),
      writeFile(join(layout.runtimeHomePath, "config.yaml"), "migrated-runtime", "utf8"),
      writeFile(join(userBackup, "app.sqlite"), "old-account", "utf8"),
      writeFile(join(runtimeBackup, "config.yaml"), "old-runtime", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        phase: "awaiting-app-verification",
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        previousPointerExisted: false,
        preparedCopies: [
          { DestinationPath: layout.userDataPath, BackupPath: userBackup },
          { DestinationPath: layout.runtimeHomePath, BackupPath: runtimeBackup }
        ]
      }), "utf8")
    ]);

    await expect(recoverWindowsDataMigrationForStartup(layout, "owner mismatch"))
      .resolves.toMatchObject({ status: "rolled-back" });
    await expect(readFile(join(layout.userDataPath, "app.sqlite"), "utf8")).resolves.toBe("old-account");
    await expect(readFile(join(layout.runtimeHomePath, "config.yaml"), "utf8")).resolves.toBe("old-runtime");
    expect(existsSync(layout.migrationStatePath)).toBe(false);
  });

  it("quarantines cross-category rollback backups without touching either target", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const userBackup = `${layout.userDataPath}.migration-backup-0123456789abcdef0123456789abcdef`;
    const runtimeBackup = `${layout.runtimeHomePath}.migration-backup-fedcba9876543210fedcba9876543210`;
    await Promise.all([
      mkdir(layout.userDataPath, { recursive: true }),
      mkdir(layout.runtimeHomePath, { recursive: true }),
      mkdir(userBackup, { recursive: true }),
      mkdir(runtimeBackup, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(layout.userDataPath, "app.sqlite"), "keep-account", "utf8"),
      writeFile(join(layout.runtimeHomePath, "config.yaml"), "keep-runtime", "utf8"),
      writeFile(join(userBackup, "app.sqlite"), "old-account", "utf8"),
      writeFile(join(runtimeBackup, "config.yaml"), "old-runtime", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        phase: "awaiting-app-verification",
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        previousPointerExisted: false,
        preparedCopies: [
          { DestinationPath: layout.userDataPath, BackupPath: runtimeBackup },
          { DestinationPath: layout.runtimeHomePath, BackupPath: userBackup }
        ]
      }), "utf8")
    ]);

    const recovery = await recoverWindowsDataMigrationForStartup(layout, "cross-category backup");
    expect(recovery.status).toBe("quarantined");
    expect(recovery.quarantinePath && existsSync(recovery.quarantinePath)).toBe(true);
    await expect(readFile(join(layout.userDataPath, "app.sqlite"), "utf8")).resolves.toBe("keep-account");
    await expect(readFile(join(layout.runtimeHomePath, "config.yaml"), "utf8")).resolves.toBe("keep-runtime");
    expect(existsSync(userBackup)).toBe(true);
    expect(existsSync(runtimeBackup)).toBe(true);
  });

  it("quarantines duplicate rollback destinations without touching the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const firstBackup = `${layout.userDataPath}.migration-backup-0123456789abcdef0123456789abcdef`;
    const secondBackup = `${layout.userDataPath}.migration-backup-fedcba9876543210fedcba9876543210`;
    await Promise.all([
      mkdir(layout.userDataPath, { recursive: true }),
      mkdir(firstBackup, { recursive: true }),
      mkdir(secondBackup, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(layout.userDataPath, "app.sqlite"), "keep-account", "utf8"),
      writeFile(join(firstBackup, "app.sqlite"), "first-old", "utf8"),
      writeFile(join(secondBackup, "app.sqlite"), "second-old", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        phase: "awaiting-app-verification",
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        previousPointerExisted: false,
        preparedCopies: [
          { DestinationPath: layout.userDataPath, BackupPath: firstBackup },
          { DestinationPath: layout.userDataPath, BackupPath: secondBackup }
        ]
      }), "utf8")
    ]);

    const recovery = await recoverWindowsDataMigrationForStartup(layout, "duplicate destination");
    expect(recovery.status).toBe("quarantined");
    expect(recovery.quarantinePath && existsSync(recovery.quarantinePath)).toBe(true);
    await expect(readFile(join(layout.userDataPath, "app.sqlite"), "utf8")).resolves.toBe("keep-account");
    expect(existsSync(firstBackup)).toBe(true);
    expect(existsSync(secondBackup)).toBe(true);
  });

  it("quarantines an arbitrary staging path without deleting it or the target", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const arbitraryStaging = join(root, "unrelated", "private-data");
    await Promise.all([
      mkdir(layout.userDataPath, { recursive: true }),
      mkdir(arbitraryStaging, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(layout.userDataPath, "app.sqlite"), "keep-account", "utf8"),
      writeFile(join(arbitraryStaging, "keep.txt"), "keep-private", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        phase: "recovery-required",
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        previousPointerExisted: false,
        preparedCopies: [
          { DestinationPath: layout.userDataPath, BackupPath: null, StagingPath: arbitraryStaging }
        ]
      }), "utf8")
    ]);

    const recovery = await recoverWindowsDataMigrationForStartup(layout, "unsafe staging path");
    expect(recovery.status).toBe("quarantined");
    expect(recovery.quarantinePath && existsSync(recovery.quarantinePath)).toBe(true);
    await expect(readFile(join(layout.userDataPath, "app.sqlite"), "utf8")).resolves.toBe("keep-account");
    await expect(readFile(join(arbitraryStaging, "keep.txt"), "utf8")).resolves.toBe("keep-private");
  });

  it("quarantines malformed migration state without deleting target data", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    await mkdir(layout.userDataPath, { recursive: true });
    await mkdir(dirname(layout.migrationStatePath), { recursive: true });
    await writeFile(join(layout.userDataPath, "app.sqlite"), "keep-account", "utf8");
    await writeFile(layout.migrationStatePath, "{broken", "utf8");

    const recovery = await recoverWindowsDataMigrationForStartup(layout, "malformed state");
    expect(recovery.status).toBe("quarantined");
    expect(recovery.quarantinePath && existsSync(recovery.quarantinePath)).toBe(true);
    await expect(readFile(join(layout.userDataPath, "app.sqlite"), "utf8")).resolves.toBe("keep-account");
  });

  it("forces a write-ahead recovery-required transaction to roll back before verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const userBackup = `${layout.userDataPath}.migration-backup-0123456789abcdef0123456789abcdef`;
    const userStaging = `${layout.userDataPath}.migrating-abcdef0123456789abcdef0123456789`;
    await Promise.all([
      mkdir(layout.userDataPath, { recursive: true }),
      mkdir(userBackup, { recursive: true }),
      mkdir(userStaging, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(layout.userDataPath, "app.sqlite"), "partially-migrated", "utf8"),
      writeFile(join(userBackup, "app.sqlite"), "pre-migration", "utf8"),
      writeFile(join(userStaging, "app.sqlite"), "staged-copy", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        phase: "recovery-required",
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        previousPointerExisted: false,
        preparedCopies: [
          { DestinationPath: layout.userDataPath, BackupPath: userBackup, StagingPath: userStaging }
        ]
      }), "utf8")
    ]);

    await expect(readWindowsDataMigrationConsistency(layout)).rejects.toThrow("requires startup rollback");
    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("none");
    expect(existsSync(layout.migrationStatePath)).toBe(true);
    await expect(recoverWindowsDataMigrationForStartup(layout, "write-ahead transaction interrupted"))
      .resolves.toMatchObject({ status: "rolled-back" });
    await expect(readFile(join(layout.userDataPath, "app.sqlite"), "utf8")).resolves.toBe("pre-migration");
    expect(existsSync(userStaging)).toBe(false);
    expect(existsSync(layout.migrationStatePath)).toBe(false);
  });

  it("retains rollback data for one successful boot and cleans it on the next boot", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout: WindowsDataLayout = {
      userDataPath: join(root, "AppData", "Roaming", "Memmy"),
      runtimeHomePath: join(root, "new-drive", "MemmyData", ".memmy"),
      updatesPath: join(root, "new-drive", "MemmyData", "updates"),
      pointerPath: join(root, "AppData", "Roaming", "Memmy", "data-root.txt"),
      migrationStatePath: join(root, "AppData", "Local", "Memmy", "data-migration", "state.json"),
      installationRecordPath: join(root, "AppData", "Local", "Memmy", "data-layout", "last-install.json"),
      legacyInstallDataPath: join(root, "new-install", "data")
    };
    const targetBackup = `${layout.runtimeHomePath}.migration-backup-0123456789abcdef0123456789abcdef`;
    const relayBackupRoot = join(`${join(root, "new-install")}.memmy-upgrade-backup`, "1234");
    const sourceDataPath = join(relayBackupRoot, "data-backup");
    await mkdir(targetBackup, { recursive: true });
    await mkdir(join(sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(join(layout.migrationStatePath, ".."), { recursive: true });
    await writeFile(join(targetBackup, "old.txt"), "old", "utf8");
    await writeFile(join(sourceDataPath, "Memmy", "app.sqlite"), "source", "utf8");
    await writeFile(layout.migrationStatePath, JSON.stringify({
      owner: "relay",
      phase: "awaiting-app-verification",
      sourceInstallDir: join(root, "new-install"),
      sourceDataPath,
      targetUserDataPath: layout.userDataPath,
      targetRuntimeHomePath: layout.runtimeHomePath,
      backupPaths: [targetBackup],
      preparedCopies: [
        { SourcePath: join(sourceDataPath, "Memmy"), DestinationPath: layout.userDataPath, BackupPath: null }
      ]
    }), "utf8");

    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("verified");
    expect(existsSync(targetBackup)).toBe(true);
    expect(existsSync(sourceDataPath)).toBe(true);
    expect(JSON.parse(await readFile(layout.migrationStatePath, "utf8"))).toMatchObject({
      phase: "app-verified"
    });

    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("cleaned");
    expect(existsSync(targetBackup)).toBe(false);
    expect(existsSync(relayBackupRoot)).toBe(false);
    expect(existsSync(layout.migrationStatePath)).toBe(false);
  });

  it("cleans a validated relocation relay backup and old drive runtime only after boot verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const sourceInstallDir = join(root, "old-install");
    const targetInstallDir = dirname(layout.legacyInstallDataPath);
    const relayBackupRoot = join(`${sourceInstallDir}.memmy-upgrade-backup`, "1234");
    const sourceDataPath = join(relayBackupRoot, "data-backup");
    const accountSourcePath = join(sourceDataPath, "Memmy");
    const oldRuntimeHomePath = join(root, "old-drive", "MemmyData", ".memmy");
    await Promise.all([
      mkdir(accountSourcePath, { recursive: true }),
      mkdir(oldRuntimeHomePath, { recursive: true }),
      mkdir(layout.runtimeHomePath, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(accountSourcePath, "app.sqlite"), "legacy-account", "utf8"),
      writeFile(join(oldRuntimeHomePath, "config.yaml"), "old-runtime", "utf8"),
      writeFile(join(layout.runtimeHomePath, "config.yaml"), "new-runtime", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        owner: "relay",
        phase: "awaiting-app-verification",
        sourceAuthority: "relay-backup-authority",
        sourceInstallDir,
        targetInstallDir,
        sourceDataPath,
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        runtimeSourcePath: oldRuntimeHomePath,
        runtimeSourcePaths: [oldRuntimeHomePath],
        preparedCopies: [
          { SourcePath: accountSourcePath, DestinationPath: layout.userDataPath, BackupPath: null },
          { SourcePath: oldRuntimeHomePath, DestinationPath: layout.runtimeHomePath, BackupPath: null }
        ],
        backupPaths: []
      }), "utf8")
    ]);

    await expect(advanceWindowsDataMigrationAfterBoot(layout, [oldRuntimeHomePath])).resolves.toBe("verified");
    expect(existsSync(relayBackupRoot)).toBe(true);
    expect(existsSync(oldRuntimeHomePath)).toBe(true);

    await expect(advanceWindowsDataMigrationAfterBoot(layout, [oldRuntimeHomePath])).resolves.toBe("cleaned");
    expect(existsSync(relayBackupRoot)).toBe(false);
    expect(existsSync(oldRuntimeHomePath)).toBe(false);
    expect(existsSync(layout.migrationStatePath)).toBe(false);
  });

  it("cleans carry-forward relay backups across consecutive installation relocations", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout = createLayout(root);
    const firstSourceInstallDir = join(root, "install-a");
    const intermediateInstallDir = join(root, "install-b");
    const activeInstallDir = dirname(layout.legacyInstallDataPath);
    const firstRelayBackupRoot = join(`${firstSourceInstallDir}.memmy-upgrade-backup`, "1111");
    const secondRelayBackupRoot = join(`${intermediateInstallDir}.memmy-upgrade-backup`, "2222");
    const firstSourceDataPath = join(firstRelayBackupRoot, "data-backup");
    const secondSourceDataPath = join(secondRelayBackupRoot, "data-backup");
    const createRelayState = (
      sourceInstallDir: string,
      targetInstallDir: string,
      sourceDataPath: string
    ) => ({
      owner: "relay",
      phase: "app-verified",
      sourceAuthority: "relay-backup-authority",
      sourceInstallDir,
      targetInstallDir,
      sourceDataPath,
      targetUserDataPath: layout.userDataPath,
      targetRuntimeHomePath: layout.runtimeHomePath,
      runtimeSourcePaths: [],
      preparedCopies: [
        {
          SourcePath: join(sourceDataPath, "Memmy"),
          DestinationPath: layout.userDataPath,
          BackupPath: null
        }
      ],
      backupPaths: []
    });
    const firstState = createRelayState(firstSourceInstallDir, intermediateInstallDir, firstSourceDataPath);
    const secondState = {
      ...createRelayState(intermediateInstallDir, activeInstallDir, secondSourceDataPath),
      deferredCleanupStates: [firstState]
    };
    await Promise.all([
      mkdir(join(firstSourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(secondSourceDataPath, "Memmy"), { recursive: true }),
      mkdir(layout.runtimeHomePath, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(firstSourceDataPath, "Memmy", "app.sqlite"), "first", "utf8"),
      writeFile(join(secondSourceDataPath, "Memmy", "app.sqlite"), "second", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify(secondState), "utf8")
    ]);

    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("cleaned");
    expect(existsSync(firstRelayBackupRoot)).toBe(false);
    expect(existsSync(secondRelayBackupRoot)).toBe(false);
    expect(existsSync(layout.migrationStatePath)).toBe(false);
  });

  it("does not delete a relay-shaped backup outside the active installation sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout: WindowsDataLayout = {
      userDataPath: join(root, "AppData", "Roaming", "Memmy"),
      runtimeHomePath: join(root, "new-drive", "MemmyData", ".memmy"),
      updatesPath: join(root, "new-drive", "MemmyData", "updates"),
      pointerPath: join(root, "AppData", "Roaming", "Memmy", "data-root.txt"),
      migrationStatePath: join(root, "AppData", "Local", "Memmy", "data-migration", "state.json"),
      installationRecordPath: join(root, "AppData", "Local", "Memmy", "data-layout", "last-install.json"),
      legacyInstallDataPath: join(root, "new-install", "data")
    };
    const unrelatedBackupRoot = join(`${join(root, "unrelated")}.memmy-upgrade-backup`, "1234");
    const sourceDataPath = join(unrelatedBackupRoot, "data-backup");
    await mkdir(sourceDataPath, { recursive: true });
    await mkdir(join(layout.migrationStatePath, ".."), { recursive: true });
    await writeFile(join(sourceDataPath, "keep.txt"), "keep", "utf8");
    await writeFile(layout.migrationStatePath, JSON.stringify({
      owner: "relay",
      phase: "app-verified",
      sourceDataPath,
      targetUserDataPath: layout.userDataPath,
      targetRuntimeHomePath: layout.runtimeHomePath,
      backupPaths: []
    }), "utf8");

    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("cleaned");
    expect(existsSync(sourceDataPath)).toBe(true);
  });

  it("removes only a trusted runtime source copied to the active target after verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const layout: WindowsDataLayout = {
      userDataPath: join(root, "AppData", "Roaming", "Memmy"),
      runtimeHomePath: join(root, "new-drive", "MemmyData", ".memmy"),
      updatesPath: join(root, "new-drive", "MemmyData", "updates"),
      pointerPath: join(root, "AppData", "Roaming", "Memmy", "data-root.txt"),
      migrationStatePath: join(root, "AppData", "Local", "Memmy", "data-migration", "state.json"),
      installationRecordPath: join(root, "AppData", "Local", "Memmy", "data-layout", "last-install.json"),
      legacyInstallDataPath: join(root, "new-install", "data")
    };
    const trustedSource = join(root, "old-drive", "MemmyData", ".memmy");
    const unrelatedSource = join(root, "unrelated", ".memmy");
    await mkdir(trustedSource, { recursive: true });
    await mkdir(unrelatedSource, { recursive: true });
    await mkdir(layout.runtimeHomePath, { recursive: true });
    await mkdir(join(layout.migrationStatePath, ".."), { recursive: true });
    await writeFile(join(trustedSource, "old.txt"), "old", "utf8");
    await writeFile(join(unrelatedSource, "keep.txt"), "keep", "utf8");
    await writeFile(join(layout.runtimeHomePath, "current.txt"), "current", "utf8");
    await writeFile(layout.migrationStatePath, JSON.stringify({
      owner: "installer",
      phase: "app-verified",
      targetUserDataPath: layout.userDataPath,
      targetRuntimeHomePath: layout.runtimeHomePath,
      runtimeSourcePaths: [trustedSource, unrelatedSource],
      preparedCopies: [
        { SourcePath: trustedSource, DestinationPath: layout.runtimeHomePath, BackupPath: null },
        { SourcePath: unrelatedSource, DestinationPath: layout.userDataPath, BackupPath: null }
      ],
      backupPaths: []
    }), "utf8");

    await expect(advanceWindowsDataMigrationAfterBoot(layout, [trustedSource]))
      .resolves.toBe("cleaned");
    expect(existsSync(trustedSource)).toBe(false);
    expect(existsSync(unrelatedSource)).toBe(true);
    expect(await readFile(join(layout.runtimeHomePath, "current.txt"), "utf8")).toBe("current");
  });

  it("cleans only copied categories from an exact trusted install source after the second boot", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const sourceInstallDir = join(root, "new-install");
    const sourceDataPath = join(sourceInstallDir, "data");
    const accountSourcePath = join(sourceDataPath, "Memmy");
    const runtimeSourcePath = join(sourceDataPath, ".memmy");
    const unrelatedPath = join(sourceDataPath, "user-export");
    const layout: WindowsDataLayout = {
      userDataPath: join(root, "AppData", "Roaming", "Memmy"),
      runtimeHomePath: join(root, "new-drive", "MemmyData", ".memmy"),
      updatesPath: join(root, "new-drive", "MemmyData", "updates"),
      pointerPath: join(root, "AppData", "Roaming", "Memmy", "data-root.txt"),
      migrationStatePath: join(root, "AppData", "Local", "Memmy", "data-migration", "state.json"),
      installationRecordPath: join(root, "AppData", "Local", "Memmy", "data-layout", "last-install.json"),
      legacyInstallDataPath: join(root, "new-install", "data")
    };
    await Promise.all([
      mkdir(accountSourcePath, { recursive: true }),
      mkdir(runtimeSourcePath, { recursive: true }),
      mkdir(unrelatedPath, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(accountSourcePath, "app.sqlite"), "account", "utf8"),
      writeFile(join(runtimeSourcePath, "config.yaml"), "runtime", "utf8"),
      writeFile(join(unrelatedPath, "keep.txt"), "keep", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        owner: "installer",
        phase: "app-verified",
        sourceAuthority: "current-install-authority",
        sourceInstallDir,
        sourceDataPath,
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        preparedCopies: [
          { SourcePath: accountSourcePath, DestinationPath: layout.userDataPath, BackupPath: null },
          { SourcePath: runtimeSourcePath, DestinationPath: layout.runtimeHomePath, BackupPath: null }
        ],
        backupPaths: []
      }), "utf8")
    ]);

    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("cleaned");
    expect(existsSync(accountSourcePath)).toBe(false);
    expect(existsSync(runtimeSourcePath)).toBe(false);
    expect(await readFile(join(unrelatedPath, "keep.txt"), "utf8")).toBe("keep");
  });

  it("does not delete a legal-shaped direct source outside the active installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-migration-state-"));
    temporaryDirectories.push(root);
    const sourceInstallDir = join(root, "unrelated-install");
    const sourceDataPath = join(sourceInstallDir, "data");
    const accountSourcePath = join(sourceDataPath, "Memmy");
    const layout = createLayout(root);
    await Promise.all([
      mkdir(accountSourcePath, { recursive: true }),
      mkdir(dirname(layout.migrationStatePath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(accountSourcePath, "app.sqlite"), "keep-unrelated", "utf8"),
      writeFile(layout.migrationStatePath, JSON.stringify({
        owner: "installer",
        phase: "app-verified",
        sourceAuthority: "current-install-authority",
        sourceInstallDir,
        sourceDataPath,
        targetUserDataPath: layout.userDataPath,
        targetRuntimeHomePath: layout.runtimeHomePath,
        preparedCopies: [
          { SourcePath: accountSourcePath, DestinationPath: layout.userDataPath, BackupPath: null }
        ],
        backupPaths: []
      }), "utf8")
    ]);

    await expect(advanceWindowsDataMigrationAfterBoot(layout)).resolves.toBe("cleaned");
    await expect(readFile(join(accountSourcePath, "app.sqlite"), "utf8")).resolves.toBe("keep-unrelated");
  });
});

function createLayout(root: string): WindowsDataLayout {
  return {
    userDataPath: join(root, "AppData", "Roaming", "Memmy"),
    runtimeHomePath: join(root, "new-drive", "MemmyData", ".memmy"),
    updatesPath: join(root, "new-drive", "MemmyData", "updates"),
    pointerPath: join(root, "AppData", "Roaming", "Memmy", "data-root.txt"),
    migrationStatePath: join(root, "AppData", "Local", "Memmy", "data-migration", "state.json"),
    installationRecordPath: join(root, "AppData", "Local", "Memmy", "data-layout", "last-install.json"),
    legacyInstallDataPath: join(root, "new-install", "data")
  };
}
