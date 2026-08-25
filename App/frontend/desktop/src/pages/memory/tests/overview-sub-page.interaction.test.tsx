// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../i18n/i18n-provider.js";
import { OverviewSubPageView } from "../overview-sub-page.js";
import { panelOverviewFixture } from "./fixtures.js";

describe("OverviewSubPage interaction", () => {
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
  });

  it.each(["memories", "policies", "world-model", "skills", "user-memories"] as const)(
    "点击数量卡片后跳转到 %s 页面",
    (targetPage) => {
      const onNavigate = vi.fn();
      act(() => {
        root.render(
          <I18nProvider language="zh-CN">
            <OverviewSubPageView
              state={{ status: "ready", data: panelOverviewFixture }}
              onNavigate={onNavigate}
            />
          </I18nProvider>
        );
      });

      act(() => container.querySelector<HTMLButtonElement>(`[data-overview-target="${targetPage}"]`)?.click());

      expect(onNavigate).toHaveBeenCalledWith(targetPage);
    }
  );
});
