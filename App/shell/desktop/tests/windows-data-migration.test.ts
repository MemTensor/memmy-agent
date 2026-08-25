import { existsSync } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = new URL("../build/MemmyWindowsDataMigration.ps1", import.meta.url).pathname
  .replace(/^\/(?:[A-Za-z]:)/u, (value) => value.slice(1));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe.runIf(process.platform === "win32")("Windows data migration helper", () => {
  it("prefers install-local runtime data without merging legacy-home data", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, ".memmy", "memory-service"), { recursive: true });
    await mkdir(fixture.legacyRuntimeHomePath, { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "login-state", "utf8");
    await writeFile(
      join(fixture.sourceDataPath, ".memmy", "memory-service", "memory.sqlite"),
      "memory-state",
      "utf8"
    );
    await writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "current-runtime", "utf8");
    await writeFile(join(fixture.legacyRuntimeHomePath, "config.yaml"), "stale-runtime", "utf8");

    const prepared = runMigration("Prepare", fixture, false, "", "current-install-authority", "1.1.0");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(await readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .toBe("login-state");
    expect(await readFile(join(fixture.targetRuntimeHomePath, "memory-service", "memory.sqlite"), "utf8"))
      .toBe("memory-state");
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).toBe("current-runtime");
    expect(await readFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "utf8"))
      .toBe("login-state");
    expect(await readPointer(fixture.pointerPath)).toBe(`${fixture.targetRuntimeHomePath}\r\n`);

    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      phase: string;
      owner: string;
      targetRuntimeHomePath: string;
      runtimeSourcePaths: string[];
    };
    expect(state).toMatchObject({
      phase: "prepared",
      owner: "installer",
      targetRuntimeHomePath: fixture.targetRuntimeHomePath
    });
    expect(state.runtimeSourcePaths).toEqual([
      join(fixture.sourceDataPath, ".memmy")
    ]);
    expect(existsSync(fixture.lockPath)).toBe(true);
  });

  it("rebases only staged Windows runtime defaults and standalone session bindings", async () => {
    const fixture = await createFixture();
    const sourceRuntimeHomePath = join(fixture.sourceDataPath, ".memmy");
    const sourceWorkspacePath = join(sourceRuntimeHomePath, "workspace");
    const targetWorkspacePath = join(fixture.targetRuntimeHomePath, "workspace");
    const sourceMemoryDatabasePath = join(sourceRuntimeHomePath, "memory-service", "memory.sqlite");
    const targetMemoryDatabasePath = join(fixture.targetRuntimeHomePath, "memory-service", "memory.sqlite");
    const sessionsPath = join(sourceWorkspacePath, "sessions");
    const standalonePath = join(sessionsPath, "websocket_standalone.jsonl");
    const projectPath = join(sessionsPath, "websocket_project.jsonl");
    const customWorkspacePath = join(fixture.root, "custom-workspace");
    const customPath = join(sessionsPath, "websocket_custom.jsonl");
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(sourceRuntimeHomePath, "memory-service"), { recursive: true }),
      mkdir(sessionsPath, { recursive: true })
    ]);
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "account-state", "utf8");
    await writeFile(sourceMemoryDatabasePath, "memory-state", "utf8");
    await writeFile(join(sourceRuntimeHomePath, "config.yaml"), [
      "agents:",
      "  defaults:",
      `    workspace: ${sourceWorkspacePath}`,
      "memmyMemory:",
      "  storage:",
      `    sqlitePath: ${sourceMemoryDatabasePath}`,
      ""
    ].join("\r\n"), "utf8");
    const historyRecord = JSON.stringify({ recordType: "message", role: "user", content: "history remains byte-for-byte" });
    const standaloneContents = `${JSON.stringify({
      recordType: "session",
      key: "websocket:standalone",
      metadata: { webui: true, webuiProjectId: null, webuiWorkspaceCwd: sourceWorkspacePath }
    })}\r\n${historyRecord}\r\n`;
    const projectContents = `${JSON.stringify({
      recordType: "session",
      key: "websocket:project",
      metadata: { webui: true, webuiProjectId: "project-1", webuiWorkspaceCwd: sourceWorkspacePath }
    })}\r\n${historyRecord}\r\n`;
    const customContents = `${JSON.stringify({
      recordType: "session",
      key: "websocket:custom",
      metadata: { webui: true, webuiProjectId: null, webuiWorkspaceCwd: customWorkspacePath }
    })}\r\n${historyRecord}\r\n`;
    await Promise.all([
      writeFile(standalonePath, standaloneContents, "utf8"),
      writeFile(projectPath, projectContents, "utf8"),
      writeFile(customPath, customContents, "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture, false, "", "current-install-authority", "1.0.9");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);

    const migratedConfig = await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8");
    expect(migratedConfig).toContain(targetWorkspacePath);
    expect(migratedConfig).toContain(targetMemoryDatabasePath);
    expect(migratedConfig).not.toContain(sourceWorkspacePath);
    expect(migratedConfig).not.toContain(sourceMemoryDatabasePath);

    const migratedStandalone = await readFile(
      join(targetWorkspacePath, "sessions", "websocket_standalone.jsonl"),
      "utf8"
    );
    const [standaloneMetadata, standaloneHistory] = migratedStandalone.split("\r\n");
    expect(JSON.parse(standaloneMetadata).metadata).toMatchObject({
      webuiProjectId: null,
      webuiWorkspaceCwd: targetWorkspacePath
    });
    expect(standaloneHistory).toBe(historyRecord);
    await expect(readFile(
      join(targetWorkspacePath, "sessions", "websocket_project.jsonl"),
      "utf8"
    )).resolves.toBe(projectContents);
    await expect(readFile(
      join(targetWorkspacePath, "sessions", "websocket_custom.jsonl"),
      "utf8"
    )).resolves.toBe(customContents);
    await expect(readFile(standalonePath, "utf8")).resolves.toBe(standaloneContents);
  });

  it("uses the remembered runtime root before legacy-home data without merging", async () => {
    const fixture = await createFixture();
    const rememberedRuntimeHomePath = join(fixture.root, "previous-drive", "MemmyData", ".memmy");
    const relativeSessionPath = join("workspace", "sessions");
    await Promise.all([
      mkdir(join(rememberedRuntimeHomePath, relativeSessionPath), { recursive: true }),
      mkdir(join(fixture.legacyRuntimeHomePath, relativeSessionPath), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(rememberedRuntimeHomePath, relativeSessionPath, "remembered.jsonl"), "remembered-chat", "utf8"),
      writeFile(join(rememberedRuntimeHomePath, relativeSessionPath, "shared.jsonl"), "remembered-wins", "utf8"),
      writeFile(join(fixture.legacyRuntimeHomePath, relativeSessionPath, "legacy.jsonl"), "legacy-chat", "utf8"),
      writeFile(fixture.pointerPath, Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`${rememberedRuntimeHomePath}\r\n`, "utf16le")
      ]))
    ]);

    const prepared = runMigration("Prepare", fixture, false, rememberedRuntimeHomePath);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);

    const targetSessionsPath = join(fixture.targetRuntimeHomePath, relativeSessionPath);
    await expect(readFile(join(targetSessionsPath, "remembered.jsonl"), "utf8"))
      .resolves.toBe("remembered-chat");
    expect(existsSync(join(targetSessionsPath, "legacy.jsonl"))).toBe(false);
    await expect(readFile(join(targetSessionsPath, "shared.jsonl"), "utf8"))
      .resolves.toBe("remembered-wins");

    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      runtimeSourcePaths: string[];
      backupPaths: string[];
    };
    expect(state.runtimeSourcePaths).toEqual([
      rememberedRuntimeHomePath
    ]);
    expect(state.backupPaths).toHaveLength(0);
  });

  it("skips every legacy runtime source when the target already contains data", async () => {
    const fixture = await createFixture();
    const installRuntimeHomePath = join(fixture.sourceDataPath, ".memmy");
    const rememberedRuntimeHomePath = join(fixture.root, "previous-drive", "MemmyData", ".memmy");
    await Promise.all([
      mkdir(join(installRuntimeHomePath, "workspace", "sessions"), { recursive: true }),
      mkdir(join(rememberedRuntimeHomePath, "workspace", "sessions"), { recursive: true }),
      mkdir(join(fixture.legacyRuntimeHomePath, "workspace", "sessions"), { recursive: true }),
      mkdir(join(fixture.targetRuntimeHomePath, "workspace", "sessions"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(installRuntimeHomePath, "workspace", "sessions", "install.jsonl"), "install-chat", "utf8"),
      writeFile(join(rememberedRuntimeHomePath, "workspace", "sessions", "remembered.jsonl"), "remembered-chat", "utf8"),
      writeFile(join(fixture.legacyRuntimeHomePath, "workspace", "sessions", "legacy.jsonl"), "legacy-chat", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "workspace", "sessions", "current.jsonl"), "current-chat", "utf8"),
      writeFile(fixture.pointerPath, Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`${rememberedRuntimeHomePath}\r\n`, "utf16le")
      ]))
    ]);

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    const targetSessionsPath = join(fixture.targetRuntimeHomePath, "workspace", "sessions");
    await expect(readFile(join(targetSessionsPath, "current.jsonl"), "utf8"))
      .resolves.toBe("current-chat");
    expect(existsSync(join(targetSessionsPath, "install.jsonl"))).toBe(false);
    expect(existsSync(join(targetSessionsPath, "remembered.jsonl"))).toBe(false);
    expect(existsSync(join(targetSessionsPath, "legacy.jsonl"))).toBe(false);

    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      runtimeSourcePaths: string[];
      backupPaths: string[];
      targetRuntimeHadData: boolean;
    };
    expect(state).toMatchObject({
      runtimeSourcePaths: [],
      backupPaths: [],
      targetRuntimeHadData: true
    });
  });

  it("falls back to the legacy user-profile runtime home when install-local runtime data is absent", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true });
    await mkdir(join(fixture.legacyRuntimeHomePath, "memory-service"), { recursive: true });
    await mkdir(join(fixture.legacyRuntimeHomePath, "updates"), { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "login-state", "utf8");
    await writeFile(
      join(fixture.legacyRuntimeHomePath, "memory-service", "memory.sqlite"),
      "legacy-home-state",
      "utf8"
    );
    await writeFile(join(fixture.legacyRuntimeHomePath, "updates", "old-installer.exe"), "cache", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(await readFile(join(fixture.targetRuntimeHomePath, "memory-service", "memory.sqlite"), "utf8"))
      .toBe("legacy-home-state");
    expect(await readFile(join(fixture.legacyRuntimeHomePath, "memory-service", "memory.sqlite"), "utf8"))
      .toBe("legacy-home-state");
    expect(existsSync(join(fixture.targetRuntimeHomePath, "updates"))).toBe(false);
  });

  it("keeps early APPDATA account data and copies early profile runtime when no install-local generation exists", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.legacyRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "early-account", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "history.json"), "early-history", "utf8"),
      writeFile(join(fixture.legacyRuntimeHomePath, "config.yaml"), "early-runtime", "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("early-account");
    await expect(readFile(join(fixture.targetUserDataPath, "history.json"), "utf8"))
      .resolves.toBe("early-history");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("early-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      accountSourceAuthority: "target-existing",
      runtimeSourceAuthority: "legacy-home-fallback",
      categorySourcesShareGeneration: false
    });
  });

  it("acquires the unified update lock atomically for a direct installer migration", async () => {
    const fixture = await createFixture();
    await rm(fixture.lockPath, { recursive: true, force: true });
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "login-state", "utf8");

    const prepared = runMigration("Prepare", fixture, true);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(existsSync(fixture.lockPath)).toBe(true);

    const competing = runMigration("Prepare", fixture, true);
    expect(competing.status).not.toBe(0);
    expect(existsSync(fixture.lockPath)).toBe(true);
  });

  it("refuses to copy a SQLite database that is still open for writing", async () => {
    const fixture = await createFixture();
    const sourceUserDataPath = join(fixture.sourceDataPath, "Memmy");
    const sqlitePath = join(sourceUserDataPath, "app.sqlite");
    await mkdir(sourceUserDataPath, { recursive: true });
    await writeFile(sqlitePath, "login-state", "utf8");
    const handle = await open(sqlitePath, "r+");
    try {
      const prepared = runMigration("Prepare", fixture);
      expect(prepared.status).not.toBe(0);
      expect(existsSync(fixture.targetUserDataPath)).toBe(false);
      expect(await readFile(sqlitePath, "utf8")).toBe("login-state");
    } finally {
      await handle.close();
    }
  });

  it("preserves a verified same-volume recovery copy when direct migration fails before uninstall", async () => {
    const fixture = await createFixture();
    const sourceUserDataPath = join(fixture.sourceDataPath, "Memmy");
    const sourceRuntimePath = join(fixture.sourceDataPath, ".memmy");
    const blockedStateParent = dirname(fixture.statePath);
    await Promise.all([
      mkdir(sourceUserDataPath, { recursive: true }),
      mkdir(sourceRuntimePath, { recursive: true }),
      mkdir(dirname(blockedStateParent), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(sourceUserDataPath, "app.sqlite"), "recoverable-login", "utf8"),
      writeFile(join(sourceRuntimePath, "config.yaml"), "recoverable-runtime", "utf8"),
      writeFile(blockedStateParent, "block state directory creation", "utf8")
    ]);

    const failed = runMigration("Prepare", fixture);
    expect(failed.status).not.toBe(0);
    expect(existsSync(fixture.targetUserDataPath)).toBe(false);
    expect(existsSync(fixture.targetRuntimeHomePath)).toBe(false);
    const failedRecord = JSON.parse(await readFile(fixture.installationRecordPath, "utf8")) as {
      sourceDataPath: string;
      migrationFailed: boolean;
    };
    expect(failedRecord.migrationFailed).toBe(true);
    await expect(readFile(join(failedRecord.sourceDataPath, "Memmy", "app.sqlite"), "utf8"))
      .resolves.toBe("recoverable-login");
    await expect(readFile(join(failedRecord.sourceDataPath, ".memmy", "config.yaml"), "utf8"))
      .resolves.toBe("recoverable-runtime");

    await rm(fixture.sourceDataPath, { recursive: true, force: true });
    await rm(blockedStateParent, { force: true });
    const retried = runMigration("Prepare", fixture, false, "", "untrusted-residual");
    expect(retried.status, retried.stderr || retried.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("recoverable-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("recoverable-runtime");
  });

  it("replaces historical target data from the current install authority without merging", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceDataPath, "Memmy", "prepared-required-update.json.lock"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, "Memmy", "updates"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true });
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await mkdir(fixture.targetRuntimeHomePath, { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "new-login", "utf8");
    await writeFile(join(fixture.sourceDataPath, "Memmy", "prepared-required-update.json"), "{}", "utf8");
    await writeFile(join(fixture.sourceDataPath, "Memmy", "updates", "old-installer.exe"), "cache", "utf8");
    await writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "new-runtime", "utf8");
    await writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "old-login", "utf8");
    await writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "old-runtime", "utf8");
    await writeFile(join(fixture.targetUserDataPath, "historical-only.txt"), "do-not-merge", "utf8");
    await writeFile(join(fixture.targetRuntimeHomePath, "historical-only.txt"), "do-not-merge", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    const preparedState = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      backupPaths: string[];
      targetUserDataHadData: boolean;
      targetRuntimeHadData: boolean;
      sourceAuthority: string;
    };
    expect(preparedState).toMatchObject({
      targetUserDataHadData: true,
      targetRuntimeHadData: true,
      sourceAuthority: "current-install-authority"
    });
    expect(preparedState.backupPaths).toHaveLength(2);
    expect(await readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).toBe("new-login");
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).toBe("new-runtime");
    expect(existsSync(join(fixture.targetUserDataPath, "historical-only.txt"))).toBe(false);
    expect(existsSync(join(fixture.targetRuntimeHomePath, "historical-only.txt"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "updates"))).toBe(false);

    const completed = runMigration("Complete", fixture);
    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "prepared-required-update.json.lock"))).toBe(false);
    expect(existsSync(join(fixture.targetUserDataPath, "updates"))).toBe(false);
    expect(existsSync(fixture.lockPath)).toBe(true);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification"
    });
  });

  it("keeps verified targets when the install directory is only an untrusted residual", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "residual-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "residual-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "verified-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "verified-runtime", "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture, false, "", "untrusted-residual");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("verified-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("verified-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      sourceAuthority: "untrusted-residual",
      preparedCopies: []
    });
  });

  it("trusts the exact user-selected install directory after a legacy uninstall removed its registry entry", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "selected-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "selected-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "historical-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "historical-runtime", "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture, false, "", "selected-install-authority");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("selected-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("selected-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      sourceAuthority: "selected-install-authority"
    });
  });

  it("does not trust a selected install residual already marked as the verified external generation", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "residual-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "residual-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "verified-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "verified-runtime", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "external-v1",
        installDir: dirname(fixture.sourceDataPath),
        appVersion: "1.1.0",
        recordedAt: new Date().toISOString()
      }), "utf8")
    ]);

    expect(runMigration("Prepare", fixture, false, "", "selected-install-authority").status).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("verified-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).resolves.toBe("verified-runtime");
  });

  it("keeps verified targets when the registered install is already marked as external layout", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "residual-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "residual-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "verified-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "verified-runtime", "utf8")
    ]);
    await writeFile(fixture.installationRecordPath, JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installDir: dirname(fixture.sourceDataPath),
      recordedAt: new Date(Date.now() + 10_000).toISOString()
    }), "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("verified-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("verified-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      sourceAuthority: "untrusted-residual",
      preparedCopies: []
    });
  });

  it("lets a registered 1.0.9 install override an earlier external-layout marker without relying on mtimes", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await writeFile(fixture.installationRecordPath, JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installDir: dirname(fixture.sourceDataPath),
      recordedAt: "2000-01-01T00:00:00.000Z"
    }), "utf8");
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "newer-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "newer-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "old-target-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "old-target-runtime", "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture, false, "", "current-install-authority", "1.0.9");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("newer-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("newer-runtime");
    expect(JSON.parse(await readFile(fixture.installationRecordPath, "utf8"))).toMatchObject({
      dataLayoutGeneration: "install-local-v1",
      installDir: dirname(fixture.sourceDataPath)
    });
  });

  it("uses an exact persisted install-local record when the registry source is unavailable", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "persisted-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "persisted-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "historical-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "historical-runtime", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "install-local-v1",
        installDir: dirname(fixture.sourceDataPath),
        sourceGeneration: "legacy-install:test-record",
        recordedAt: new Date().toISOString()
      }), "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture, false, "", "untrusted-residual");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("persisted-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("persisted-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      sourceAuthority: "persisted-install-authority",
      sourceGeneration: "legacy-install:test-record"
    });
  });

  it("keeps the exact user-selected install source instead of an older persisted install record", async () => {
    const fixture = await createFixture();
    const olderInstallDir = join(fixture.root, "older-install");
    const olderDataPath = join(olderInstallDir, "data");
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(join(olderDataPath, "Memmy"), { recursive: true }),
      mkdir(join(olderDataPath, ".memmy"), { recursive: true }),
      mkdir(dirname(fixture.installationRecordPath), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "selected-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "selected-runtime", "utf8"),
      writeFile(join(olderDataPath, "Memmy", "app.sqlite"), "older-login", "utf8"),
      writeFile(join(olderDataPath, ".memmy", "config.yaml"), "older-runtime", "utf8"),
      writeFile(fixture.installationRecordPath, JSON.stringify({
        schemaVersion: 1,
        dataLayoutGeneration: "install-local-v1",
        installDir: olderInstallDir,
        sourceDataPath: olderDataPath,
        sourceGeneration: "legacy-install:older",
        recordedAt: new Date().toISOString()
      }), "utf8")
    ]);

    const prepared = runMigration("Prepare", fixture, false, "", "selected-install-authority");
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("selected-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).resolves.toBe("selected-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      sourceAuthority: "selected-install-authority",
      sourceDataPath: fixture.sourceDataPath
    });
  });

  it("replaces a non-empty target from a complete trusted account source", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "legacy-login", "utf8");
    await writeFile(join(fixture.targetUserDataPath, "session.json"), "current-login", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(existsSync(join(fixture.targetUserDataPath, "session.json"))).toBe(false);
    expect(await readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).toBe("legacy-login");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      targetUserDataHadData: true,
      accountSourceAuthority: "current-install-authority"
    });
  });

  it("ignores a data-root pointer outside supported Memmy runtime roots", async () => {
    const fixture = await createFixture();
    const arbitraryRuntimePath = join(fixture.root, "arbitrary", "runtime");
    await mkdir(arbitraryRuntimePath, { recursive: true });
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await writeFile(join(arbitraryRuntimePath, "do-not-copy.txt"), "private", "utf8");
    await writeFile(fixture.pointerPath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${arbitraryRuntimePath}\r\n`, "utf16le")
    ]));

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(existsSync(join(fixture.targetRuntimeHomePath, "do-not-copy.txt"))).toBe(false);
    expect(await readFile(join(arbitraryRuntimePath, "do-not-copy.txt"), "utf8")).toBe("private");
    expect(await readFile(fixture.logPath, "utf8")).toContain(
      "Ignoring data-root pointer outside a supported Memmy runtime root"
    );
  });

  it("rolls back newly copied destinations and the previous data-root pointer after an installer failure", async () => {
    const fixture = await createFixture();
    const previousRuntimeHomePath = join(fixture.root, "previous-runtime", ".memmy");
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "new-login", "utf8");
    await writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "new-runtime", "utf8");
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await writeFile(fixture.pointerPath, `${previousRuntimeHomePath}\r\n`, "utf16le");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(await readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).toBe("new-login");

    const rolledBack = runMigration("Rollback", fixture);
    expect(rolledBack.status, rolledBack.stderr || rolledBack.stdout).toBe(0);
    expect(existsSync(join(fixture.targetUserDataPath, "app.sqlite"))).toBe(false);
    expect(existsSync(fixture.targetRuntimeHomePath)).toBe(false);
    expect(await readFile(fixture.pointerPath, "utf16le")).toBe(`${previousRuntimeHomePath}\r\n`);
    expect(existsSync(fixture.statePath)).toBe(false);
  });

  it("retries rollback idempotently after one category was already restored", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true }),
      mkdir(fixture.targetUserDataPath, { recursive: true }),
      mkdir(fixture.targetRuntimeHomePath, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "new-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "new-runtime", "utf8"),
      writeFile(join(fixture.targetUserDataPath, "app.sqlite"), "old-login", "utf8"),
      writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "old-runtime", "utf8")
    ]);
    expect(runMigration("Prepare", fixture).status).toBe(0);
    const state = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
      preparedCopies: Array<{ DestinationPath: string; BackupPath?: string }>;
    };
    const runtimeCopy = state.preparedCopies.find((copy) => copy.DestinationPath === fixture.targetRuntimeHomePath);
    expect(runtimeCopy?.BackupPath).toBeTruthy();
    await rm(fixture.targetRuntimeHomePath, { recursive: true, force: true });
    await rename(runtimeCopy!.BackupPath!, fixture.targetRuntimeHomePath);

    const rolledBack = runMigration("Rollback", fixture);
    expect(rolledBack.status, rolledBack.stderr || rolledBack.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("old-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).resolves.toBe("old-runtime");
    expect(existsSync(fixture.statePath)).toBe(false);
  });

  it("rolls back a no-op preparation with no copied directories", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await mkdir(fixture.targetRuntimeHomePath, { recursive: true });
    await writeFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "same-runtime", "utf8");
    await writeFile(fixture.pointerPath, `${fixture.targetRuntimeHomePath}\r\n`, "utf16le");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "prepared",
      preparedCopies: []
    });

    const rolledBack = runMigration("Rollback", fixture);
    expect(rolledBack.status, rolledBack.stderr || rolledBack.stdout).toBe(0);
    expect(existsSync(fixture.statePath)).toBe(false);
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).toBe("same-runtime");
  });

  it("refuses verified-backup cleanup when state targets differ from the trusted layout", async () => {
    const fixture = await createFixture();
    const unrelatedTarget = join(fixture.root, "unrelated", "user-data");
    const unrelatedBackup = `${unrelatedTarget}.migration-backup-0123456789abcdef0123456789abcdef`;
    await mkdir(unrelatedBackup, { recursive: true });
    await writeFile(join(unrelatedBackup, "keep.txt"), "keep", "utf8");
    await mkdir(join(fixture.statePath, ".."), { recursive: true });
    await writeFile(fixture.statePath, JSON.stringify({
      phase: "app-verified",
      targetUserDataPath: unrelatedTarget,
      targetRuntimeHomePath: fixture.targetRuntimeHomePath,
      backupPaths: [unrelatedBackup]
    }), "utf8");

    const nextPrepare = runMigration("Prepare", fixture);
    expect(nextPrepare.status).not.toBe(0);
    expect(await readFile(join(unrelatedBackup, "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(fixture.statePath)).toBe(true);
  });

  it("cleans verified state through the trusted pointer before switching runtime drives", async () => {
    const fixture = await createFixture();
    const previousRuntimeHomePath = join(fixture.root, "previous-drive", "MemmyData", ".memmy");
    const previousBackup = `${previousRuntimeHomePath}.migration-backup-0123456789abcdef0123456789abcdef`;
    await mkdir(fixture.targetUserDataPath, { recursive: true });
    await mkdir(previousRuntimeHomePath, { recursive: true });
    await mkdir(previousBackup, { recursive: true });
    await writeFile(join(previousRuntimeHomePath, "config.yaml"), "previous-runtime", "utf8");
    await writeFile(join(previousBackup, "stale.txt"), "stale-backup", "utf8");
    await writeFile(fixture.pointerPath, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${previousRuntimeHomePath}\r\n`, "utf16le")
    ]));
    await mkdir(join(fixture.statePath, ".."), { recursive: true });
    await writeFile(fixture.statePath, JSON.stringify({
      phase: "app-verified",
      targetUserDataPath: fixture.targetUserDataPath,
      targetRuntimeHomePath: previousRuntimeHomePath,
      backupPaths: [previousBackup]
    }), "utf8");

    const nextPrepare = runMigration("Prepare", fixture, false, previousRuntimeHomePath);
    expect(nextPrepare.status, nextPrepare.stderr || nextPrepare.stdout).toBe(0);
    expect(existsSync(previousBackup)).toBe(true);
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .toBe("previous-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "prepared",
      runtimeSourcePaths: [previousRuntimeHomePath],
      targetRuntimeHomePath: fixture.targetRuntimeHomePath,
      deferredCleanupStates: [{ phase: "app-verified" }]
    });
  });

  it("recovers a failed direct install by rolling back while the old source still exists", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "login-state", "utf8");
    await writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "runtime-state", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);

    const recovered = runMigration("Recover", fixture);
    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(existsSync(join(fixture.targetUserDataPath, "app.sqlite"))).toBe(false);
    expect(existsSync(fixture.targetRuntimeHomePath)).toBe(false);
    expect(existsSync(fixture.statePath)).toBe(false);
  });

  it("preserves migrated data for retry when the failed installer already removed the old source", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true });
    await mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true });
    await writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "login-state", "utf8");
    await writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "runtime-state", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await rm(fixture.sourceDataPath, { recursive: true, force: true });

    const recovered = runMigration("Recover", fixture);
    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(await readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).toBe("login-state");
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).toBe("runtime-state");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "prepared-for-retry"
    });

    await rm(fixture.lockPath, { recursive: true, force: true });
    const resumed = runMigration("Prepare", fixture, true);
    expect(resumed.status, resumed.stderr || resumed.stdout).toBe(0);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "prepared-for-retry"
    });

    const completed = runMigration("Complete", fixture);
    expect(completed.status, completed.stderr || completed.stdout).toBe(0);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "awaiting-app-verification"
    });
  });

  it("lets a newly confirmed current install source supersede prepared-for-retry data", async () => {
    const fixture = await createFixture();
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "first-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "first-runtime", "utf8")
    ]);
    expect(runMigration("Prepare", fixture).status).toBe(0);
    await rm(fixture.sourceDataPath, { recursive: true, force: true });
    expect(runMigration("Recover", fixture).status).toBe(0);
    await Promise.all([
      mkdir(join(fixture.sourceDataPath, "Memmy"), { recursive: true }),
      mkdir(join(fixture.sourceDataPath, ".memmy"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(fixture.sourceDataPath, "Memmy", "app.sqlite"), "newest-login", "utf8"),
      writeFile(join(fixture.sourceDataPath, ".memmy", "config.yaml"), "newest-runtime", "utf8")
    ]);
    await rm(fixture.lockPath, { recursive: true, force: true });

    const resumed = runMigration("Prepare", fixture, true);
    expect(resumed.status, resumed.stderr || resumed.stdout).toBe(0);
    await expect(readFile(join(fixture.targetUserDataPath, "app.sqlite"), "utf8")).resolves.toBe("newest-login");
    await expect(readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8")).resolves.toBe("newest-runtime");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({ phase: "prepared" });
  });

  it("rolls back a fresh-install preparation that copied no data", async () => {
    const fixture = await createFixture();

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "prepared",
      preparedCopies: []
    });

    const recovered = runMigration("Recover", fixture);
    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(existsSync(fixture.statePath)).toBe(false);
    expect(existsSync(fixture.pointerPath)).toBe(false);
  });

  it("rolls back copied external runtime data while its real source still exists", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.legacyRuntimeHomePath, { recursive: true });
    await writeFile(join(fixture.legacyRuntimeHomePath, "config.yaml"), "legacy-runtime", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .toBe("legacy-runtime");

    const recovered = runMigration("Recover", fixture);
    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(existsSync(fixture.targetRuntimeHomePath)).toBe(false);
    expect(await readFile(join(fixture.legacyRuntimeHomePath, "config.yaml"), "utf8"))
      .toBe("legacy-runtime");
    expect(existsSync(fixture.statePath)).toBe(false);
  });

  it("preserves a copied runtime destination when its real source disappeared", async () => {
    const fixture = await createFixture();
    await mkdir(fixture.sourceDataPath, { recursive: true });
    await mkdir(fixture.legacyRuntimeHomePath, { recursive: true });
    await writeFile(join(fixture.legacyRuntimeHomePath, "config.yaml"), "only-runtime-copy", "utf8");

    const prepared = runMigration("Prepare", fixture);
    expect(prepared.status, prepared.stderr || prepared.stdout).toBe(0);
    await rm(fixture.legacyRuntimeHomePath, { recursive: true, force: true });

    const recovered = runMigration("Recover", fixture);
    expect(recovered.status, recovered.stderr || recovered.stdout).toBe(0);
    expect(await readFile(join(fixture.targetRuntimeHomePath, "config.yaml"), "utf8"))
      .toBe("only-runtime-copy");
    expect(JSON.parse(await readFile(fixture.statePath, "utf8"))).toMatchObject({
      phase: "prepared-for-retry"
    });
  });
});

interface MigrationFixture {
  root: string;
  sourceDataPath: string;
  legacyRuntimeHomePath: string;
  targetUserDataPath: string;
  targetRuntimeHomePath: string;
  pointerPath: string;
  statePath: string;
  installationRecordPath: string;
  lockPath: string;
  logPath: string;
}

async function createFixture(): Promise<MigrationFixture> {
  const root = await mkdtemp(join(tmpdir(), "memmy-windows-data-migration-"));
  temporaryDirectories.push(root);
  const lockPath = join(root, "upgrade-staging", "active.lock");
  await mkdir(lockPath, { recursive: true });
  return {
    root,
    sourceDataPath: join(root, "old-install", "data"),
    legacyRuntimeHomePath: join(root, "Users", "tester", ".memmy"),
    targetUserDataPath: join(root, "AppData", "Roaming", "Memmy"),
    targetRuntimeHomePath: join(root, "new-drive", "MemmyData", ".memmy"),
    pointerPath: join(root, "AppData", "Roaming", "Memmy", "data-root.txt"),
    statePath: join(root, "AppData", "Local", "Memmy", "data-migration", "state.json"),
    installationRecordPath: join(root, "AppData", "Local", "Memmy", "data-layout", "last-install.json"),
    lockPath,
    logPath: join(root, "migration.log")
  };
}

function runMigration(
  mode: "Prepare" | "Complete" | "Rollback" | "Recover",
  fixture: MigrationFixture,
  acquireLock = false,
  allowedRememberedRuntimeHomePath = "",
  sourceAuthority: "current-install-authority" | "selected-install-authority" | "relay-backup-authority" | "persisted-install-authority" | "untrusted-residual" = "current-install-authority",
  sourceInstalledVersion = ""
) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Mode", mode,
    "-SourceDataPath", fixture.sourceDataPath,
    "-SourceAuthority", sourceAuthority,
    "-SourceInstallDir", dirname(fixture.sourceDataPath),
    "-SourceInstalledVersion", sourceInstalledVersion,
    "-InstallationRecordPath", fixture.installationRecordPath,
    "-LegacyRuntimeHomePath", fixture.legacyRuntimeHomePath,
    "-TargetUserDataPath", fixture.targetUserDataPath,
    "-TargetRuntimeHomePath", fixture.targetRuntimeHomePath,
    "-PointerPath", fixture.pointerPath,
    "-StatePath", fixture.statePath,
    "-LockPath", fixture.lockPath,
    "-LogPath", fixture.logPath,
    "-Owner", "installer"
  ];
  if (acquireLock) {
    args.push(
      "-InstallerPid", String(process.pid),
      "-InstallerPath", process.execPath,
      "-InstallerInstallDir", join(fixture.root, "new-install"),
      "-AcquireLock"
    );
  }
  if (allowedRememberedRuntimeHomePath) {
    args.push("-AllowedRememberedRuntimeHomePath", allowedRememberedRuntimeHomePath);
  }
  return spawnSync("powershell.exe", args, { encoding: "utf8" });
}

async function readPointer(pointerPath: string): Promise<string> {
  const contents = await readFile(pointerPath);
  expect([...contents.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  return contents.subarray(2).toString("utf16le");
}
