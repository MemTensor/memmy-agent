// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { openExternalUrl } from "../../utils/open-url.js";
import { ComputerHistoryWeChatRiskConfirmation } from "../memory/computer-history-wechat-risk-confirmation.js";

vi.mock("../../utils/open-url.js", () => ({ openExternalUrl: vi.fn().mockResolvedValue(undefined) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ComputerHistoryWeChatRiskConfirmation>;

describe("WeChat reading risk confirmation", () => {
  let root: Root;
  let props: Props;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(openExternalUrl).mockClear();
    document.body.replaceChildren();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = { open: true, onCancel: vi.fn(), onConfirm: vi.fn() };
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    document.body.style.overflow = "";
    vi.useRealTimers();
  });

  async function render(overrides: Partial<Props> = {}, language: "zh-CN" | "en-US" = "zh-CN") {
    props = { ...props, ...overrides };
    await act(async () => {
      root.render(<I18nProvider language={language}><ComputerHistoryWeChatRiskConfirmation {...props} /></I18nProvider>);
    });
  }

  function button(label: string) {
    return [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((candidate) => candidate.textContent === label);
  }

  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("shows all five approved paragraphs and the exact public source link", async () => {
    await render();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("开启微信读取前，请了解以下说明");
    const paragraphs = [...document.querySelectorAll('[role="dialog"] p')].map((paragraph) => paragraph.textContent);
    expect(paragraphs).toEqual([
      "Memmy 会通过本机读取方式同步您的微信聊天记录。此功能只用于读取，不会自动发送消息、添加好友或代替您进行微信操作。",
      "生成聊天总结时，相关聊天内容会由您在 Memmy 中配置的大模型处理：使用第三方在线模型时，内容会发送至对应的模型服务商；使用 Memmy 自有模型时，则会由 Memmy 官方服务处理。原始记录保存在本机。",
      "本功能并非微信官方提供的读取功能，虽然我们的干预非常小，但仍可能触发微信的账号安全检查，导致账号功能受限或被封禁。我们无法保证完全没有账号风险。",
      "本功能的读取方式和处理逻辑完全公开。如需了解具体实现，您可以查看我们的 GitHub 开源代码仓库。",
      "请完整阅读并了解上述说明，再决定是否开启。",
    ]);
    expect(document.querySelector<HTMLAnchorElement>('a')?.getAttribute("href")).toBe("https://github.com/MemTensor/memmy-agent");
    expect(document.body.textContent).not.toContain("不再提示");
    expect(button("取消")?.disabled).toBe(false);
  });

  it("blocks early clicks for three full seconds, updates the label, and confirms only once", async () => {
    await render();
    expect(button("我已知晓（3秒）")?.disabled).toBe(true);
    act(() => button("我已知晓（3秒）")!.click());
    expect(props.onConfirm).not.toHaveBeenCalled();
    await advance(1000);
    expect(button("我已知晓（2秒）")?.disabled).toBe(true);
    expect(button("取消")?.disabled).toBe(false);
    await advance(1000);
    expect(button("我已知晓（1秒）")?.disabled).toBe(true);
    await advance(999);
    expect(button("我已知晓（1秒）")?.disabled).toBe(true);
    act(() => button("我已知晓（1秒）")!.click());
    expect(props.onConfirm).not.toHaveBeenCalled();
    await advance(1);
    expect(button("我已知晓")?.disabled).toBe(false);
    expect(props.onConfirm).not.toHaveBeenCalled();
    act(() => {
      button("我已知晓")!.click();
      button("我已知晓")!.click();
    });
    expect(props.onConfirm).toHaveBeenCalledOnce();
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it.each(["cancel", "close", "escape"])("treats %s as cancellation throughout the countdown", async (dismissal) => {
    await render();
    await advance(1000);
    if (dismissal === "cancel") act(() => button("取消")!.click());
    else if (dismissal === "close") act(() => document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')!.click());
    else act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(props.onCancel).toHaveBeenCalledOnce();
    await advance(3000);
    act(() => button("我已知晓")!.click());
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("starts over when closed and reopened after a previously completed countdown", async () => {
    await render();
    await advance(3000);
    expect(button("我已知晓")?.disabled).toBe(false);
    await render({ open: false });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await advance(10000);
    await render({ open: true });
    expect(button("我已知晓（3秒）")?.disabled).toBe(true);
    await advance(2000);
    expect(button("我已知晓（1秒）")?.disabled).toBe(true);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("opens GitHub externally without accepting or canceling consent", async () => {
    await render();
    const link = document.querySelector<HTMLAnchorElement>('a')!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => link.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith("https://github.com/MemTensor/memmy-agent");
    expect(props.onConfirm).not.toHaveBeenCalled();
    expect(props.onCancel).not.toHaveBeenCalled();
    expect(button("我已知晓（3秒）")?.disabled).toBe(true);
  });

  it("provides translated risk and model disclosures in English", async () => {
    await render({}, "en-US");
    expect(document.body.textContent).toContain("Before enabling WeChat reading");
    expect(document.body.textContent).toContain("the content is sent to that provider");
    expect(document.body.textContent).toContain("account restrictions or a ban");
    expect(document.body.textContent).not.toContain("computerHistory.wechat.risk");
    expect(button("I understand (3s)")?.disabled).toBe(true);
    expect(button("Cancel")?.disabled).toBe(false);
    await advance(3000);
    expect(button("I understand")?.disabled).toBe(false);
  });
});
