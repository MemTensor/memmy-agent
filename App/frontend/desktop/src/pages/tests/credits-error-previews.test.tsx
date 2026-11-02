// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../../app/providers.js";
import { creditErrorScenario } from "../../app/credits-preview-mode.js";
import { creditErrorPreviewBootstrap } from "../../app/credits-error-preview-bootstrap.js";
import { readCreditDemo } from "../../app/credits-preview-quota.js";
import { CreditsLimitsPage, CreditsMemoryPausedPage, CreditsKnowledgeLimitPage, knowledgeLimitPreviewRequest } from "../credits-error-previews.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  window.sessionStorage.clear();
  vi.stubEnv("MEMMY_APP_EDITION", "cn");
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.unstubAllEnvs(); window.history.replaceState(null, "", "/");
});
async function show(kind: string, page: ReactNode) {
  window.history.replaceState(null, "", `/?credits-preview=1&credits-error=${kind}`);
  await act(async () => { root.render(<AppProviders>{page}</AppProviders>); });
}

describe("credit error examples", () => {
  it("boots the local examples with valid data and no live account or telemetry", () => {
    const bootstrap = creditErrorPreviewBootstrap();
    expect(bootstrap.onboarding.completed).toBe(true);
    expect(bootstrap.privacy.telemetryOptIn).toBe(false);
    expect(bootstrap.health.memory).toBe("mock");
  });
  it("keeps the Agent's visible reply and editable draft after pausing", async () => {
    const original = readCreditDemo();
    await show("agent", <CreditsLimitsPage/>);
    expect(host.textContent).toContain("积分不足，当前任务已暂停。可申请升级，权益开通后再继续任务");
    expect(host.querySelector('[aria-label="Agent 任务积分不足"] button')).toBeNull();
    expect(host.querySelector(".agent-model-error-notice")).toBeNull();
    expect(host.textContent).toContain("已展示的回复、工具结果和用户输入保留");
    expect(host.textContent).not.toContain("已读取评审记录");
    expect(host.textContent).not.toContain("评审整理稿.md");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("");
    expect(host.querySelector<HTMLTextAreaElement>("textarea")?.placeholder).toBe("分配一个任务或提问任何问题...");
    expect(host.querySelector<HTMLButtonElement>('[aria-label="发送"]')?.disabled).toBe(true);
    expect(host.querySelector('[aria-label="Agent 任务积分不足"] button')).toBeNull();
    expect(host.textContent).not.toContain("切换自有 API Key 模型");
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="会话模型"]')?.click();
    });
    expect(host.textContent).toContain("Memmy Agent 模型");
    expect(host.textContent).toContain("自有 API Key 模型");
    expect(host.textContent).not.toContain("平台模型 · 积分不足");
    window.history.replaceState(null, "", "/");
    expect(readCreditDemo()).toEqual(original);
  });
  it("keeps completed memories and shows automatic recovery without a manual continue action", async () => {
    await show("memory", <CreditsMemoryPausedPage/>);
    expect(host.textContent).toContain("记忆加工已暂停");
    expect(host.textContent).toContain("将自动继续");
    expect(host.textContent).toContain("记忆服务改用已配置的自有 API Key 模型后");
    expect(host.textContent).not.toContain("购买积分");
    expect(host.textContent).not.toContain("升级进阶版");
    expect(host.querySelectorAll(".memory-card")).toHaveLength(3);
    expect(host.textContent).not.toContain("待处理 2 条");
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "继续任务")).toBe(false);
  });
  it("keeps the exhausted turn and starts a new normal turn after credits return", async () => {
    await show("agent&credits-recovered=1", <CreditsLimitsPage/>);
    const rendered = host.textContent ?? "";
    const partial = rendered.indexOf("恢复方式还在整理中。");
    const warning = rendered.indexOf("积分不足，当前任务已暂停。可申请升级，权益开通后再继续任务");
    const newUser = rendered.indexOf("积分已经补足。请继续整理恢复方式。");
    const newReply = rendered.indexOf("恢复方式补充如下");
    expect(partial).toBeGreaterThanOrEqual(0);
    expect(warning).toBeGreaterThan(partial);
    expect(newUser).toBeGreaterThan(warning);
    expect(newReply).toBeGreaterThan(newUser);
    expect(readCreditDemo().buckets[0]?.remaining).toBeGreaterThan(0);
    expect([...host.querySelectorAll("button")].some(button => button.textContent === "继续任务")).toBe(false);
  });
  it("blocks only creating another knowledge base and never sends mock mutations", async () => {
    await show("knowledge", <CreditsKnowledgeLimitPage/>);
    expect(host.textContent).toContain("10/10");
    expect(host.querySelector('[aria-labelledby="mk-create-title"]')).toBeNull();
    const createButton = host.querySelector<HTMLButtonElement>(".mk-new-btn");
    expect(createButton?.disabled).toBe(true);
    expect(createButton?.getAttribute("aria-label")).toContain("10/10");
    expect(host.querySelector('[aria-labelledby="mk-create-title"]')).toBeNull();
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === "直接上传")?.disabled).toBe(false);
    expect(host.textContent).toContain("积分产品方案.pdf");
    expect(host.textContent).not.toContain("购买积分");
    expect(host.textContent).not.toContain("升级进阶版");
    await expect(knowledgeLimitPreviewRequest("/bases", "POST")).rejects.toThrow();
  });
  it("shows storage rejection next to the file list without blocking new knowledge bases", async () => {
    await show("knowledge&knowledge-limit=storage", <CreditsKnowledgeLimitPage/>);
    const failedFile = host.querySelector('[aria-label="未上传文件"] .mk-frow');
    expect(failedFile?.textContent).toContain("上传失败，空间不足");
    expect(failedFile?.textContent).toContain("用户访谈资料.pdf");
    expect(failedFile?.textContent).toContain("98 MB");
    expect(failedFile?.textContent).toContain("0 MB");
    expect(failedFile?.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("已用 4.20 GB");
    expect(host.textContent).toContain("已用 3.10 GB");
    expect(host.textContent).toContain("已用 2.76 GB");
    expect(host.querySelector(".mk-storage-quota--exceeded")?.textContent).toContain("10.06 GB/10 GB");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>(".mk-new-btn")?.disabled).toBe(false);
  });
  it("shows the sharing limit inside sharing management and leaves member removal available", async () => {
    await show("knowledge&knowledge-limit=sharing", <CreditsKnowledgeLimitPage/>);
    const dialog = host.querySelector('[aria-labelledby="mk-share-title"]');
    expect(dialog?.textContent).toContain("共享人数已达上限");
    expect(dialog?.querySelectorAll(".mk-member-revoke")).toHaveLength(4);
    expect(dialog?.querySelector(".mk-share-form")).toBeNull();
    expect(dialog?.querySelector(".agent-model-error-notice")).toBeNull();
    expect(dialog?.textContent).not.toContain("升级进阶版");
    expect(dialog?.textContent).toContain("lin.yue@example.com");
  });
  it("uses the current plan's limit when the Plus knowledge-base count is exhausted", async () => {
    await show("knowledge&knowledge-limit=count&credits-plan=pro", <CreditsKnowledgeLimitPage/>);
    expect(creditErrorPreviewBootstrap().tokenUsage.planName).toBe("进阶版");
    expect(readCreditDemo().plan).toBe("pro");
    expect(host.textContent).toContain("50/50");
    const createButton = host.querySelector<HTMLButtonElement>(".mk-new-btn");
    expect(createButton?.disabled).toBe(true);
    expect(createButton?.getAttribute("aria-label")).toContain("50/50");
    expect(host.querySelector('[aria-labelledby="mk-create-title"]')).toBeNull();
  });
  it("does not suggest upgrading an exhausted Plus plan", async () => {
    await show("agent&credits-plan=pro", <CreditsLimitsPage/>);
    const notice = host.querySelector('[aria-label="Agent 任务积分不足"]');
    expect(notice?.textContent).toContain("可查看积分来源或切换自有模型后继续");
    expect(notice?.textContent).not.toContain("升级套餐");
  });
  it("keeps error prompts plan-neutral in the international edition", async () => {
    vi.stubEnv("MEMMY_APP_EDITION", "intl");
    await show("agent", <CreditsLimitsPage/>);
    expect(host.textContent).not.toContain("购买积分");
    expect(host.textContent).not.toContain("升级套餐");
    expect(creditErrorScenario("?credits-error=memory")).toBeNull();
  });
});
