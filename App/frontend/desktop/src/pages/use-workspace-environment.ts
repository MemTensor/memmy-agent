import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemmyAgentClient,
  WorkspaceEnvironmentScope,
  WorkspaceEnvironmentState,
} from "../api/memmy-agent-client.js";

export type WorkspaceEnvironmentQuery = {
  data: WorkspaceEnvironmentState | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  switchBranch: (branch: string) => Promise<boolean>;
  createOrCheckoutBranch: (branch: string) => Promise<boolean>;
};

export function resolveWorkspaceEnvironmentScope(
  sessionKey: string | null,
  projectId: string | null,
): WorkspaceEnvironmentScope | null {
  if (sessionKey) return { kind: "session", key: sessionKey };
  if (projectId) return { kind: "project", key: projectId };
  return null;
}

export function useWorkspaceEnvironment(
  client: MemmyAgentClient | null,
  scope: WorkspaceEnvironmentScope | null,
  refreshSignal: boolean,
): WorkspaceEnvironmentQuery {
  const [data, setData] = useState<WorkspaceEnvironmentState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const previousRefreshSignalRef = useRef(refreshSignal);
  const scopeKind = scope?.kind ?? null;
  const scopeKey = scope?.key ?? null;

  const refresh = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!client || !scopeKind || !scopeKey) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const next = await client.readWorkspaceEnvironment({ kind: scopeKind, key: scopeKey });
      if (requestId === requestIdRef.current) setData(next);
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [client, scopeKey, scopeKind]);

  const mutateBranch = useCallback(async (
    branch: string,
    operation: "switch" | "create-or-checkout",
  ): Promise<boolean> => {
    if (!client || !scopeKind || !scopeKey || !data) return false;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = operation === "create-or-checkout"
        ? await client.createOrCheckoutWorkspaceEnvironmentBranch(
          { kind: scopeKind, key: scopeKey },
          branch,
          data.snapshot.revision,
        )
        : await client.switchWorkspaceEnvironmentBranch(
          { kind: scopeKind, key: scopeKey },
          branch,
          data.snapshot.revision,
        );
      if (requestId !== requestIdRef.current) return false;
      setData(next);
      return true;
    } catch (cause) {
      if (requestId === requestIdRef.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [client, data, scopeKey, scopeKind]);

  const switchBranch = useCallback(
    (branch: string) => mutateBranch(branch, "switch"),
    [mutateBranch],
  );
  const createOrCheckoutBranch = useCallback(
    (branch: string) => mutateBranch(branch, "create-or-checkout"),
    [mutateBranch],
  );

  useEffect(() => {
    setData(null);
    void refresh();
    return () => {
      requestIdRef.current += 1;
    };
  }, [refresh]);

  useEffect(() => {
    if (previousRefreshSignalRef.current !== refreshSignal) {
      previousRefreshSignalRef.current = refreshSignal;
      void refresh();
    }
  }, [refresh, refreshSignal]);

  useEffect(() => {
    function refreshOnFocus() {
      void refresh();
    }
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [refresh]);

  return { data, loading, error, refresh, switchBranch, createOrCheckoutBranch };
}
