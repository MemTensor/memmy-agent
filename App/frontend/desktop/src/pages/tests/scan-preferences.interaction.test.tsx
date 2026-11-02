// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppProviders, useApiClients } from "../../app/providers.js";
import { useAppState } from "../../state/app-state.js";
import { appActions } from "../../state/app-actions.js";
import type { AppClients } from "../../api/client-types.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
import { MemorySourcesContent } from "../memory-sources-page.js";
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: vi.fn() }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([false, true])("keeps the last toggle while grant is delayed (final on=%s)", async finalOn => {
  let release!: () => void;
  const grant = new Promise<void>(resolve => { release = resolve; });
  let stored = { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false };
  const clients = {
    runtimeConfig: {},
    config: {
      getScanPreferences: vi.fn(async () => stored),
      updateOnboarding: vi.fn(async () => { await grant; return { ...mockBootstrap.onboarding, scanPermission: "scan_only" }; }),
      updateScanPreferences: vi.fn(async patch => { stored = { ...stored, ...patch }; return stored; })
    },
    memoryRuntime: { health: vi.fn(async () => ({ ok: true, storage: { ready: true } })) },
    agentSources: { listSources: vi.fn(async () => []) },
    localData: { getPath: vi.fn(async () => ({ dataPath: "/tmp/synthetic" })) }
  } as unknown as AppClients;
  function Harness() {
    const { setClients } = useApiClients();
    const { dispatch } = useAppState();
    useEffect(() => {
      setClients(clients);
      dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, onboarding: { ...mockBootstrap.onboarding, scanPermission: "none" } }, "/memory/sources"));
      dispatch(appActions.scanPreferencesUpdated(stored));
    }, [setClients, dispatch]);
    return <MemorySourcesContent />;
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<AppProviders><Harness /></AppProviders>); });
    const toggle = () => container.querySelectorAll<HTMLButtonElement>('[role="switch"]')[0]!;
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    if (finalOn) await act(async () => { toggle().click(); });
    expect(clients.config.updateScanPreferences).not.toHaveBeenCalled();
    await act(async () => { release(); await grant; });
    expect(stored.autoScanKnownAgents).toBe(finalOn);
    expect(toggle().getAttribute("aria-checked")).toBe(String(finalOn));
  } finally { release(); act(() => root.unmount()); container.remove(); }
});
