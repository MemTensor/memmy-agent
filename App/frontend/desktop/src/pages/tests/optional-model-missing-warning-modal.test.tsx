/** Optional model missing warning modal tests. */
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import {
  OptionalModelMissingWarningModal,
  resolveOptionalModelMissingWarning
} from "../optional-model-missing-warning-modal.js";

describe("optional model missing warning", () => {
  it("两个可选模型都未配置时合并为一个提醒", () => {
    expect(resolveOptionalModelMissingWarning({ asrMissing: true, imageGenMissing: true })).toBe("both");
    expect(resolveOptionalModelMissingWarning({ asrMissing: true, imageGenMissing: false })).toBe("asr");
    expect(resolveOptionalModelMissingWarning({ asrMissing: false, imageGenMissing: true })).toBe("imageGen");
    expect(resolveOptionalModelMissingWarning({ asrMissing: false, imageGenMissing: false })).toBeNull();
  });

  it("合并提醒把受影响能力列出来并突出继续保存提示", () => {
    const html = renderToString(
      <I18nProvider language="zh-CN">
        <OptionalModelMissingWarningModal kind="both" onClose={vi.fn()} />
      </I18nProvider>
    );

    expect(html).toContain("ASR 和生图模型未配置");
    expect(html).toContain("可以继续保存当前配置");
    expect(html).toContain("bg-action-sky/10");
    expect(html).toContain("text-action-sky");
    expect(html).not.toContain("<strong");
    expect(html).toContain("语音输入（桌宠和主界面）");
    expect(html).toContain("Agent 生图");
    expect(html).toContain("知道了");
    expect(html).not.toContain("确认影响");
  });
});
