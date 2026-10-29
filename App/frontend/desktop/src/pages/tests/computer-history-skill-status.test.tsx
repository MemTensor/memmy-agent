// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { ComputerHistorySources } from "../memory/computer-history-sources.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
beforeEach(() => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.replaceChildren(); });

it.each([
  ["source meaningful memory requires retry", "整理失败", "重试"],
  ["source summary model is not configured", "尚未配置", "模型设置"],
  ["evolution model is not configured", "尚未配置", "模型设置"],
  ["Skill evolution is disabled", "演化已关闭", "暂不生成"],
  ["source meaningful memory is still processing or requires retry", "正在等待", "重试该记录"],
])("explains the recovery for %s without promising an ineffective automatic retry", async (reason, expected, action) => {
  await act(async () => root.render(<I18nProvider language="zh-CN">
    <ComputerHistorySources client={null} onChoose={() => {}} syncStatus={{ lastSyncedAt: null,
      error: null, skillError: `local Memory Skill suggestion failed (409): ${reason}` }} />
  </I18nProvider>));
  const status = document.querySelector('[role="status"]')?.textContent;
  expect(status).toContain(expected);
  expect(status).toContain(action);
  expect(status).not.toContain("409");
  expect(status).not.toContain("自动重试");
});

it("renders recovery guidance in English", async () => {
  await act(async () => root.render(<I18nProvider language="en-US">
    <ComputerHistorySources client={null} onChoose={() => {}} syncStatus={{ lastSyncedAt: null,
      error: null, skillError: "local Memory Skill suggestion failed (409): source meaningful memory requires retry" }} />
  </I18nProvider>));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Retry the failed records in Memory");
});

it("keeps every distinct recovery action when several Skill groups fail", async () => {
  const prefix = "local Memory Skill suggestion failed (409): ";
  await act(async () => root.render(<I18nProvider language="zh-CN">
    <ComputerHistorySources client={null} onChoose={() => {}} syncStatus={{ lastSyncedAt: null,
      error: null, skillError: ["local Memory Skill suggestion failed (500)",
        `${prefix}source meaningful memory requires retry`, `${prefix}source summary model is not configured`,
        `${prefix}evolution model is not configured`].join("; ") }} />
  </I18nProvider>));
  const statuses = [...document.querySelectorAll('[role="status"]')].map((node) => node.textContent);
  expect(statuses).toHaveLength(3);
  expect(statuses.some((text) => text?.includes("500"))).toBe(true);
  expect(statuses.some((text) => text?.includes("整理失败") && text.includes("重试"))).toBe(true);
  expect(statuses.some((text) => text?.includes("尚未配置") && text.includes("模型设置"))).toBe(true);
});
