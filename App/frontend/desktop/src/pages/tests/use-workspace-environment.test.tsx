// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MemmyAgentClient,
  WorkspaceEnvironmentScope,
  WorkspaceEnvironmentState,
} from "../../api/memmy-agent-client.js";
import { useWorkspaceEnvironment } from "../use-workspace-environment.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function environment(scope: WorkspaceEnvironmentScope): WorkspaceEnvironmentState {
  return {
    snapshot: {
      scope_kind: scope.kind,
      scope_key: scope.key,
      cwd: `/workspace/${scope.key}`,
      status: "not_git",
      revision: `revision-${scope.key}`,
      captured_at: "2026-08-11T08:00:00.000Z",
      repository: null,
      changes: null,
      goal: null,
    },
    files: [],
    branches: [scope.key],
  };
}

function Probe({ client, scope }: { client: MemmyAgentClient; scope: WorkspaceEnvironmentScope }) {
  const query = useWorkspaceEnvironment(client, scope, false);
  return <span>{query.data?.snapshot.scope_key ?? (query.loading ? "loading" : query.error ?? "empty")}</span>;
}

describe("useWorkspaceEnvironment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("ignores a stale response after switching workspace scope", async () => {
    const first = deferred<WorkspaceEnvironmentState>();
    const second = deferred<WorkspaceEnvironmentState>();
    const readWorkspaceEnvironment = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const client = { readWorkspaceEnvironment } as unknown as MemmyAgentClient;

    await act(async () => {
      root.render(<Probe client={client} scope={{ kind: "project", key: "project-1" }} />);
    });
    await act(async () => {
      root.render(<Probe client={client} scope={{ kind: "project", key: "project-2" }} />);
    });
    await act(async () => second.resolve(environment({ kind: "project", key: "project-2" })));
    expect(container.textContent).toBe("project-2");

    await act(async () => first.resolve(environment({ kind: "project", key: "project-1" })));
    expect(container.textContent).toBe("project-2");
  });
});
