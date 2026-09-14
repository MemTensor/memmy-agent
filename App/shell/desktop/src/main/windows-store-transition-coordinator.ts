import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, win32 } from "node:path";
import {
  assertWindowsStorePreparedDataTransitionSourcesUnchanged,
  cleanupWindowsStoreDataTransition,
  planWindowsStoreDataTransition,
  prepareWindowsStoreDataTransition,
  readWindowsStorePreparedDataTransition,
  resolveWindowsStorePreparedDataTransitionStatePath,
  rollbackWindowsStoreDataTransition,
  type PreparedWindowsStoreDataTransition,
  type WindowsStoreDataTransitionPlan
} from "./windows-store-data-transition.js";
import {
  advanceWindowsStoreTransitionAfterSuccessfulBoot,
  advanceWindowsStoreTransitionState,
  readWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  writeWindowsStoreTransitionState,
  type WindowsStoreTransitionState
} from "./windows-store-transition-state.js";
import {
  acquireWindowsStoreTransitionSourceLease,
  type WindowsStoreTransitionSourceLease
} from "./windows-store-transition-source-lifetime.js";

export interface WindowsStoreTransitionCurrentIdentity {
  edition: "cn" | "intl";
  packageFamilyName: string;
  aumid: string;
}

export interface WindowsStoreTransitionDestinationLayout {
  userDataPath: string;
  runtimeHomePath: string;
  pointerPath: string;
}

export interface WindowsStoreTransitionCoordinatorOptions {
  localAppDataPath: string;
  identity: WindowsStoreTransitionCurrentIdentity;
  layout: WindowsStoreTransitionDestinationLayout;
}

export interface WindowsStoreTransitionCoordinatorDependencies {
  acquireSourceLease?: (statePath: string) => Promise<WindowsStoreTransitionSourceLease>;
  assertPreparedSourcesUnchanged?: typeof assertWindowsStorePreparedDataTransitionSourcesUnchanged;
  prepareDataTransition?: typeof prepareWindowsStoreDataTransition;
  finalizeLegacyInstallation?: (state: WindowsStoreTransitionState) => Promise<void>;
  acknowledgeLegacyCleanup?: (state: WindowsStoreTransitionState) => Promise<void>;
  retireLegacyInstallAuthority?: (state: WindowsStoreTransitionState) => Promise<void>;
  writeState?: typeof writeWindowsStoreTransitionState;
  writeRuntimePointer?: (pointerPath: string, runtimeHomePath: string) => Promise<void>;
}

export type WindowsStoreTransitionPrepareResult =
  | { status: "none" }
  | { status: "prepared"; phase: WindowsStoreTransitionState["phase"]; transactionId: string };

export type WindowsStoreTransitionBootResult =
  | { status: "none" }
  | { status: "verified" | "cleaned"; transactionId: string };

export type WindowsStoreTransitionRollbackResult =
  | { status: "none" }
  | { status: "rolled-back"; transactionId: string; archivedStatePath: string };

export const prepareWindowsStoreTransitionForBoot = async (
  options: WindowsStoreTransitionCoordinatorOptions,
  dependencies: WindowsStoreTransitionCoordinatorDependencies = {}
): Promise<WindowsStoreTransitionPrepareResult> => {
  const writeState = dependencies.writeState ?? writeWindowsStoreTransitionState;
  const statePath = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
  const initialState = await readWindowsStoreTransitionState(statePath);
  if (!initialState) return { status: "none" };
  assertCurrentStoreIdentity(initialState, options.identity);
  if (initialState.phase === "cleaned") return { status: "none" };
  const sourceLease = await (
    dependencies.acquireSourceLease
    ?? ((leaseStatePath) => acquireWindowsStoreTransitionSourceLease({ statePath: leaseStatePath }))
  )(statePath);
  let state: WindowsStoreTransitionState | null = null;

  try {
    state = await readWindowsStoreTransitionState(statePath);
    if (!state) return { status: "none" };
    assertCurrentStoreIdentity(state, options.identity);
    if (state.phase === "cleaned") return { status: "none" };
    const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
      options.localAppDataPath,
      state.transactionId
    );
    if (state.phase === "authority-recorded") {
      throw new Error("Windows Store transition was not launched by the authoritative NSIS installation");
    }
    const plan = createBoundDataPlan(state, options.layout);
    if (state.phase === "store-install-launched") {
      state = advanceWindowsStoreTransitionState(state, "package-registered");
      await writeState(statePath, state);
    }

    let prepared = await readWindowsStorePreparedDataTransition(preparedStatePath);
    if (state.phase === "package-registered") {
      if (prepared) {
        assertPreparedTransitionMatchesPlan(prepared, plan);
        await rollbackWindowsStoreDataTransition(prepared);
        await rm(preparedStatePath, { force: true });
        prepared = null;
      }
      prepared = await (dependencies.prepareDataTransition ?? prepareWindowsStoreDataTransition)(plan, {
        preparedStatePath
      });
      state = advanceWindowsStoreTransitionState(state, "data-prepared");
      await writeState(statePath, state);
    }

    if (!prepared) {
      throw new Error(`Windows Store prepared data transition is missing in phase ${state.phase}`);
    }
    assertPreparedTransitionMatchesPlan(prepared, plan);
    if (state.phase === "data-prepared") {
      await (
        dependencies.assertPreparedSourcesUnchanged
        ?? assertWindowsStorePreparedDataTransitionSourcesUnchanged
      )(prepared);
      await (dependencies.writeRuntimePointer ?? writeWindowsRuntimePointerAtomically)(
        options.layout.pointerPath,
        options.layout.runtimeHomePath
      );
      state = advanceWindowsStoreTransitionState(state, "awaiting-app-verification");
      await writeState(statePath, state);
    }
    if (
      state.phase !== "awaiting-app-verification"
      && state.phase !== "app-verified"
      && state.phase !== "legacy-cleanup-complete"
      && state.phase !== "legacy-cleanup-attested"
      && state.phase !== "cleanup-eligible"
    ) {
      throw new Error(`Windows Store transition cannot boot from phase ${state.phase}`);
    }
    await assertWindowsRuntimePointer(options.layout.pointerPath, options.layout.runtimeHomePath);
    return { status: "prepared", phase: state.phase, transactionId: state.transactionId };
  } catch (cause) {
    if (state) {
      await recoverFailedPreparationWhileSourceLeaseHeld(options, state, cause);
    }
    throw cause;
  } finally {
    await sourceLease.release();
  }
};

export const advanceWindowsStoreTransitionForVerifiedBoot = async (
  options: WindowsStoreTransitionCoordinatorOptions,
  dependencies: WindowsStoreTransitionCoordinatorDependencies = {}
): Promise<WindowsStoreTransitionBootResult> => {
  const writeState = dependencies.writeState ?? writeWindowsStoreTransitionState;
  const statePath = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
  const initialState = await readWindowsStoreTransitionState(statePath);
  if (!initialState) return { status: "none" };
  assertCurrentStoreIdentity(initialState, options.identity);
  if (initialState.phase === "cleaned") return { status: "none" };
  const sourceLease = await (
    dependencies.acquireSourceLease
    ?? ((leaseStatePath) => acquireWindowsStoreTransitionSourceLease({ statePath: leaseStatePath }))
  )(statePath);

  try {
    let state = await readWindowsStoreTransitionState(statePath);
    if (!state) return { status: "none" };
    assertCurrentStoreIdentity(state, options.identity);
    if (state.phase === "cleaned") return { status: "none" };
    const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
      options.localAppDataPath,
      state.transactionId
    );
    const prepared = await readRequiredPreparedTransition(state, options.layout, preparedStatePath);

    if (state.phase === "awaiting-app-verification") {
      state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state);
      await writeState(statePath, state);
    }
    if (state.phase === "app-verified" || state.phase === "legacy-cleanup-complete") {
      if (!dependencies.finalizeLegacyInstallation) {
        throw new Error("Windows native legacy cleanup broker finalizer is unavailable");
      }
      if (!dependencies.acknowledgeLegacyCleanup) {
        throw new Error("Windows native legacy cleanup broker acknowledgement is unavailable");
      }
      await dependencies.finalizeLegacyInstallation(state);
      state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state);
      await writeState(statePath, state);
      await dependencies.acknowledgeLegacyCleanup(state);
      state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state);
      await writeState(statePath, state);
      return { status: "verified", transactionId: state.transactionId };
    }
    if (state.phase === "legacy-cleanup-attested") {
      if (!dependencies.acknowledgeLegacyCleanup) {
        throw new Error("Windows native legacy cleanup broker acknowledgement is unavailable");
      }
      await dependencies.acknowledgeLegacyCleanup(state);
      state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state);
      await writeState(statePath, state);
      return { status: "verified", transactionId: state.transactionId };
    }
    if (state.phase !== "cleanup-eligible") {
      throw new Error(`Windows Store transition cannot verify a boot from phase ${state.phase}`);
    }

    // Keep the verified NSIS data baseline outside PFN-scoped LocalState. A normal
    // MSIX uninstall removes package data, so deleting this source would leave a
    // same-drive NSIS reinstall with no recoverable account/profile state.
    await cleanupWindowsStoreDataTransition(prepared, {
      cleanupEligible: true,
      preserveSources: true
    });
    await dependencies.retireLegacyInstallAuthority?.(state);
    state = advanceWindowsStoreTransitionState(state, "cleaned");
    await writeState(statePath, state);
    await rm(preparedStatePath, { force: true });
    return { status: "cleaned", transactionId: state.transactionId };
  } finally {
    await sourceLease.release();
  }
};

export const rollbackWindowsStoreTransitionAfterFailedBoot = async (
  options: WindowsStoreTransitionCoordinatorOptions,
  dependencies: Pick<WindowsStoreTransitionCoordinatorDependencies, "acquireSourceLease"> = {}
): Promise<WindowsStoreTransitionRollbackResult> => {
  const statePath = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
  const initialState = await readWindowsStoreTransitionState(statePath);
  if (!initialState) return { status: "none" };
  assertCurrentStoreIdentity(initialState, options.identity);
  if (!isRollbackEligiblePhase(initialState.phase)) return { status: "none" };
  const sourceLease = await (
    dependencies.acquireSourceLease
    ?? ((leaseStatePath) => acquireWindowsStoreTransitionSourceLease({ statePath: leaseStatePath }))
  )(statePath);
  try {
    const state = await readWindowsStoreTransitionState(statePath);
    if (!state) return { status: "none" };
    assertCurrentStoreIdentity(state, options.identity);
    if (!isRollbackEligiblePhase(state.phase)) return { status: "none" };
    return rollbackWindowsStoreTransitionAfterFailedBootWhileSourceLeaseHeld(options, state);
  } finally {
    await sourceLease.release();
  }
};

const rollbackWindowsStoreTransitionAfterFailedBootWhileSourceLeaseHeld = async (
  options: WindowsStoreTransitionCoordinatorOptions,
  state: WindowsStoreTransitionState
): Promise<WindowsStoreTransitionRollbackResult> => {
  const statePath = resolveWindowsStoreTransitionStatePath(options.localAppDataPath);
  const preparedStatePath = resolveWindowsStorePreparedDataTransitionStatePath(
    options.localAppDataPath,
    state.transactionId
  );
  const prepared = await readWindowsStorePreparedDataTransition(preparedStatePath);
  if (prepared) {
    assertPreparedTransitionMatchesPlan(prepared, createBoundDataPlan(state, options.layout));
    await rollbackWindowsStoreDataTransition(prepared);
  }

  const archiveSuffix = `startup-failed-${Date.now()}-${randomUUID()}`;
  const archivedStatePath = `${statePath}.${archiveSuffix}`;
  const archivedPreparedStatePath = `${preparedStatePath}.${archiveSuffix}`;
  await rename(statePath, archivedStatePath);
  if (prepared) {
    await rename(preparedStatePath, archivedPreparedStatePath).catch(async (error: unknown) => {
      await rename(archivedStatePath, statePath).catch(() => undefined);
      throw error;
    });
  }
  return { status: "rolled-back", transactionId: state.transactionId, archivedStatePath };
};

const recoverFailedPreparationWhileSourceLeaseHeld = async (
  options: WindowsStoreTransitionCoordinatorOptions,
  state: WindowsStoreTransitionState,
  originalError: unknown
): Promise<void> => {
  if (!isRollbackEligiblePhase(state.phase)) return;
  try {
    await rollbackWindowsStoreTransitionAfterFailedBootWhileSourceLeaseHeld(options, state);
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "Windows Store transition preparation failed and rollback was incomplete"
    );
  }
};

const isRollbackEligiblePhase = (phase: WindowsStoreTransitionState["phase"]): boolean => [
  "authority-recorded",
  "store-install-launched",
  "package-registered",
  "data-prepared",
  "awaiting-app-verification"
].includes(phase);

const createBoundDataPlan = (
  state: WindowsStoreTransitionState,
  layout: WindowsStoreTransitionDestinationLayout
): WindowsStoreDataTransitionPlan => planWindowsStoreDataTransition({
  transactionId: state.transactionId,
  sourceUserDataPath: state.sourceUserDataPath,
  sourceRuntimeHomePath: state.sourceRuntimeHomePath,
  destinationUserDataPath: layout.userDataPath,
  destinationRuntimeHomePath: layout.runtimeHomePath,
  migrateRuntime: !sameWindowsPath(state.sourceRuntimeHomePath, layout.runtimeHomePath)
});

const readRequiredPreparedTransition = async (
  state: WindowsStoreTransitionState,
  layout: WindowsStoreTransitionDestinationLayout,
  preparedStatePath: string
): Promise<PreparedWindowsStoreDataTransition> => {
  const prepared = await readWindowsStorePreparedDataTransition(preparedStatePath);
  if (!prepared) throw new Error("Windows Store prepared data transition is missing");
  assertPreparedTransitionMatchesPlan(prepared, createBoundDataPlan(state, layout));
  return prepared;
};

const assertCurrentStoreIdentity = (
  state: WindowsStoreTransitionState,
  identity: WindowsStoreTransitionCurrentIdentity
): void => {
  if (
    state.edition !== identity.edition
    || state.packageFamilyName !== identity.packageFamilyName
    || state.aumid !== identity.aumid
  ) {
    throw new Error("Windows Store transition does not match the running package identity");
  }
};

const assertPreparedTransitionMatchesPlan = (
  prepared: PreparedWindowsStoreDataTransition,
  expected: WindowsStoreDataTransitionPlan
): void => {
  const actual = prepared.plan;
  const scalarKeys: ReadonlyArray<keyof Omit<WindowsStoreDataTransitionPlan, "copies">> = [
    "transactionId",
    "sourceUserDataPath",
    "sourceRuntimeHomePath",
    "destinationUserDataPath",
    "destinationRuntimeHomePath",
    "migrateRuntime"
  ];
  if (
    scalarKeys.some((key) => actual[key] !== expected[key])
    || actual.copies.length !== expected.copies.length
    || actual.copies.some((copy, index) => {
      const expectedCopy = expected.copies[index];
      return !expectedCopy
        || copy.category !== expectedCopy.category
        || copy.sourcePath !== expectedCopy.sourcePath
        || copy.destinationPath !== expectedCopy.destinationPath
        || copy.stagingPath !== expectedCopy.stagingPath
        || copy.backupPath !== expectedCopy.backupPath
        || copy.recoveryPath !== expectedCopy.recoveryPath;
    })
  ) {
    throw new Error("Windows Store prepared data transition does not match the active journal and layout");
  }
};

const writeWindowsRuntimePointerAtomically = async (pointerPath: string, runtimeHomePath: string): Promise<void> => {
  const normalizedPointerPath = normalizeAbsoluteWindowsPath(pointerPath, "data-root pointer");
  const normalizedRuntimeHomePath = normalizeAbsoluteWindowsPath(runtimeHomePath, "runtime home");
  await mkdir(dirname(normalizedPointerPath), { recursive: true });
  const temporaryPath = `${normalizedPointerPath}.${process.pid}.${randomUUID()}.tmp`;
  const contents = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`${normalizedRuntimeHomePath}\r\n`, "utf16le")
  ]);
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, normalizedPointerPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
};

const assertWindowsRuntimePointer = async (pointerPath: string, runtimeHomePath: string): Promise<void> => {
  const bytes = await readFile(pointerPath);
  const value = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
    ? bytes.subarray(2).toString("utf16le").trim()
    : bytes.toString("utf8").replace(/^\uFEFF/u, "").trim();
  if (!sameWindowsPath(value, runtimeHomePath)) {
    throw new Error("Windows Store data-root pointer does not match the destination runtime");
  }
};

const normalizeAbsoluteWindowsPath = (value: string, label: string): string => {
  if (!value || value !== value.trim() || !win32.isAbsolute(value)) {
    throw new Error(`Windows Store ${label} path must be absolute`);
  }
  const normalized = win32.normalize(value);
  if (normalized === win32.parse(normalized).root) {
    throw new Error(`Windows Store ${label} path must not be a drive root`);
  }
  return normalized;
};

const sameWindowsPath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
