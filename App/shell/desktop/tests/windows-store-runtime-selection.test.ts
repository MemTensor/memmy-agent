import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitWindowsStoreRuntimeSelectionForVerifiedBoot,
  resolveWindowsStoreRuntimeHomeForStartup,
  resolveWindowsStoreRuntimeSelectionPath
} from "../src/main/windows-store-runtime-selection.js";
import {
  createWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState,
  type WindowsStoreTransitionPhase,
  type WindowsStoreTransitionState
} from "../src/main/windows-store-transition-state.js";

const temporaryDirectories: string[] = [];
const identity = {
  edition: "intl" as const,
  packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
  aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("Windows Store runtime selection", () => {
  it("selects the authority-bound runtime from an unfinished transition", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "store-install-launched");
    await mkdir(win32.dirname(fixture.recordPath), { recursive: true });
    await writeFile(fixture.recordPath, "{}\n", "utf8");

    expect(resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toBe(fixture.runtimeHomePath);
  });

  it("discovers the current NSIS authority before a manual Store install creates a journal", async () => {
    const fixture = await createFixture();
    await writeLegacyAuthority(fixture);

    expect(resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toBe(fixture.runtimeHomePath);
  });

  it("lets a current NSIS authority replace a malformed lower-priority Store binding", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "awaiting-app-verification");
    await writeStorePointer(fixture, fixture.runtimeHomePath);
    await commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    });
    await rm(fixture.statePath, { force: true });
    await writeFile(fixture.bindingPath, "{}\n", "utf8");
    await writeLegacyAuthority(fixture);

    expect(resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toBe(fixture.runtimeHomePath);
    await rm(fixture.recordPath, { force: true });
    expect(() => resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toThrow("runtime selection is invalid");
  });

  it("commits a PFN-bound selection and reuses it after the transition and legacy record are gone", async () => {
    const fixture = await createFixture();
    const state = await writeState(fixture, "awaiting-app-verification");
    await writeStorePointer(fixture, fixture.runtimeHomePath);

    await expect(commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath,
      now: new Date("2026-09-03T12:00:00.000Z")
    })).resolves.toMatchObject({
      status: "committed",
      transactionId: state.transactionId
    });

    await rm(fixture.statePath, { force: true });
    await rm(fixture.recordPath, { force: true });
    expect(resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toBe(fixture.runtimeHomePath);

    const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
    expect(binding).toMatchObject({
      schemaVersion: 1,
      authority: "store-runtime-selection",
      runtimeDisposition: "shared-authoritative",
      edition: identity.edition,
      packageFamilyName: identity.packageFamilyName,
      aumid: identity.aumid,
      userDataPath: fixture.storeUserDataPath,
      runtimeHomePath: fixture.runtimeHomePath,
      sourceInstallDriveRoot: "C:\\",
      transactionId: state.transactionId,
      committedAt: "2026-09-03T12:00:00.000Z"
    });
  });

  it("allows the committed external runtime to survive package LocalState removal", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "awaiting-app-verification");
    await writeStorePointer(fixture, fixture.runtimeHomePath);
    await commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    });
    await rm(fixture.statePath, { force: true });
    await rm(fixture.recordPath, { force: true });
    await rm(fixture.storeUserDataPath, { recursive: true, force: true });

    expect(resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toBe(fixture.runtimeHomePath);
  });

  it("ignores an exact old Store-v1 record and continues to the committed binding", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "awaiting-app-verification");
    await writeStorePointer(fixture, fixture.runtimeHomePath);
    await commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    });
    await rm(fixture.statePath, { force: true });
    await mkdir(win32.dirname(fixture.recordPath), { recursive: true });
    await writeFile(fixture.recordPath, `${JSON.stringify({
      schemaVersion: 1,
      dataLayoutGeneration: "external-v1",
      installDir: "C:\\Program Files\\WindowsApps\\Memtensor.MemmyAgent_1.1.2.0_x64__eyack96k521x2\\app",
      userDataPath: fixture.storeUserDataPath,
      runtimeHomePath: fixture.runtimeHomePath,
      appVersion: "1.1.2",
      recordedAt: "2026-09-03T11:00:00.000Z"
    }, null, 2)}\n`, "utf8");

    expect(resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toBe(fixture.runtimeHomePath);
  });

  it("rejects a non-canonical drive root in a committed binding", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "awaiting-app-verification");
    await writeStorePointer(fixture, fixture.runtimeHomePath);
    await commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    });
    await rm(fixture.statePath, { force: true });
    const binding = JSON.parse(await readFile(fixture.bindingPath, "utf8")) as Record<string, unknown>;
    binding.sourceInstallDriveRoot = "C:\\folder\\..";
    await writeFile(fixture.bindingPath, `${JSON.stringify(binding, null, 2)}\n`, "utf8");

    expect(() => resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toThrow("source drive is invalid");
  });

  it("fails closed on a malformed active journal instead of falling back to a valid binding", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "awaiting-app-verification");
    await writeStorePointer(fixture, fixture.runtimeHomePath);
    await commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    });
    await writeFile(fixture.statePath, "{}\n", "utf8");

    expect(() => resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toThrow("transition journal is invalid");
  });

  it("rejects a transition for another Store identity before selecting its runtime", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "store-install-launched");

    expect(() => resolveWindowsStoreRuntimeHomeForStartup({
      ...fixture.selectionOptions,
      identity: {
        edition: "cn",
        packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
        aumid: "Memtensor.Memmy_eyack96k521x2!Memmy"
      }
    })).toThrow("package identity");
  });

  it("rejects an unlaunched authority and an unavailable shared runtime", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "authority-recorded");
    expect(() => resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toThrow("has not been launched");

    await writeState(fixture, "store-install-launched");
    await rm(fixture.runtimeHomePath, { recursive: true, force: true });
    expect(() => resolveWindowsStoreRuntimeHomeForStartup(fixture.selectionOptions))
      .toThrow("runtime home is unavailable");
  });

  it("does not commit a runtime selection before the Store profile is boot-verified", async () => {
    const fixture = await createFixture();
    await writeState(fixture, "package-registered");
    await writeStorePointer(fixture, fixture.runtimeHomePath);

    await expect(commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    })).rejects.toThrow("cannot be committed from phase package-registered");
    await expect(readFile(fixture.bindingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can recommit the shared runtime from a historical untrusted cleanup journal", async () => {
    const fixture = await createFixture();
    const state = await writeState(fixture, "legacy-cleanup-complete");
    await writeStorePointer(fixture, fixture.runtimeHomePath);

    await expect(commitWindowsStoreRuntimeSelectionForVerifiedBoot({
      ...fixture.selectionOptions,
      runtimeHomePath: fixture.runtimeHomePath
    })).resolves.toMatchObject({
      status: "committed",
      transactionId: state.transactionId
    });
  });
});

interface Fixture {
  localAppDataPath: string;
  roamingAppDataPath: string;
  homeDirectory: string;
  storeUserDataPath: string;
  sourceUserDataPath: string;
  runtimeHomePath: string;
  statePath: string;
  recordPath: string;
  bindingPath: string;
  selectionOptions: {
    localAppDataPath: string;
    roamingAppDataPath: string;
    homeDirectory: string;
    storeUserDataPath: string;
    identity: typeof identity;
  };
}

const createFixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-store-runtime-selection-"));
  temporaryDirectories.push(root);
  const localAppDataPath = win32.join(root, "LocalAppData");
  const roamingAppDataPath = win32.join(root, "Roaming");
  const homeDirectory = win32.join(root, "Home");
  const sourceUserDataPath = win32.join(roamingAppDataPath, "Memmy");
  const runtimeHomePath = win32.join(homeDirectory, ".memmy");
  const storeUserDataPath = win32.join(
    localAppDataPath,
    "Packages",
    identity.packageFamilyName,
    "LocalState",
    "Memmy"
  );
  await Promise.all([
    mkdir(sourceUserDataPath, { recursive: true }),
    mkdir(runtimeHomePath, { recursive: true }),
    mkdir(storeUserDataPath, { recursive: true })
  ]);
  const statePath = resolveWindowsStoreTransitionStatePath(localAppDataPath);
  const recordPath = win32.join(localAppDataPath, "Memmy", "data-layout", "last-install.json");
  const bindingPath = resolveWindowsStoreRuntimeSelectionPath(
    localAppDataPath,
    identity.packageFamilyName
  );
  return {
    localAppDataPath,
    roamingAppDataPath,
    homeDirectory,
    storeUserDataPath,
    sourceUserDataPath,
    runtimeHomePath,
    statePath,
    recordPath,
    bindingPath,
    selectionOptions: {
      localAppDataPath,
      roamingAppDataPath,
      homeDirectory,
      storeUserDataPath,
      identity
    }
  };
};

const writeState = async (
  fixture: Fixture,
  phase: WindowsStoreTransitionPhase
): Promise<WindowsStoreTransitionState> => {
  const base = createWindowsStoreTransitionState({
    transactionId: "11111111-2222-4333-8444-555555555555",
    edition: identity.edition,
    storeId: "9NFVJC9K7ZK9",
    packageFamilyName: identity.packageFamilyName,
    aumid: identity.aumid,
    sourceExecutablePath: "C:\\Applications\\Memmy\\Memmy.exe",
    sourceInstallDirectory: "C:\\Applications\\Memmy",
    sourceVersion: "1.1.2",
    sourceUserDataPath: fixture.sourceUserDataPath,
    sourceRuntimeHomePath: fixture.runtimeHomePath,
    authority: "current-install-authority",
    now: new Date("2026-09-03T11:00:00.000Z")
  });
  const state: WindowsStoreTransitionState = {
    ...base,
    phase,
    updatedAt: "2026-09-03T11:01:00.000Z"
  };
  await writeWindowsStoreTransitionState(fixture.statePath, state);
  return state;
};

const writeLegacyAuthority = async (fixture: Fixture): Promise<void> => {
  await mkdir(win32.dirname(fixture.recordPath), { recursive: true });
  await writeFile(fixture.recordPath, `${JSON.stringify({
    schemaVersion: 1,
    dataLayoutGeneration: "external-v1",
    installationOwner: "nsis",
    installDir: "C:\\Applications\\Memmy",
    userDataPath: fixture.sourceUserDataPath,
    runtimeHomePath: fixture.runtimeHomePath,
    appVersion: "1.1.2",
    recordedAt: "2026-09-03T11:00:00.000Z"
  }, null, 2)}\n`, "utf8");
  await writeFile(
    win32.join(fixture.sourceUserDataPath, "data-root.txt"),
    `${fixture.runtimeHomePath}\r\n`,
    "utf8"
  );
};

const writeStorePointer = async (
  fixture: Fixture,
  runtimeHomePath: string
): Promise<void> => {
  await mkdir(fixture.storeUserDataPath, { recursive: true });
  await writeFile(
    win32.join(fixture.storeUserDataPath, "data-root.txt"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`${runtimeHomePath}\r\n`, "utf16le")
    ])
  );
};
