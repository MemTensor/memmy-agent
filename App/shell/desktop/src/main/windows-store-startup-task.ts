import {
  runWindowsStoreUpdate,
  type RunWindowsStoreUpdateOptions,
  type WindowsStoreStartupTaskState,
  type WindowsStoreUpdateResult
} from "./windows-store-update.js";

export const WINDOWS_STORE_STARTUP_TASK_ID = "MemmyStartupTask";

export interface WindowsStoreStartupTaskStatus {
  taskId: typeof WINDOWS_STORE_STARTUP_TASK_ID;
  state: WindowsStoreStartupTaskState;
  enabled: boolean;
}

type WindowsStoreCommandRunner = (
  options: RunWindowsStoreUpdateOptions
) => Promise<WindowsStoreUpdateResult>;

interface WindowsStoreStartupTaskDependencies {
  runStoreCommand?: WindowsStoreCommandRunner;
}

export const getWindowsStoreStartupTaskStatus = async (
  resourcesPath: string,
  dependencies: WindowsStoreStartupTaskDependencies = {}
): Promise<WindowsStoreStartupTaskStatus> => runStartupTaskCommand(
  resourcesPath,
  "startup-status",
  dependencies
);

export const setWindowsStoreStartupTaskEnabled = async (
  resourcesPath: string,
  enabled: boolean,
  dependencies: WindowsStoreStartupTaskDependencies = {}
): Promise<WindowsStoreStartupTaskStatus> => runStartupTaskCommand(
  resourcesPath,
  enabled ? "startup-enable" : "startup-disable",
  dependencies
);

const runStartupTaskCommand = async (
  resourcesPath: string,
  command: "startup-status" | "startup-enable" | "startup-disable",
  dependencies: WindowsStoreStartupTaskDependencies
): Promise<WindowsStoreStartupTaskStatus> => {
  const runStoreCommand = dependencies.runStoreCommand ?? runWindowsStoreUpdate;
  const result = await runStoreCommand({ resourcesPath, command });
  return normalizeStartupTaskResult(result);
};

const normalizeStartupTaskResult = (
  result: WindowsStoreUpdateResult
): WindowsStoreStartupTaskStatus => {
  if (result.type !== "startup-task") {
    throw new Error("Microsoft Store StartupTask helper returned an unexpected result type");
  }
  if (result.taskId !== WINDOWS_STORE_STARTUP_TASK_ID) {
    throw new Error("Microsoft Store StartupTask helper returned an unexpected task ID");
  }
  return {
    taskId: WINDOWS_STORE_STARTUP_TASK_ID,
    state: result.state,
    enabled: result.state === "enabled"
  };
};
