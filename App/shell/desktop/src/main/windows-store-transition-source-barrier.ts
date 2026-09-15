import {
  readWindowsStoreTransitionState,
  type WindowsStoreTransitionState
} from "./windows-store-transition-state.js";
import { queryWindowsPackageFamilyRegistration } from "./windows-store-package-registration.js";
import { archiveOrphanedWindowsStoreTransition } from "./windows-store-transition-orphan-recovery.js";

export interface WindowsStoreTransitionSourceBarrierOptions {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  isWindowsStore: boolean;
  executablePath: string;
  statePath: string;
  resourcesPath?: string;
}

export interface WindowsStoreTransitionSourceBarrierDependencies {
  readState?: (statePath: string) => Promise<WindowsStoreTransitionState | null>;
  queryPackageRegistration?: typeof queryWindowsPackageFamilyRegistration;
  archiveOrphanedTransition?: typeof archiveOrphanedWindowsStoreTransition;
}

export type WindowsStoreTransitionSourceBarrierDecision =
  | { action: "not-applicable" | "no-transition" | "different-source" | "allow-source" }
  | { action: "orphan-recovered"; phase: WindowsStoreTransitionState["phase"]; archivedStatePath: string }
  | { action: "block-source"; phase: WindowsStoreTransitionState["phase"] };

export const resolveWindowsStoreTransitionSourceBarrier = async (
  options: WindowsStoreTransitionSourceBarrierOptions,
  dependencies: WindowsStoreTransitionSourceBarrierDependencies = {}
): Promise<WindowsStoreTransitionSourceBarrierDecision> => {
  if (options.platform !== "win32" || !options.isPackaged || options.isWindowsStore) {
    return { action: "not-applicable" };
  }

  const state = await (dependencies.readState ?? readWindowsStoreTransitionState)(options.statePath);
  if (!state) return { action: "no-transition" };
  if (!options.resourcesPath) {
    throw new Error("Windows Store transition source barrier resources path is unavailable");
  }
  const registration = await (
    dependencies.queryPackageRegistration ?? queryWindowsPackageFamilyRegistration
  )({
    resourcesPath: options.resourcesPath,
    packageFamilyName: state.packageFamilyName
  });
  if (registration.registered) return { action: "block-source", phase: state.phase };

  // Once the Store package is gone, the active transaction is orphaned even if
  // NSIS was reinstalled to another directory. Archive it before allowing the
  // current NSIS process so a future Store migration can create a fresh binding.
  const archived = await (
    dependencies.archiveOrphanedTransition ?? archiveOrphanedWindowsStoreTransition
  )({
    statePath: options.statePath,
    expectedState: state
  });
  return {
    action: "orphan-recovered",
    phase: state.phase,
    archivedStatePath: archived.archivedStatePath
  };
};
