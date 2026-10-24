import { describe, expect, it } from "vitest";
import { messageCatalogs, type MessageKey } from "../../i18n/messages.js";
import { weChatConnectionError } from "../memory/computer-history-wechat-error.js";

describe.each(["zh-CN", "en-US"] as const)("WeChat connection errors in %s", (language) => {
  const t = (key: MessageKey) => messageCatalogs[language][key];
  it.each([
    "key_capture_failed", "key_capture_crashed", "connection_process_crashed", "connection_process_failed",
    "wechat_login_required", "temporary_wechat_launch_failed",
    "python_unavailable", "wechat_native_helpers_unavailable", "key_capture_no_keys",
    "key_capture_output_missing",
    "key_capture_incomplete", "wechat_message_database_invalid", "wechat_message_database_limit",
    "wechat_data_access_required", "wechat_data_access_probe_failed", "wechat_permission_helper_unavailable",
    "wechat_data_access_interrupted",
    "current_account_ambiguous",
    "wechat_private_storage_unsafe", "wechat_private_storage_unsafe_path", "wechat_private_storage_clone_failed",
    "wechat_private_storage_source_changed", "wechat_private_storage_source_refused", "wechat_private_storage_cleanup_failed",
    "wechat_private_storage_probe_failed",
    "weixin_not_running", "process_unreadable", "no_encrypted_databases", "weixin_keys_not_found",
    "wechat_keys_outdated", "wechat_reader_unavailable",
  ])("explains %s without exposing the raw category", (category) => {
    const message = weChatConnectionError(category, t);
    expect(message).not.toContain(category);
    expect(message).not.toBe(t("computerHistory.wechat.guideFailedBody"));
    expect(weChatConnectionError(message, t)).toBe(message);
  });
  it("keeps unknown process errors out of the dialog", () => {
    expect(weChatConnectionError("unknown_code:/private/path", t)).toBe(t("computerHistory.wechat.guideFailedBody"));
    expect(weChatConnectionError("unknown_code:/private/path", t, "computerHistory.wechat.guidePreparationFailedBody"))
      .toBe(t("computerHistory.wechat.guidePreparationFailedBody"));
  });
  it("explains changing WeChat data in both preparation and connection errors", () => {
    expect(weChatConnectionError("wechat_private_storage_source_changed", t))
      .toBe(t("computerHistory.wechat.errorDataUpdating"));
    expect(weChatConnectionError("wechat_private_storage_source_changed", t, "computerHistory.wechat.guidePreparationFailedBody"))
      .toBe(t("computerHistory.wechat.errorDataUpdating"));
  });
  it("does not misdiagnose preparation and unknown failures as a missing login", () => {
    for (const category of ["wechat_private_storage_unsafe_path", "connection_failed", "unknown_failure"]) {
      expect(weChatConnectionError(category, t)).not.toMatch(/登录|signed in|Sign in/u);
    }
  });
  it("keeps data-access guidance on Memmy without introducing a separate permission app", () => {
    const message = weChatConnectionError("wechat_data_access_required", t);
    expect(message).toContain("Memmy");
    expect(message).not.toMatch(/Reader|Finder|助手|assistant/u);
    expect(weChatConnectionError("wechat_data_access_probe_failed", t)).toBe(t("computerHistory.wechat.guidePreparationFailedBody"));
    expect(weChatConnectionError("wechat_permission_helper_unavailable", t)).toBe(t("computerHistory.wechat.guidePreparationFailedBody"));
  });
  it("explains an unapproved data access as a macOS delay without inventing an authorization dialog", () => {
    const message = weChatConnectionError("wechat_data_access_interrupted", t);
    expect(message).toMatch(language === "zh-CN" ? /macOS.*重新连接/u : /macOS.*connecting again/u);
    expect(message).not.toMatch(/授权窗口|authorization dialog|完全磁盘|Full Disk Access|登录|Sign in|signed in/u);
    expect(weChatConnectionError("wechat_data_access_interrupted", t, "computerHistory.wechat.guidePreparationFailedBody"))
      .toBe(message);
  });
});
