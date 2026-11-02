// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasCreditsExhaustedPreview, requestCreditsExhaustedPrompt, CREDITS_EXHAUSTED_PROMPT_EVENT } from "../../app/credits-exhausted-prompt.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { CreditsExhaustedModal } from "../credits-exhausted-modal.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CreditsExhaustedModal", () => {
  let host: HTMLDivElement;
  let root: Root;
  const nextReset = new Date(2026, 11, 2, 17, 30);

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  it("shows the shared free-plan copy, reset time, and published application link", async () => {
    const onUseOwnModel = vi.fn();
    const onDismiss = vi.fn();
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><CreditsExhaustedModal
        plan="free"
        nextReset={nextReset}
        upgradeUrl="https://example.com/form"
        onUseOwnModel={onUseOwnModel}
        onViewDetails={vi.fn()}
        onDismiss={onDismiss}
      /></I18nProvider>);
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Agent 任务和记忆加工等平台模型功能暂不可用");
    expect(dialog?.textContent).toMatch(/免费版.*下次套餐积分重置.*2026.*12.*02.*17:30/);
    expect(dialog?.textContent).not.toContain("0.00");
    expect(dialog?.querySelector<HTMLAnchorElement>("a")?.href).toBe("https://example.com/form");
    expect(dialog?.querySelectorAll("button")).toHaveLength(2);
    await act(async () => {
      [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "使用自有模型")?.click();
    });
    expect(onUseOwnModel).toHaveBeenCalledTimes(1);
    await act(async () => {
      dialog?.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not offer another upgrade to an existing Plus user", async () => {
    const onUseOwnModel = vi.fn();
    const onViewDetails = vi.fn();
    await act(async () => {
      root.render(<I18nProvider language="zh-CN"><CreditsExhaustedModal
        plan="pro"
        nextReset={nextReset}
        upgradeUrl="https://example.com/form"
        onUseOwnModel={onUseOwnModel}
        onViewDetails={onViewDetails}
        onDismiss={vi.fn()}
      /></I18nProvider>);
    });
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("进阶版");
    expect(dialog?.querySelector("a")).toBeNull();
    await act(async () => {
      [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "使用自有模型")?.click();
      [...dialog!.querySelectorAll("button")].find((button) => button.textContent === "查看积分明细")?.click();
    });
    expect(onUseOwnModel).toHaveBeenCalledTimes(1);
    expect(onViewDetails).toHaveBeenCalledTimes(1);
  });
});

describe("credits exhaustion trigger", () => {
  it("requires the explicit preview flag for URL-triggered examples", () => {
    expect(hasCreditsExhaustedPreview("?credits-preview=1&credits-exhausted=1")).toBe(true);
    expect(hasCreditsExhaustedPreview("?credits-exhausted=1")).toBe(false);
  });

  it("emits a shared signal that any page can request", () => {
    const listener = vi.fn();
    window.addEventListener(CREDITS_EXHAUSTED_PROMPT_EVENT, listener);
    requestCreditsExhaustedPrompt();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(CREDITS_EXHAUSTED_PROMPT_EVENT, listener);
  });
});
