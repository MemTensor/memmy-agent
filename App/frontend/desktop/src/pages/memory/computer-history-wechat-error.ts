import type { useTranslation } from "../../i18n/use-translation.js";
import type { MessageKey } from "../../i18n/messages.js";

const errorMessages: Record<string, MessageKey> = {
  key_capture_failed: "computerHistory.wechat.errorCaptureFailed",
  key_capture_crashed: "computerHistory.wechat.errorCaptureCrashed",
  connection_process_crashed: "computerHistory.wechat.errorCaptureCrashed",
  connection_process_failed: "computerHistory.wechat.errorProcessFailed",
  wechat_login_required: "computerHistory.wechat.errorLoginRequired",
  temporary_wechat_launch_failed: "computerHistory.wechat.errorTemporaryLaunch",
  python_unavailable: "computerHistory.wechat.errorPythonUnavailable",
  wechat_native_helpers_unavailable: "computerHistory.wechat.errorPythonUnavailable",
  key_capture_no_keys: "computerHistory.wechat.errorNoKeys",
  key_capture_incomplete: "computerHistory.wechat.errorCaptureIncomplete",
  wechat_message_database_invalid: "computerHistory.wechat.errorCaptureIncomplete",
  wechat_message_database_limit: "computerHistory.wechat.errorCaptureIncomplete",
  key_capture_output_missing: "computerHistory.wechat.errorCaptureFailed",
  wechat_data_access_required: "computerHistory.wechat.errorDataAccess",
  wechat_data_access_interrupted: "computerHistory.wechat.errorDataAccessInterrupted",
  wechat_data_access_probe_failed: "computerHistory.wechat.guidePreparationFailedBody",
  wechat_permission_helper_unavailable: "computerHistory.wechat.guidePreparationFailedBody",
  current_account_ambiguous: "computerHistory.wechat.errorAccountAmbiguous",
  wechat_private_storage_unsafe: "computerHistory.wechat.guidePreparationFailedBody",
  wechat_private_storage_unsafe_path: "computerHistory.wechat.guidePreparationFailedBody",
  wechat_private_storage_clone_failed: "computerHistory.wechat.guidePreparationFailedBody",
  wechat_private_storage_source_changed: "computerHistory.wechat.errorDataUpdating",
  wechat_private_storage_source_refused: "computerHistory.wechat.guidePreparationFailedBody",
  wechat_private_storage_cleanup_failed: "computerHistory.wechat.guidePreparationFailedBody",
  wechat_private_storage_probe_failed: "computerHistory.wechat.guidePreparationFailedBody",
  weixin_not_running: "computerHistory.wechat.errorWindowsNotRunning",
  process_unreadable: "computerHistory.wechat.errorWindowsProcessUnreadable",
  no_encrypted_databases: "computerHistory.wechat.errorLoginRequired",
  weixin_keys_not_found: "computerHistory.wechat.errorWindowsKeysNotFound",
  wechat_keys_outdated: "computerHistory.wechat.errorKeysOutdated",
  wechat_reader_unavailable: "computerHistory.wechat.errorReaderUnavailable",
};

export function weChatConnectionError(
  error: string | null | undefined,
  t: ReturnType<typeof useTranslation>["t"],
  fallback: MessageKey = "computerHistory.wechat.guideFailedBody",
): string {
  const category = error?.trim() ?? "";
  const message = errorMessages[category];
  if (Object.values(errorMessages).some((key) => t(key) === category)) return category;
  return t(message ?? fallback);
}
