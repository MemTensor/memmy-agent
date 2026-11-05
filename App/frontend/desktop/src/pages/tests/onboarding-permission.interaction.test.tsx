// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppProviders, useApiClients } from "../../app/providers.js";
import { useAppState } from "../../state/app-state.js";
import { appActions } from "../../state/app-actions.js";
import type { AppClients } from "../../api/client-types.js";
import { mockBootstrap } from "./fixtures/bootstrap.js";
import { OnboardingPage } from "../onboarding-page.js";
vi.mock("../home-page.js", () => ({ HomePage: () => null }));
vi.mock("../../analytics/use-analytics.js", () => ({ useAnalytics: () => ({ track: vi.fn() }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps the permission choice on pending/failure, allows retry, and only advances after server acknowledgement", async () => {
  let reject!: (error: Error) => void;
  let resolve!: (value: unknown) => void;
  const updateOnboarding = vi.fn().mockImplementationOnce(() => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }))
    .mockImplementationOnce(() => new Promise(resolvePromise => { resolve = resolvePromise; }));
  const updateScanPreferences = vi.fn();
  const clients = { config: { updateOnboarding, updateScanPreferences } } as unknown as AppClients;
  let stateApi!: ReturnType<typeof useAppState>;
  function Harness() {
    const { setClients } = useApiClients();
    stateApi = useAppState();
    const { dispatch } = stateApi;
    useEffect(() => {
      setClients(clients);
      dispatch(appActions.bootstrapLoaded({ ...mockBootstrap, app: { ...mockBootstrap.app, language: "zh-CN" } }, "/onboarding"));
    }, [setClients, dispatch]);
    return <OnboardingPage />;
  }
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await act(async () => { root.render(<AppProviders><Harness /></AppProviders>); });
    const deny = () => Array.from(container.querySelectorAll("button")).find(button => button.textContent?.includes("不允许"))!;
    expect(deny()).toBeDefined();
    await act(async () => { deny().click(); deny().click(); });
    expect(updateOnboarding).toHaveBeenCalledTimes(1);
    expect(deny().disabled).toBe(true);
    expect(stateApi.state.bootstrap?.onboarding.scanPermission).toBe("unset");
    await act(async () => { reject(new Error("disk full")); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("保存扫描设置失败");
    expect(deny().disabled).toBe(false);
    expect(stateApi.state.bootstrap?.onboarding.currentStep).toBe("scan_permission_required");
    await act(async () => { deny().click(); });
    await act(async () => { resolve({ ...mockBootstrap.onboarding, scanPermission: "none", currentStep: "product_tour_required", firstEncounterReportStatus: "skipped" }); });
    expect(stateApi.state.bootstrap?.onboarding.scanPermission).toBe("none");
    expect(stateApi.state.bootstrap?.onboarding.currentStep).toBe("product_tour_required");
    expect(updateScanPreferences).not.toHaveBeenCalled();
  } finally { act(() => root.unmount()); container.remove(); warning.mockRestore(); }
});
