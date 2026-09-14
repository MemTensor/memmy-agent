import { existsSync } from "node:fs";
import { win32 } from "node:path";

interface ResolveWindowsStorePackagedResourcesPathOptions {
  isPackaged: boolean;
  isWindowsStore: boolean;
  moduleDirectory: string;
  resourcesPath: string;
}

interface ResolveWindowsStorePackagedResourcesPathDependencies {
  pathExists?: (path: string) => boolean;
}

/**
 * Resolves the physical package Resources directory for files that must be copied out of MSIX.
 * `process.resourcesPath` can expose the C:\Program Files\WindowsApps projection even when the
 * package is physically installed on another drive; Node copyfile cannot read that projection.
 */
export const resolveWindowsStorePackagedResourcesPath = (
  options: ResolveWindowsStorePackagedResourcesPathOptions,
  dependencies: ResolveWindowsStorePackagedResourcesPathDependencies = {}
): string => {
  if (!options.isPackaged || !options.isWindowsStore) return options.resourcesPath;
  const physicalResourcesPath = win32.resolve(options.moduleDirectory, "..", "..", "..");
  if (win32.basename(physicalResourcesPath).toLowerCase() !== "resources") {
    return options.resourcesPath;
  }
  const helperPath = win32.join(physicalResourcesPath, "native", "MemmyStoreUpdate.exe");
  return (dependencies.pathExists ?? existsSync)(helperPath)
    ? physicalResourcesPath
    : options.resourcesPath;
};
