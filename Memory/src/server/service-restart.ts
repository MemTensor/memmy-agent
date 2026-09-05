import { restartInstalledMemoryService } from "../cli/runtime-installer.js";

export const DESKTOP_MANAGED_MEMORY_ENV = "MEMMY_DESKTOP_MANAGED_MEMORY";
export const MEMORY_RESTART_IPC_TYPE = "memmy-memory:restart";

export interface MemoryServiceRestartDependencies {
  env?: NodeJS.ProcessEnv;
  send?: ((message: unknown, callback: (error: Error | null) => void) => void) | null;
  restartInstalled?: () => void | Promise<void>;
  restartLocal?: () => void | Promise<void>;
}

export async function requestMemoryServiceRestart(
  dependencies: MemoryServiceRestartDependencies = {}
): Promise<void> {
  const env = dependencies.env ?? process.env;
  if (env[DESKTOP_MANAGED_MEMORY_ENV] !== "1") {
    return Promise.resolve(
      (dependencies.restartInstalled ?? restartInstalledMemoryService)()
    );
  }

  const send = dependencies.send === undefined ? processSend() : dependencies.send;
  if (send) {
    try {
      await new Promise<void>((resolveRestart, rejectRestart) => {
        send({ type: MEMORY_RESTART_IPC_TYPE }, (error) => {
          if (error) rejectRestart(error);
          else resolveRestart();
        });
      });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ERR_IPC_CHANNEL_CLOSED" && code !== "ERR_IPC_DISCONNECTED" && code !== "EPIPE") throw error;
    }
  }
  // Detached Memory outlives Desktop and cannot reconnect its original IPC pipe.
  if (!dependencies.restartLocal) throw new Error("Desktop-managed Memory restart is unavailable");
  await dependencies.restartLocal();
}

function processSend(): MemoryServiceRestartDependencies["send"] {
  if (typeof process.send !== "function" || !process.connected) return undefined;
  return (message, callback) => {
    process.send!(message, callback);
  };
}
