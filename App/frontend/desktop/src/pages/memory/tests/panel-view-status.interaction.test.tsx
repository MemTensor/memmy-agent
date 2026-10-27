// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../../api/http.js";
import { PanelVisibilityContext } from "../panel-visibility.js";
import { PanelViewGate, usePanelViewStatus } from "../panel-view-status.js";
import { createMemoryRuntimeClientStub } from "./fixtures.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";

afterEach(() => vi.useRealTimers());
describe("retained page authorization", () => {
  it("hides a returning cached page until checked and never shows it after denial", async () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    const root = createRoot(container);
    let rejectCheck!: (error: Error) => void;
    const checkPanelView = vi.fn().mockResolvedValueOnce({ updated: false })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCheck = reject; }));
    const client = createMemoryRuntimeClientStub({ checkPanelView });
    function Page() {
      const [content, setContent] = useState("");
      const status = usePanelViewStatus(client, "L1", () => setContent(""), async () => setContent("revalidated content"));
      useEffect(() => setContent("private cached content"), []);
      return <PanelViewGate status={status}><article>{content}</article></PanelViewGate>;
    }
    const render = async (visible: boolean) => act(async () => root.render(
      <I18nProvider language="en"><PanelVisibilityContext.Provider value={visible}><Page /></PanelVisibilityContext.Provider></I18nProvider>
    ));
    try {
      await render(true);
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(container.querySelector("article")?.textContent).toBe("private cached content");
      expect(container.querySelector("article")?.closest("[hidden]")).toBeNull();
      await render(false);
      await render(true);
      expect(container.querySelector("article")?.closest("[hidden]")).not.toBeNull();
      await act(async () => vi.advanceTimersByTimeAsync(0));
      await act(async () => rejectCheck(new ApiRequestError("access revoked", 403)));
      expect(container.textContent).not.toContain("private cached content");
      expect(container.textContent).toContain("access revoked");
      expect(container.querySelector("button")).not.toBeNull();
      checkPanelView.mockResolvedValueOnce({ updated: false });
      await act(async () => container.querySelector("button")!.click());
      expect(container.textContent).toContain("revalidated content");
      expect(container.textContent).not.toContain("private cached content");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
