import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceWindowsStoreTransitionForVerifiedBoot,
  prepareWindowsStoreTransitionForBoot,
  rollbackWindowsStoreTransitionAfterFailedBoot
} from "../src/main/windows-store-transition-coordinator.js";
import { resolveWindowsStoreTransitionSourceBarrier } from "../src/main/windows-store-transition-source-barrier.js";
import {
  assertWindowsStorePreparedDataTransitionSourcesUnchanged,
  planWindowsStoreDataTransition,
  prepareWindowsStoreDataTransition,
  readWindowsStorePreparedDataTransition,
  resolveWindowsStorePreparedDataTransitionStatePath
} from "../src/main/windows-store-data-transition.js";
import {
  acquireWindowsStoreTransitionSourceLease,
  tryAcquireWindowsStoreTransitionSourceLease,
  WindowsStoreTransitionSourceLeaseTimeoutError
} from "../src/main/windows-store-transition-source-lifetime.js";
import {
  advanceWindowsStoreTransitionState,
  createWindowsStoreTransitionState,
  readWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState,
  type WindowsStoreTransitionState
} from "../src/main/windows-store-transition-state.js";

const temporaryDirectories: string[] = [];
const identity = {
  edition: "cn" as const,
  packageFamilyName: "Memtensor.Memmy_eyack96k521x2",
  aumid: "Memtensor.Memmy_eyack96k521x2!Memmy"
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Windows Store transition coordinator", () => {
  it("prepares migrated data, verifies one boot, and cleans only after the second boot", async () => {
    const fixture = await createFixture({ sharedRuntime: false });
    const finalizeLegacyInstallation = vi.fn(async (state: WindowsStoreTransitionState) => {
      expect(state.phase).toBe("app-verified");
    });
    const acknowledgeLegacyCleanup = vi.fn(async (state: WindowsStoreTransitionState) => {
      expect(state.phase).toBe("legacy-cleanup-attested");
    });

    const prepared = await prepareWindowsStoreTransitionForBoot(fixture.options);
    expect(prepared).toMatchObject({ status: "prepared", phase: "awaiting-app-verification" });
    await expect(readFile(win32.join(fixture.layout.userDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
    await expect(readFile(win32.join(fixture.layout.runtimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("source-runtime");
    expect(await readPointer(fixture.layout.pointerPath)).toBe(fixture.layout.runtimeHomePath);

    const firstBoot = await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup
    });
    expect(firstBoot.status).toBe("verified");
    expect(finalizeLegacyInstallation).toHaveBeenCalledOnce();
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "cleanup-eligible" });
    await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();
    await expect(stat(fixture.sourceRuntimeHomePath)).resolves.toBeDefined();

    await writeFile(win32.join(fixture.layout.userDataPath, "boot-created.txt"), "new target state");
    await expect(prepareWindowsStoreTransitionForBoot(fixture.options)).resolves.toMatchObject({
      status: "prepared",
      phase: "cleanup-eligible"
    });
    const secondBoot = await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options);
    expect(secondBoot.status).toBe("cleaned");
    expect(acknowledgeLegacyCleanup).toHaveBeenCalledOnce();
    await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
    await expect(readFile(win32.join(fixture.sourceRuntimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("source-runtime");
    await expect(readFile(win32.join(fixture.layout.userDataPath, "boot-created.txt"), "utf8"))
      .resolves.toBe("new target state");

    const state = await readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    );
    expect(state?.phase).toBe("cleaned");
  });

  it.each([
    ["awaiting-app-verification", ["legacy-finalizer", "legacy-ack"], "cleanup-eligible"],
    ["app-verified", ["legacy-finalizer", "legacy-ack"], "cleanup-eligible"],
    ["legacy-cleanup-complete", ["legacy-finalizer", "legacy-ack"], "cleanup-eligible"],
    ["legacy-cleanup-attested", ["legacy-ack"], "cleanup-eligible"],
    ["cleanup-eligible", ["authority-retirement"], "cleaned"]
  ] as const)("holds the source lease through verified-boot work from %s", async (
    phase,
    protectedActions,
    expectedPhase
  ) => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    await persistVerifiedBootPhase(statePath, phase);
    const actions: string[] = [];

    await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      acquireSourceLease: async (leaseStatePath) => {
        expect(leaseStatePath).toBe(statePath);
        actions.push("lease-acquired");
        return {
          pipeName: "test-source-lease",
          release: async () => {
            await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
              phase: expectedPhase
            });
            actions.push("lease-released");
          }
        };
      },
      finalizeLegacyInstallation: async () => {
        await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();
        actions.push("legacy-finalizer");
      },
      acknowledgeLegacyCleanup: async () => {
        await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
          phase: "legacy-cleanup-attested"
        });
        actions.push("legacy-ack");
      },
      retireLegacyInstallAuthority: async () => {
        await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
          .resolves.toBe("source-account");
        actions.push("authority-retirement");
      }
    });

    expect(actions).toEqual(["lease-acquired", ...protectedActions, "lease-released"]);
  });

  it.each([
    ["app-verified", "finalizeLegacyInstallation", "app-verified"],
    ["legacy-cleanup-attested", "acknowledgeLegacyCleanup", "legacy-cleanup-attested"],
    ["cleanup-eligible", "retireLegacyInstallAuthority", "cleanup-eligible"]
  ] as const)("releases the source lease when %s work fails", async (
    phase,
    failurePoint,
    expectedPhase
  ) => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    await persistVerifiedBootPhase(statePath, phase);
    const actions: string[] = [];
    const injectedError = new Error(`injected ${failurePoint} failure`);

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      acquireSourceLease: async () => {
        actions.push("lease-acquired");
        return {
          pipeName: "test-source-lease",
          release: async () => {
            actions.push("lease-released");
          }
        };
      },
      finalizeLegacyInstallation: async () => {
        actions.push("legacy-finalizer");
        if (failurePoint === "finalizeLegacyInstallation") throw injectedError;
      },
      acknowledgeLegacyCleanup: async () => {
        actions.push("legacy-ack");
        if (failurePoint === "acknowledgeLegacyCleanup") throw injectedError;
      },
      retireLegacyInstallAuthority: async () => {
        actions.push("authority-retirement");
        if (failurePoint === "retireLegacyInstallAuthority") throw injectedError;
      }
    })).rejects.toBe(injectedError);

    expect(actions).toEqual([
      "lease-acquired",
      failurePoint === "finalizeLegacyInstallation"
        ? "legacy-finalizer"
        : failurePoint === "acknowledgeLegacyCleanup"
          ? "legacy-ack"
          : "authority-retirement",
      "lease-released"
    ]);
    await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
      phase: expectedPhase
    });
  });

  it.each([
    "app-verified",
    "cleanup-eligible"
  ] as const)("does not mutate %s while another source process owns the lease", async (phase) => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    await persistVerifiedBootPhase(statePath, phase);
    const competingSourceLease = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(competingSourceLease).not.toBeNull();
    const finalizeLegacyInstallation = vi.fn(async () => undefined);
    const acknowledgeLegacyCleanup = vi.fn(async () => undefined);
    const retireLegacyInstallAuthority = vi.fn(async () => undefined);

    try {
      await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
        acquireSourceLease: (leaseStatePath) => acquireWindowsStoreTransitionSourceLease({
          statePath: leaseStatePath,
          timeoutMs: 50,
          retryIntervalMs: 5
        }),
        finalizeLegacyInstallation,
        acknowledgeLegacyCleanup,
        retireLegacyInstallAuthority
      })).rejects.toBeInstanceOf(WindowsStoreTransitionSourceLeaseTimeoutError);
    } finally {
      await competingSourceLease?.release();
    }

    expect(finalizeLegacyInstallation).not.toHaveBeenCalled();
    expect(acknowledgeLegacyCleanup).not.toHaveBeenCalled();
    expect(retireLegacyInstallAuthority).not.toHaveBeenCalled();
    await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();
    await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({ phase });
  });

  it("keeps the authority-selected shared runtime in place while migrating only user data", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const state = await readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    );
    if (!state) throw new Error("test transition state is missing");
    const prepared = await readWindowsStorePreparedDataTransition(
      resolveWindowsStorePreparedDataTransitionStatePath(
        fixture.localAppDataPath,
        state.transactionId
      )
    );
    expect(prepared?.plan.migrateRuntime).toBe(false);
    expect(prepared?.copies.map((copy) => copy.category)).toEqual(["user-data"]);
    await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation: async () => undefined,
      acknowledgeLegacyCleanup: async () => undefined
    });
    const retireLegacyInstallAuthority = vi.fn(async (state: WindowsStoreTransitionState) => {
      expect(state.phase).toBe("cleanup-eligible");
      await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
        .resolves.toBe("source-account");
    });
    await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      retireLegacyInstallAuthority
    });

    expect(retireLegacyInstallAuthority).toHaveBeenCalledOnce();
    await expect(readFile(win32.join(fixture.layout.runtimeHomePath, "config.yaml"), "utf8"))
      .resolves.toBe("source-runtime");
    await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
  });

  it("retries legacy cleanup without deleting migrated source data on the retrying boot", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const finalizeLegacyInstallation = vi.fn()
      .mockRejectedValueOnce(new Error("injected legacy cleanup failure"))
      .mockResolvedValue(undefined);

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup: async () => undefined
    })).rejects.toThrow("injected legacy cleanup failure");
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "app-verified" });
    await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup: async () => undefined
    })).resolves.toMatchObject({ status: "verified" });
    expect(finalizeLegacyInstallation).toHaveBeenCalledTimes(2);
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "cleanup-eligible" });
    await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options))
      .resolves.toMatchObject({ status: "cleaned" });
    await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
  });

  it("persists attestation before ACK and retries ACK without repeating destructive cleanup", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const finalizeLegacyInstallation = vi.fn(async () => undefined);
    const acknowledgeLegacyCleanup = vi.fn()
      .mockImplementationOnce(async (state: WindowsStoreTransitionState) => {
        expect(state.phase).toBe("legacy-cleanup-attested");
        await expect(readWindowsStoreTransitionState(
          resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
        )).resolves.toMatchObject({ phase: "legacy-cleanup-attested" });
        throw new Error("injected acknowledgement response loss");
      })
      .mockResolvedValue(undefined);

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup
    })).rejects.toThrow("injected acknowledgement response loss");
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "legacy-cleanup-attested" });

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup
    })).resolves.toMatchObject({ status: "verified" });
    expect(finalizeLegacyInstallation).toHaveBeenCalledOnce();
    expect(acknowledgeLegacyCleanup).toHaveBeenCalledTimes(2);
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "cleanup-eligible" });
    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options))
      .resolves.toMatchObject({ status: "cleaned" });
  });

  it("replays an acknowledged cleanup when persisting cleanup eligibility fails", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const finalizeLegacyInstallation = vi.fn(async () => undefined);
    const acknowledgeLegacyCleanup = vi.fn(async () => undefined);
    const injectedError = new Error("injected cleanup-eligible write failure");

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup,
      writeState: async (statePath, state) => {
        if (state.phase === "cleanup-eligible") throw injectedError;
        await writeWindowsStoreTransitionState(statePath, state);
      }
    })).rejects.toBe(injectedError);
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "legacy-cleanup-attested" });

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation,
      acknowledgeLegacyCleanup
    })).resolves.toMatchObject({ status: "verified" });
    expect(finalizeLegacyInstallation).toHaveBeenCalledOnce();
    expect(acknowledgeLegacyCleanup).toHaveBeenCalledTimes(2);
    await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "cleanup-eligible" });

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options))
      .resolves.toMatchObject({ status: "cleaned" });
  });

  it("requires the ACK path before starting destructive legacy cleanup", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const finalizeLegacyInstallation = vi.fn(async () => undefined);

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation
    })).rejects.toThrow("broker acknowledgement is unavailable");
    expect(finalizeLegacyInstallation).not.toHaveBeenCalled();
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "app-verified" });
  });

  it("retries authority retirement without marking the transition cleaned", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation: async () => undefined,
      acknowledgeLegacyCleanup: async () => undefined
    });
    const retireLegacyInstallAuthority = vi.fn()
      .mockRejectedValueOnce(new Error("injected authority retirement failure"))
      .mockResolvedValue(undefined);

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      retireLegacyInstallAuthority
    })).rejects.toThrow("injected authority retirement failure");
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toMatchObject({ phase: "cleanup-eligible" });
    await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
    const state = await readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    );
    if (!state) throw new Error("test transition state is missing");
    await expect(readWindowsStorePreparedDataTransition(
      resolveWindowsStorePreparedDataTransitionStatePath(fixture.localAppDataPath, state.transactionId)
    )).resolves.not.toBeNull();

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      retireLegacyInstallAuthority
    })).resolves.toMatchObject({ status: "cleaned" });
    expect(retireLegacyInstallAuthority).toHaveBeenCalledTimes(2);
  });

  it("rejects a transition journal for another Store package identity", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await expect(prepareWindowsStoreTransitionForBoot({
      ...fixture.options,
      identity: {
        edition: "intl",
        packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
        aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
      }
    })).rejects.toThrow("does not match the running package identity");
  });

  it("still validates package identity after a transition is cleaned", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    const state = await readWindowsStoreTransitionState(statePath);
    if (!state) throw new Error("test transition state is missing");
    await writeWindowsStoreTransitionState(statePath, { ...state, phase: "cleaned" });

    await expect(prepareWindowsStoreTransitionForBoot({
      ...fixture.options,
      identity: {
        edition: "intl",
        packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2",
        aumid: "Memtensor.MemmyAgent_eyack96k521x2!Memmy"
      }
    })).rejects.toThrow("does not match the running package identity");
  });

  it("fails closed before legacy cleanup when an old runtime-copy journal meets a shared-runtime layout", async () => {
    const fixture = await createFixture({ sharedRuntime: false });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    await advanceWindowsStoreTransitionForVerifiedBoot(fixture.options, {
      finalizeLegacyInstallation: async () => undefined,
      acknowledgeLegacyCleanup: async () => undefined
    });
    const finalizeLegacyInstallation = vi.fn(async () => undefined);
    const retireLegacyInstallAuthority = vi.fn(async () => undefined);
    const sharedRuntimeOptions = {
      ...fixture.options,
      layout: {
        ...fixture.options.layout,
        runtimeHomePath: fixture.sourceRuntimeHomePath
      }
    };

    await expect(advanceWindowsStoreTransitionForVerifiedBoot(sharedRuntimeOptions, {
      finalizeLegacyInstallation,
      retireLegacyInstallAuthority
    })).rejects.toThrow("does not match the active journal and layout");
    expect(finalizeLegacyInstallation).not.toHaveBeenCalled();
    expect(retireLegacyInstallAuthority).not.toHaveBeenCalled();
    await expect(stat(fixture.sourceRuntimeHomePath)).resolves.toBeDefined();
  });

  it("archives the journal when data preflight fails so the authoritative NSIS source can restart", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    const { rm } = await import("node:fs/promises");
    await rm(fixture.sourceUserDataPath, { recursive: true, force: true });

    await expect(prepareWindowsStoreTransitionForBoot(fixture.options))
      .rejects.toThrow("source is not a directory");
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    await expect(readWindowsStoreTransitionState(statePath)).resolves.toBeNull();
    await expect(readdir(win32.dirname(statePath))).resolves.toEqual(expect.arrayContaining([
      expect.stringMatching(/^active\.json\.startup-failed-/u)
    ]));
    await expect(resolveWindowsStoreTransitionSourceBarrier({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: fixture.sourceExecutablePath,
      statePath
    })).resolves.toEqual({
      action: "no-transition"
    });
  });

  it("archives the journal when the copy preparation fails before a prepared state exists", async () => {
    const fixture = await createFixture({ sharedRuntime: true });
    await expect(prepareWindowsStoreTransitionForBoot(fixture.options, {
      prepareDataTransition: async () => {
        throw new Error("injected copy failure");
      }
    })).rejects.toThrow("injected copy failure");

    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toBeNull();
    await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
  });

  it("rolls back prepared destinations and archives the journal when pointer creation fails", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    await expect(prepareWindowsStoreTransitionForBoot(fixture.options, {
      writeRuntimePointer: async () => {
        throw new Error("injected pointer failure");
      }
    })).rejects.toThrow("injected pointer failure");

    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toBeNull();
    await expect(readFile(win32.join(fixture.layout.userDataPath, "old-store.txt"), "utf8"))
      .resolves.toBe("old destination");
    await expect(readFile(win32.join(fixture.layout.runtimeHomePath, "old-runtime.txt"), "utf8"))
      .resolves.toBe("old runtime");
  });

  it("restarts a package-registered transaction by rolling back its prepared copy and preparing again", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    const state = await readWindowsStoreTransitionState(statePath);
    expect(state).not.toBeNull();
    await writeWindowsStoreTransitionState(
      statePath,
      advanceWindowsStoreTransitionState(state!, "package-registered")
    );
    const plan = planWindowsStoreDataTransition({
      transactionId: state!.transactionId,
      sourceUserDataPath: state!.sourceUserDataPath,
      sourceRuntimeHomePath: state!.sourceRuntimeHomePath,
      destinationUserDataPath: fixture.layout.userDataPath,
      destinationRuntimeHomePath: fixture.layout.runtimeHomePath,
      migrateRuntime: true
    });
    await prepareWindowsStoreDataTransition(plan, {
      preparedStatePath: resolveWindowsStorePreparedDataTransitionStatePath(
        fixture.localAppDataPath,
        state!.transactionId
      )
    });

    const result = await prepareWindowsStoreTransitionForBoot(fixture.options);
    expect(result).toMatchObject({ status: "prepared", phase: "awaiting-app-verification" });
    await expect(readFile(win32.join(fixture.layout.userDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
  });

  it("acquires the lease before persisting package-registered and holds it through awaiting", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    const actions: string[] = [];

    const result = await prepareWindowsStoreTransitionForBoot(fixture.options, {
      acquireSourceLease: async (leaseStatePath) => {
        await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
          phase: "store-install-launched"
        });
        actions.push("lease-acquired");
        const lease = await acquireWindowsStoreTransitionSourceLease({
          statePath: leaseStatePath,
          timeoutMs: 500,
          retryIntervalMs: 10
        });
        return {
          pipeName: lease.pipeName,
          release: async () => {
            await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
              phase: "awaiting-app-verification"
            });
            actions.push("lease-released");
            await lease.release();
          }
        };
      },
      prepareDataTransition: async (plan, options) => {
        actions.push("copy-committed");
        return prepareWindowsStoreDataTransition(plan, options);
      },
      assertPreparedSourcesUnchanged: async (prepared) => {
        actions.push("source-verified");
        await expect(tryAcquireWindowsStoreTransitionSourceLease(statePath)).resolves.toBeNull();
        await assertWindowsStorePreparedDataTransitionSourcesUnchanged(prepared);
      },
      writeRuntimePointer: async (pointerPath, runtimeHomePath) => {
        actions.push("pointer-written");
        await expect(tryAcquireWindowsStoreTransitionSourceLease(statePath)).resolves.toBeNull();
        await writePointer(pointerPath, runtimeHomePath);
      }
    });

    expect(result).toMatchObject({ status: "prepared", phase: "awaiting-app-verification" });
    expect(actions).toEqual([
      "lease-acquired",
      "copy-committed",
      "source-verified",
      "pointer-written",
      "lease-released"
    ]);
    const afterCoordinator = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(afterCoordinator).not.toBeNull();
    await afterCoordinator?.release();
  });

  it("times out behind a running source before mutating the journal or starting a copy", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    const sourceLease = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(sourceLease).not.toBeNull();
    let copyStarted = false;
    try {
      await expect(prepareWindowsStoreTransitionForBoot(fixture.options, {
        acquireSourceLease: (leaseStatePath) => acquireWindowsStoreTransitionSourceLease({
          statePath: leaseStatePath,
          timeoutMs: 50,
          retryIntervalMs: 5
        }),
        prepareDataTransition: async (plan, options) => {
          copyStarted = true;
          return prepareWindowsStoreDataTransition(plan, options);
        }
      })).rejects.toBeInstanceOf(WindowsStoreTransitionSourceLeaseTimeoutError);
    } finally {
      await sourceLease?.release();
    }

    expect(copyStarted).toBe(false);
    await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
      phase: "store-install-launched"
    });
    await expect(readFile(win32.join(fixture.layout.userDataPath, "old-store.txt"), "utf8"))
      .resolves.toBe("old destination");
    const archivedName = (await readdir(win32.dirname(statePath)))
      .find((name) => /^active\.json\.startup-failed-/u.test(name));
    expect(archivedName).toBeUndefined();
  });

  it("detects a changed source when resuming data-prepared, then rolls back and archives", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    const { statePath, preparedStatePath } = await persistDataPreparedTransition(fixture);
    await writeFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "mutate-account");

    await expect(prepareWindowsStoreTransitionForBoot(fixture.options))
      .rejects.toThrow("tree manifest changed");

    await expect(readWindowsStoreTransitionState(statePath)).resolves.toBeNull();
    await expect(stat(preparedStatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(win32.join(fixture.layout.userDataPath, "old-store.txt"), "utf8"))
      .resolves.toBe("old destination");
    await expect(readFile(win32.join(fixture.layout.runtimeHomePath, "old-runtime.txt"), "utf8"))
      .resolves.toBe("old runtime");
    await expect(readFile(win32.join(fixture.sourceUserDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("mutate-account");
    await expect(resolveWindowsStoreTransitionSourceBarrier({
      platform: "win32",
      isPackaged: true,
      isWindowsStore: false,
      executablePath: fixture.sourceExecutablePath,
      statePath
    })).resolves.toEqual({ action: "no-transition" });

    const archivedNames = await readdir(win32.dirname(statePath));
    expect(archivedNames).toEqual(expect.arrayContaining([
      expect.stringMatching(/^active\.json\.startup-failed-/u),
      expect.stringMatching(/^prepared-data-.*\.json\.startup-failed-/u)
    ]));
  });

  it("resumes an unchanged data-prepared snapshot and advances to awaiting verification", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    const { statePath } = await persistDataPreparedTransition(fixture);
    const actions: string[] = [];

    await expect(prepareWindowsStoreTransitionForBoot(fixture.options, {
      acquireSourceLease: async (leaseStatePath) => {
        actions.push("acquired");
        const lease = await acquireWindowsStoreTransitionSourceLease({ statePath: leaseStatePath });
        return {
          pipeName: lease.pipeName,
          release: async () => {
            actions.push("released");
            await lease.release();
          }
        };
      }
    })).resolves.toMatchObject({
      status: "prepared",
      phase: "awaiting-app-verification"
    });
    expect(actions).toEqual(["acquired", "released"]);
    await expect(readWindowsStoreTransitionState(statePath)).resolves.toMatchObject({
      phase: "awaiting-app-verification"
    });
    await expect(readFile(win32.join(fixture.layout.userDataPath, "app.sqlite"), "utf8"))
      .resolves.toBe("source-account");
    expect(await readPointer(fixture.layout.pointerPath)).toBe(fixture.layout.runtimeHomePath);
  });

  it("rolls back and archives an awaiting transaction when its pointer is damaged before restart", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    await writeFile(fixture.layout.pointerPath, "D:\\wrong-runtime\r\n", "utf8");

    await expect(prepareWindowsStoreTransitionForBoot(fixture.options))
      .rejects.toThrow("data-root pointer does not match");
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toBeNull();
    await expect(readFile(win32.join(fixture.layout.userDataPath, "old-store.txt"), "utf8"))
      .resolves.toBe("old destination");
  });

  it("rolls back and archives a prepared transition after a failed first boot", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    await writeFile(win32.join(fixture.layout.userDataPath, "failed-boot.txt"), "preserve in recovery");

    const rolledBack = await rollbackWindowsStoreTransitionAfterFailedBoot(fixture.options);
    expect(rolledBack.status).toBe("rolled-back");
    await expect(readFile(win32.join(fixture.layout.userDataPath, "old-store.txt"), "utf8"))
      .resolves.toBe("old destination");
    await expect(stat(fixture.sourceUserDataPath)).resolves.toBeDefined();
    await expect(readWindowsStoreTransitionState(
      resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath)
    )).resolves.toBeNull();
  });

  it("leaves rollback state and prepared data unchanged when the source lease is busy", async () => {
    const fixture = await createFixture({ sharedRuntime: false, existingDestination: true });
    await prepareWindowsStoreTransitionForBoot(fixture.options);
    const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
    const state = await readWindowsStoreTransitionState(statePath);
    expect(state).not.toBeNull();
    const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
      fixture.localAppDataPath,
      state!.transactionId
    );
    const beforeState = await readFile(statePath, "utf8");
    const beforePrepared = await readFile(preparedStatePath, "utf8");
    const beforeDestination = await readFile(
      win32.join(fixture.layout.userDataPath, "app.sqlite"),
      "utf8"
    );
    const sourceLease = await tryAcquireWindowsStoreTransitionSourceLease(statePath);
    expect(sourceLease).not.toBeNull();

    try {
      await expect(rollbackWindowsStoreTransitionAfterFailedBoot(fixture.options, {
        acquireSourceLease: (leaseStatePath) => acquireWindowsStoreTransitionSourceLease({
          statePath: leaseStatePath,
          timeoutMs: 50,
          retryIntervalMs: 5
        })
      })).rejects.toBeInstanceOf(WindowsStoreTransitionSourceLeaseTimeoutError);
    } finally {
      await sourceLease?.release();
    }

    await expect(readFile(statePath, "utf8")).resolves.toBe(beforeState);
    await expect(readFile(preparedStatePath, "utf8")).resolves.toBe(beforePrepared);
    await expect(readFile(
      win32.join(fixture.layout.userDataPath, "app.sqlite"),
      "utf8"
    )).resolves.toBe(beforeDestination);
    const archivedName = (await readdir(win32.dirname(statePath)))
      .find((name) => /^active\.json\.startup-failed-/u.test(name));
    expect(archivedName).toBeUndefined();
  });
});

const createFixture = async (options: {
  sharedRuntime: boolean;
  existingDestination?: boolean;
}) => {
  const root = await mkdtemp(win32.join(tmpdir(), "memmy-store-coordinator-"));
  temporaryDirectories.push(root);
  const localAppDataPath = win32.join(root, "LocalAppData");
  const sourceInstallDirectory = win32.join(root, "NSIS", "Memmy");
  const sourceUserDataPath = win32.join(root, "Roaming", "Memmy");
  const sourceRuntimeHomePath = options.sharedRuntime
    ? win32.join(root, "User", ".memmy")
    : win32.join(root, "OtherDrive", "MemmyData", ".memmy");
  const destinationRuntimeHomePath = options.sharedRuntime
    ? sourceRuntimeHomePath
    : win32.join(root, "User", ".memmy");
  const destinationUserDataPath = win32.join(
    localAppDataPath,
    "Packages",
    identity.packageFamilyName,
    "LocalState",
    "Memmy"
  );
  const layout = {
    userDataPath: destinationUserDataPath,
    runtimeHomePath: destinationRuntimeHomePath,
    pointerPath: win32.join(destinationUserDataPath, "data-root.txt")
  };

  await Promise.all([
    mkdir(sourceInstallDirectory, { recursive: true }),
    mkdir(sourceUserDataPath, { recursive: true }),
    mkdir(sourceRuntimeHomePath, { recursive: true })
  ]);
  await Promise.all([
    writeFile(win32.join(sourceInstallDirectory, "Memmy.exe"), "executable"),
    writeFile(win32.join(sourceUserDataPath, "app.sqlite"), "source-account"),
    writeFile(win32.join(sourceUserDataPath, "data-root.txt"), `${sourceRuntimeHomePath}\r\n`, "utf8"),
    writeFile(win32.join(sourceRuntimeHomePath, "config.yaml"), "source-runtime")
  ]);
  if (options.existingDestination) {
    await mkdir(destinationUserDataPath, { recursive: true });
    await writeFile(win32.join(destinationUserDataPath, "old-store.txt"), "old destination");
    if (!options.sharedRuntime) {
      await mkdir(destinationRuntimeHomePath, { recursive: true });
      await writeFile(win32.join(destinationRuntimeHomePath, "old-runtime.txt"), "old runtime");
    }
  }

  let state = createWindowsStoreTransitionState({
    ...identity,
    storeId: "9MZGLKWMZZV6",
    sourceExecutablePath: win32.join(sourceInstallDirectory, "Memmy.exe"),
    sourceInstallDirectory,
    sourceVersion: "1.1.1",
    sourceUserDataPath,
    sourceRuntimeHomePath,
    authority: "current-install-authority"
  });
  state = advanceWindowsStoreTransitionState(state, "store-install-launched");
  await writeWindowsStoreTransitionState(resolveWindowsStoreTransitionStatePath(localAppDataPath), state);

  return {
    localAppDataPath,
    sourceExecutablePath: win32.join(sourceInstallDirectory, "Memmy.exe"),
    sourceUserDataPath,
    sourceRuntimeHomePath,
    layout,
    options: { localAppDataPath, identity, layout }
  };
};

const persistDataPreparedTransition = async (
  fixture: Awaited<ReturnType<typeof createFixture>>
): Promise<{ statePath: string; preparedStatePath: string }> => {
  const statePath = resolveWindowsStoreTransitionStatePath(fixture.localAppDataPath);
  const current = await readWindowsStoreTransitionState(statePath);
  if (!current) throw new Error("test transition state is missing");
  const packageRegistered = advanceWindowsStoreTransitionState(current, "package-registered");
  const dataPrepared = advanceWindowsStoreTransitionState(packageRegistered, "data-prepared");
  const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
    fixture.localAppDataPath,
    current.transactionId
  );
  await prepareWindowsStoreDataTransition(planWindowsStoreDataTransition({
    transactionId: current.transactionId,
    sourceUserDataPath: current.sourceUserDataPath,
    sourceRuntimeHomePath: current.sourceRuntimeHomePath,
    destinationUserDataPath: fixture.layout.userDataPath,
    destinationRuntimeHomePath: fixture.layout.runtimeHomePath,
    migrateRuntime: win32.normalize(fixture.options.layout.runtimeHomePath).toLowerCase()
      !== win32.normalize(current.sourceRuntimeHomePath).toLowerCase()
  }), { preparedStatePath });
  await writeWindowsStoreTransitionState(statePath, dataPrepared);
  return { statePath, preparedStatePath };
};

const persistVerifiedBootPhase = async (
  statePath: string,
  targetPhase: Extract<
    WindowsStoreTransitionState["phase"],
    "awaiting-app-verification" | "app-verified" | "legacy-cleanup-complete"
      | "legacy-cleanup-attested" | "cleanup-eligible"
  >
): Promise<void> => {
  let state = await readWindowsStoreTransitionState(statePath);
  if (!state || state.phase !== "awaiting-app-verification") {
    throw new Error("test transition is not awaiting app verification");
  }
  if (targetPhase === "legacy-cleanup-complete") {
    await writeWindowsStoreTransitionState(statePath, {
      ...state,
      phase: targetPhase,
      updatedAt: state.updatedAt
    });
    return;
  }
  const phases = [
    "awaiting-app-verification",
    "app-verified",
    "legacy-cleanup-attested",
    "cleanup-eligible"
  ] as const;
  const targetIndex = phases.indexOf(targetPhase);
  for (const phase of phases.slice(1, targetIndex + 1)) {
    state = advanceWindowsStoreTransitionState(state, phase);
  }
  await writeWindowsStoreTransitionState(statePath, state);
};

const readPointer = async (path: string): Promise<string> => {
  const bytes = await readFile(path);
  return bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString("utf16le").trim()
    : bytes.toString("utf8").trim();
};

const writePointer = async (path: string, runtimeHomePath: string): Promise<void> => {
  await mkdir(win32.dirname(path), { recursive: true });
  await writeFile(path, Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`${runtimeHomePath}\r\n`, "utf16le")
  ]));
};
