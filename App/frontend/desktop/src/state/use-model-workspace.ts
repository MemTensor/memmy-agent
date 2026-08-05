import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelProviderConfig } from "../api/config-client.js";
import {
  MODEL_WORKSPACE_STORAGE_KEY,
  persistModelWorkspace,
  readModelWorkspace,
  subscribeModelWorkspace,
  type ModelWorkspace
} from "./model-workspace.js";

export interface ModelWorkspaceStore {
  workspace: ModelWorkspace;
  commit: (next: ModelWorkspace) => boolean;
}

/** React adapter for the localStorage workspace and same-window event channel. */
export function useModelWorkspace(saved?: ModelProviderConfig | null): ModelWorkspaceStore {
  const seedRef = useRef(saved);
  const readCurrent = useCallback(() => readModelWorkspace(
    typeof window === "undefined" ? undefined : window.localStorage,
    seedRef.current
  ), []);
  const [workspace, setWorkspace] = useState<ModelWorkspace>(readCurrent);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!window.localStorage.getItem(MODEL_WORKSPACE_STORAGE_KEY)) {
      persistModelWorkspace(window.localStorage, workspace, window);
    }
    return subscribeModelWorkspace(() => setWorkspace(readCurrent()), window);
  }, [readCurrent, workspace]);

  const commit = useCallback((next: ModelWorkspace) => {
    if (typeof window === "undefined") {
      setWorkspace(next);
      return true;
    }
    if (!persistModelWorkspace(window.localStorage, next, window)) {
      return false;
    }
    setWorkspace(next);
    return true;
  }, []);

  return { workspace, commit };
}
