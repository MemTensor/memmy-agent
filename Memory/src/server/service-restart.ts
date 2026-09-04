import { restartInstalledMemoryService } from "../cli/runtime-installer.js";

export const DESKTOP_MANAGED_MEMORY_ENV = "MEMMY_DESKTOP_MANAGED_MEMORY";
export const MEMORY_RESTART_IPC_TYPE = "memmy-memory:restart";

export interface MemoryServiceRestartDependencies {
  env?: NodeJS.ProcessEnv;
  send?: ((message: unknown, callback: (error: Error | null) => void) => void) | null;
  restartInstalled?: () => void | Promise<void>;
}

export function requestMemoryServiceRestart(
  dependencies: MemoryServiceRestartDependencies = {}
): Promise<void> {
  const env = dependencies.env ?? process.env;
  if (env[DESKTOP_MANAGED_MEMORY_ENV] !== "1") {
    return Promise.resolve(
      (dependencies.restartInstalled ?? restartInstalledMemoryService)()
    );
  }

  const send = dependencies.send === undefined ? processSend() : dependencies.send;
  if (!send) {
    throw new Error("Desktop-managed Memory restart requires an IPC channel");
  }
  return new Promise<void>((resolveRestart, rejectRestart) => {
    send({ type: MEMORY_RESTART_IPC_TYPE }, (error) => {
      if (error) rejectRestart(error);
      else resolveRestart();
    });
  });
}

function processSend(): MemoryServiceRestartDependencies["send"] {
  if (typeof process.send !== "function" || !process.connected) return undefined;
  return (message, callback) => {
    process.send!(message, callback);
  };
}
