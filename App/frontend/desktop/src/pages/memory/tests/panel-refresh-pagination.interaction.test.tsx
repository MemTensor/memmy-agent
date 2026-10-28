// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createHttpMemoryRuntimeClient } from "../../../api/memory-runtime-client.js";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { AppStateProvider } from "../../../state/app-state.js";
import { PoliciesSubPage } from "../policies-sub-page.js";
import { WorldModelSubPage } from "../world-model-sub-page.js";
import { SkillsSubPage } from "../skills-sub-page.js";
import { UserMemoriesSubPage } from "../user-memories-sub-page.js";
import { clearMemoryPanelCache } from "../memory-panel-cache.js";
import { memoryListItemFixture } from "./fixtures.js";

describe.each(Object.entries({ PoliciesSubPage, WorldModelSubPage, SkillsSubPage, UserMemoriesSubPage }))(
  "%s refresh pagination", (_name, Page) => {
    it.each([false, true])("continues paging after refresh (first refresh fails: %s)", async (failFirst) => {
      clearMemoryPanelCache();
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.useFakeTimers();
      let serial = 0;
      let fail = false;
      let total = 60;
      const requests: Array<{ op: string; page?: number }> = [];
      const page = (n: number, viewId: string) => ({ viewId, instanceId: "instance", safety: "safe",
        createdAt: "2026-10-28T00:00:00Z", serverTime: "2026-10-28T00:00:00Z", page: n, pageSize: 20,
        total, totalPages: Math.ceil(total / 20), hasNext: n < Math.ceil(total / 20), hasPrev: n > 1, items: [memoryListItemFixture] });
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { op: string; page?: number; viewId?: string };
        requests.push(body);
        if (body.op === "create" && fail) { fail = false; return new Response("{}", { status: 503 }); }
        const result = body.op === "create" ? page(1, `view-${++serial}`)
          : body.op === "release" ? { ok: true }
          : body.op === "check" ? { viewId: body.viewId, instanceId: "instance", safety: "safe", updated: false, serverTime: "2026-10-28T00:00:00Z" }
          : page(body.page ?? 1, body.viewId!);
        return new Response(JSON.stringify(result));
      }));
      const client = createHttpMemoryRuntimeClient({ baseUrl: "http://synthetic.invalid", localToken: "synthetic" });
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const current = () => Number(container.querySelector<HTMLInputElement>(".memory-pagination__input")!.value);
      const next = () => container.querySelectorAll<HTMLButtonElement>(".memory-pagination__button")[1]!.click();
      const refresh = () => container.querySelector<HTMLButtonElement>(".memory-refresh-button")!.click();
      try {
        await act(async () => root.render(<AppStateProvider><I18nProvider language="en-US"><Page client={client} onOpenMemoryReference={() => {}} /></I18nProvider></AppStateProvider>));
        await act(async () => vi.advanceTimersByTimeAsync(0));
        await act(async () => next());
        expect(current()).toBe(2);
        if (failFirst) {
          fail = true;
          await act(async () => refresh());
          expect(current()).toBe(2);
        }
        await act(async () => refresh());
        expect(current()).toBe(1);
        await act(async () => next());
        expect(current()).toBe(2);
        await act(async () => next());
        expect(current()).toBe(3);
        expect(requests.filter(request => request.op === "page").at(-1)?.page).toBe(3);
        total = 21;
        await act(async () => refresh());
        expect(current()).toBe(1);
        await act(async () => next());
        expect(current()).toBe(2);
        expect(container.querySelectorAll<HTMLButtonElement>(".memory-pagination__button")[1]!.disabled).toBe(true);
      } finally {
        await act(async () => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });
  }
);
