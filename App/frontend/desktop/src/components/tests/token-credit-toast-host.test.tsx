// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { NotificationCenterProvider } from "../notification-center.js";
import { TokenCreditToastHost } from "../token-credit-toast-host.js";

describe("TokenCreditToastHost", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("renders nothing and shows no lottery toast (campaign ended)", async () => {
    await act(async () => {
      root.render(
        <I18nProvider language="zh-CN">
          <NotificationCenterProvider>
            <TokenCreditToastHost />
          </NotificationCenterProvider>
        </I18nProvider>
      );
    });

    expect(document.body.textContent).not.toContain("弹幕抽奖");
  });
});
