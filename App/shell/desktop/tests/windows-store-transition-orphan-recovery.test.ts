import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWindowsStorePreparedDataTransitionStatePath } from "../src/main/windows-store-data-transition.js";
import { archiveOrphanedWindowsStoreTransition } from "../src/main/windows-store-transition-orphan-recovery.js";
import {
  advanceWindowsStoreTransitionState,
  createWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState
} from "../src/main/windows-store-transition-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("orphaned Windows Store transition recovery", () => {
  it("archives the exact active and prepared journals without touching user data or runtime", async () => {
    const fixture = await createFixture();
    const profileMarker = win32.join(fixture.state.sourceUserDataPath, "profile.txt");
    const runtimeMarker = win32.join(fixture.state.sourceRuntimeHomePath, "runtime.txt");
    await mkdir(fixture.state.sourceUserDataPath, { recursive: true });
    await mkdir(fixture.state.sourceRuntimeHomePath, { recursive: true });
    await writeFile(profileMarker, "profile", "utf8");
    await writeFile(runtimeMarker, "runtime", "utf8");
    await writeFile(fixture.preparedStatePath, "prepared-journal\n", "utf8");

    const result = await archiveOrphanedWindowsStoreTransition({
      statePath: fixture.statePath,
      expectedState: fixture.state,
      now: new Date("2026-09-04T02:00:00.000Z"),
      archiveId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    });

    await expect(stat(fixture.statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.preparedStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(result.archivedStatePath, "utf8"))
      .resolves.toContain(`"transactionId": "${fixture.state.transactionId}"`);
    await expect(readFile(result.archivedPreparedStatePath!, "utf8"))
      .resolves.toBe("prepared-journal\n");
    await expect(readFile(result.recoveryRecordPath, "utf8"))
      .resolves.toContain('"reason": "package-unregistered"');
    await expect(readFile(profileMarker, "utf8")).resolves.toBe("profile");
    await expect(readFile(runtimeMarker, "utf8")).resolves.toBe("runtime");
  });

  it("archives the active journal when no prepared journal was ever created", async () => {
    const fixture = await createFixture("store-install-launched");
    const result = await archiveOrphanedWindowsStoreTransition({
      statePath: fixture.statePath,
      expectedState: fixture.state,
      now: new Date("2026-09-04T02:00:00.000Z"),
      archiveId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    });
    expect(result.archivedPreparedStatePath).toBeNull();
    await expect(stat(result.archivedStatePath)).resolves.toBeDefined();
  });

  it("fails closed if the active journal changed after the package query", async () => {
    const fixture = await createFixture();
    const changed = advanceWindowsStoreTransitionState(fixture.state, "legacy-cleanup-attested");
    await writeWindowsStoreTransitionState(fixture.statePath, changed);

    await expect(archiveOrphanedWindowsStoreTransition({
      statePath: fixture.statePath,
      expectedState: fixture.state
    })).rejects.toThrow("changed during orphan recovery");
    await expect(stat(fixture.statePath)).resolves.toBeDefined();
  });

  it("rejects a state path outside the fixed LocalAppData transition namespace", async () => {
    const fixture = await createFixture();
    await expect(archiveOrphanedWindowsStoreTransition({
      statePath: win32.join(win32.dirname(fixture.statePath), "other.json"),
      expectedState: fixture.state
    })).rejects.toThrow("must be the fixed active journal path");
  });
});

const createFixture = async (targetPhase: "store-install-launched" | "app-verified" = "app-verified") => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-store-orphan-recovery-"));
  temporaryDirectories.push(root);
  const localAppDataPath = win32.join(root, "LocalAppData");
  const statePath = resolveWindowsStoreTransitionStatePath(localAppDataPath);
  let state = createWindowsStoreTransitionState({
    edition: "intl",
    storeId: "9NFVJC9K7ZK9",
    packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
    aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy",
    sourceExecutablePath: win32.join(root, "NSIS", "Memmy.exe"),
    sourceInstallDirectory: win32.join(root, "NSIS"),
    sourceVersion: "1.1.2",
    sourceUserDataPath: win32.join(root, "Roaming", "Memmy"),
    sourceRuntimeHomePath: win32.join(root, "MemmyData", ".memmy"),
    authority: "current-install-authority",
    now: new Date("2026-09-04T01:00:00.000Z")
  });
  const phases = [
    "store-install-launched",
    "package-registered",
    "data-prepared",
    "awaiting-app-verification",
    "app-verified"
  ] as const;
  for (const phase of phases) {
    state = advanceWindowsStoreTransitionState(state, phase);
    if (phase === targetPhase) break;
  }
  await writeWindowsStoreTransitionState(statePath, state);
  const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
    localAppDataPath,
    state.transactionId
  );
  return { localAppDataPath, statePath, preparedStatePath, state };
};
