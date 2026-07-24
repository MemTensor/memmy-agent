// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppClients } from "../../../api/client-types.js";
import { AppProviders, useApiClients } from "../../../app/providers.js";
import { SourcesSubPage } from "../sources-sub-page.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SourcesSubPage local data path", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: createMemoryStorage() });
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: createMemoryStorage() });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("loads the actual Windows data path without opening the directory", async () => {
    const windowsDataPath = "C:\\Users\\memmy-user\\.memmy\\memory-service";
    let resolvePath!: (result: { ok: true; dataPath: string }) => void;
    const pathPromise = new Promise<{ ok: true; dataPath: string }>((resolve) => {
      resolvePath = resolve;
    });
    const getPath = vi.fn(() => pathPromise);
    const reveal = vi.fn(async () => ({ ok: true as const, dataPath: windowsDataPath }));
    const clients = {
      runtimeConfig: {
        baseUrl: "http://127.0.0.1:18100",
        localToken: "local-token",
        memory: { baseUrl: "http://127.0.0.1:18960" }
      },
      localData: {
        getPath,
        reveal
      },
      memoryRuntime: {
        async health() {
          return { ok: true, storage: { ready: true } };
        }
      }
    } as unknown as AppClients;

    await act(async () => {
      root.render(
        <AppProviders>
          <ClientsHarness clients={clients} />
        </AppProviders>
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getPath).toHaveBeenCalledTimes(1);
    expect(reveal).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("~/.memmy/memory-service");
    expect(container.textContent).not.toContain(windowsDataPath);

    await act(async () => {
      resolvePath({ ok: true, dataPath: windowsDataPath });
      await pathPromise;
    });

    expect(container.textContent).toContain(windowsDataPath);
    expect(container.textContent).not.toContain("~/.memmy/memory-service");
  });
});

function ClientsHarness(props: { clients: AppClients }) {
  const { setClients } = useApiClients();

  useEffect(() => {
    setClients(props.clients);
  }, [props.clients, setClients]);

  return <SourcesSubPage />;
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}
