import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../../components/button.js";
import { Modal } from "../../components/modal.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { isWindowsDesktopPlatform } from "../../utils/window-fullscreen.js";
import { clearWeChatPermissionReturn, rememberWeChatPermissionReturn } from "./computer-history-wechat-permission-state.js";
import { weChatConnectionError } from "./computer-history-wechat-error.js";
import type { ComputerHistoryWeChatReaderPreparation } from "../../api/computer-history-contract.js";

type WeChatGuideConnection = "disabled" | "unavailable" | "needs_setup" | "connecting" | "connected" | "error";
type DiskAccess = "idle" | "checking" | "needed" | "granted" | "restart" | "error";

const MACOS_FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export function ComputerHistoryWeChatConfirmation(props: {
  open: boolean;
  busy: boolean;
  connection: WeChatGuideConnection | null;
  phase: string | null;
  error: string | null;
  onCancel(): void;
  onPrepareReader(): Promise<ComputerHistoryWeChatReaderPreparation>;
  onLoggedIn(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const windows = isWindowsDesktopPlatform();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [started, setStarted] = useState(false);
  const [phoneAck, setPhoneAck] = useState(false);
  const [diskAccess, setDiskAccess] = useState<DiskAccess>("idle");
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [permissionError, setPermissionError] = useState(false);
  const [reader, setReader] = useState<ComputerHistoryWeChatReaderPreparation | null>(null);
  const [readerChecking, setReaderChecking] = useState(false);
  const [readerError, setReaderError] = useState<string | null>(null);
  const dialogVersion = useRef(0);
  const readerCheckInFlight = useRef(false);
  const startedConnection = useRef(false);
  const openRef = useRef(props.open);
  openRef.current = props.open;
  const onLoggedInRef = useRef(props.onLoggedIn);
  onLoggedInRef.current = props.onLoggedIn;
  const onPrepareReaderRef = useRef(props.onPrepareReader);
  onPrepareReaderRef.current = props.onPrepareReader;
  const checkReaderRef = useRef(async (_version: number) => false);
  checkReaderRef.current = async (version) => {
    const isActive = () => openRef.current && version === dialogVersion.current && !startedConnection.current;
    if (!isActive() || readerCheckInFlight.current) return false;
    readerCheckInFlight.current = true;
    setReaderChecking(true);
    setReaderError(null);
    try {
      const result = await onPrepareReaderRef.current();
      if (!isActive()) return false;
      setReader(result);
      setReaderError(result.ready ? null : result.error);
      if (!result.ready && result.error === "wechat_data_access_required") setDiskAccess("needed");
      return result.ready;
    } catch (cause) {
      if (isActive()) {
        setReader(null);
        setReaderError(cause instanceof Error ? cause.message : null);
      }
      return false;
    } finally {
      if (version === dialogVersion.current) {
        readerCheckInFlight.current = false;
        if (isActive()) setReaderChecking(false);
      }
    }
  };
  const startConnectionRef = useRef(() => {});
  startConnectionRef.current = () => {
    if (startedConnection.current) return;
    startedConnection.current = true;
    setDiskAccess("idle");
    setStarted(true);
    onLoggedInRef.current();
  };

  useLayoutEffect(() => {
    ++dialogVersion.current;
    readerCheckInFlight.current = false;
    return () => { ++dialogVersion.current; };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) {
      setStarted(false);
      setPhoneAck(false);
      setDiskAccess("idle");
      setSettingsOpened(false);
      setRestarting(false);
      setPermissionError(false);
      setReader(null);
      setReaderChecking(false);
      setReaderError(null);
      startedConnection.current = false;
      return;
    }
    let cancelled = false;
    const version = dialogVersion.current;
    const check = windows ? undefined : window.memmy?.getFullDiskAccessStatus;
    if (windows) {
      setDiskAccess("granted");
      return;
    }
    setDiskAccess("checking");
    void (check ? check() : Promise.resolve(true)).then(async (granted) => {
      if (cancelled || version !== dialogVersion.current || !openRef.current) return;
      setDiskAccess(granted ? "granted" : "needed");
      if (granted) await checkReaderRef.current(version);
    }).catch(() => {
      if (!cancelled && version === dialogVersion.current && openRef.current) setDiskAccess("error");
    });
    return () => { cancelled = true; };
  }, [props.open, windows]);

  useEffect(() => {
    if (!props.open || diskAccess !== "needed" || !settingsOpened) return;
    let cancelled = false;
    const recheck = () => {
      if (document.visibilityState === "hidden") return;
      const check = window.memmy?.getFullDiskAccessStatus;
      if (!check) return;
      void check().then((granted) => {
        if (cancelled || !granted || !openRef.current) return;
        // macOS may require a process restart. Returning from Settings never
        // grants WeChat consent or starts a connection on the user's behalf.
        setDiskAccess("restart");
      }).catch(() => undefined);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [diskAccess, props.open, settingsOpened]);

  useLayoutEffect(() => {
    if (!props.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [props.open]);

  if (!props.open) return null;

  function onLoginConfirmed() {
    if (startedConnection.current || diskAccess === "checking" || readerChecking) return;
    if (windows) {
      startConnectionRef.current();
      return;
    }
    const check = windows ? undefined : window.memmy?.getFullDiskAccessStatus;
    const version = dialogVersion.current;
    setDiskAccess("checking");
    void (check ? check() : Promise.resolve(true)).then(async (granted) => {
      if (version !== dialogVersion.current || !openRef.current || startedConnection.current) return;
      if (granted) {
        setDiskAccess("granted");
        const ready = reader?.ready || await checkReaderRef.current(version);
        if (ready && version === dialogVersion.current && openRef.current && !startedConnection.current) {
          startConnectionRef.current();
        }
        return;
      }
      setDiskAccess("needed");
    }).catch(() => {
      if (version !== dialogVersion.current || !openRef.current || startedConnection.current) return;
      setDiskAccess("error");
    });
  }

  async function openDiskSettings() {
    const version = dialogVersion.current;
    const isActive = () => openRef.current && version === dialogVersion.current;
    setPermissionError(false);
    try {
      await rememberWeChatPermissionReturn(isActive);
      if (!isActive()) return;
      const open = window.memmy?.openExternal;
      if (!open) throw new Error("System Settings opener unavailable");
      await open(MACOS_FULL_DISK_ACCESS_URL);
      if (isActive()) setSettingsOpened(true);
    } catch {
      if (isActive()) setPermissionError(true);
    }
  }

  async function restartForDiskAccess() {
    if (restarting) return;
    setRestarting(true);
    setPermissionError(false);
    const version = dialogVersion.current;
    const isActive = () => openRef.current && version === dialogVersion.current;
    try {
      await rememberWeChatPermissionReturn(isActive);
      if (!isActive()) return;
      await window.memmy?.restartForComputerHistoryPermissions?.();
    } catch {
      if (isActive()) setPermissionError(true);
    } finally {
      if (isActive()) setRestarting(false);
    }
  }

  const cancel = () => { ++dialogVersion.current; clearWeChatPermissionReturn(); props.onCancel(); };

  const waitingForPhone = props.phase === "awaiting_wechat_login" || props.phase === "waiting_for_login";
  const step = !started && diskAccess !== "granted"
    ? "disk"
    : !started && !windows && (readerChecking || !reader?.ready)
      ? "preparation"
      : !started
        ? "login"
        : props.connection === "connected"
          ? "done"
          : props.connection === "error" || (props.connection === "disabled" && !props.busy)
            ? "failed"
            : waitingForPhone && !phoneAck && !windows
              ? "phone"
              : "memmy";

  const title = step === "disk" ? t("computerHistory.wechat.guideDiskTitle")
    : step === "preparation" ? t(readerChecking ? "computerHistory.wechat.guidePreparingTitle" : "computerHistory.wechat.guidePreparationFailedTitle")
      : step === "login" ? t(windows ? "computerHistory.wechat.guideLoginTitleWindows" : "computerHistory.wechat.guideLoginTitle")
      : step === "phone" ? t("computerHistory.wechat.guidePhoneTitle")
        : step === "done" ? t("computerHistory.wechat.guideDoneTitle")
          : step === "failed" ? t("computerHistory.wechat.guideFailedTitle")
            : t("computerHistory.wechat.guideMemmyTitle");
  const body = step === "disk" ? t(diskAccess === "idle" || diskAccess === "checking"
    ? "computerHistory.wechat.guideDiskChecking" : diskAccess === "error"
      ? "computerHistory.wechat.guideDiskCheckFailed" : "computerHistory.wechat.guideDiskBody")
    : step === "preparation" ? readerChecking
      ? t("computerHistory.wechat.guidePreparingBody")
      : weChatConnectionError(readerError, t, "computerHistory.wechat.guidePreparationFailedBody")
      : step === "login" ? t(windows ? "computerHistory.wechat.guideLoginBodyWindows" : "computerHistory.wechat.guideLoginBody")
      : step === "phone" ? t("computerHistory.wechat.guidePhoneBody")
        : step === "failed" ? weChatConnectionError(props.error, t)
          : step === "done" ? ""
            : t(windows ? "computerHistory.wechat.guideMemmyBodyWindows" : phoneAck
              ? "computerHistory.wechat.guideMemmyAfterPhone"
              : "computerHistory.wechat.guideMemmyBody");

  return createPortal(
    <div className="ch-recording-confirmation">
      <Modal
        open
        title={title}
        className="confirm-dialog confirm-dialog--titled ch-wechat-dialog"
        bodyClassName="confirm-dialog__body"
        footerClassName="confirm-dialog__footer"
        style={{ width: 460, maxWidth: "calc(100vw - 32px)" }}
        closeLabel={t("common.close")}
        closeContent={<X size={16} aria-hidden="true" />}
        initialFocusRef={cancelRef}
        closeDisabled={restarting}
        onClose={step === "done" ? props.onClose : cancel}
        footer={(
          <>
            {step !== "done" ? (
              <Button ref={cancelRef} type="button" variant="ghost" size="sm" disabled={restarting} onClick={cancel}>
                {t("dialog.cancel")}
              </Button>
            ) : null}
            {step === "login" ? (
              <Button type="button" variant="primary" size="sm" disabled={diskAccess === "checking"} onClick={onLoginConfirmed}>
                {t("computerHistory.wechat.guideLoginButton")}
              </Button>
            ) : null}
            {step === "disk" && diskAccess !== "idle" && diskAccess !== "checking" ? (
              <Button type="button" variant="primary" size="sm" disabled={restarting} onClick={() => void openDiskSettings()}>
                {t("computerHistory.wechat.guideDiskButton")}
              </Button>
            ) : null}
            {step === "disk" && settingsOpened && window.memmy?.restartForComputerHistoryPermissions ? (
              <Button type="button" variant="primary" size="sm" disabled={restarting} onClick={() => void restartForDiskAccess()}>
                {t("computerHistory.wechat.guideDiskRestart")}
              </Button>
            ) : null}
            {step === "preparation" && !readerChecking ? (
              <Button type="button" variant="primary" size="sm" onClick={() => void checkReaderRef.current(dialogVersion.current)}>
                {t("computerHistory.wechat.guidePreparationRetry")}
              </Button>
            ) : null}
            {step === "phone" ? (
              <Button type="button" variant="primary" size="sm" onClick={() => setPhoneAck(true)}>
                {t("computerHistory.wechat.guidePhoneButton")}
              </Button>
            ) : null}
            {step === "done" || step === "failed" ? (
              <Button ref={step === "done" ? cancelRef : undefined} type="button" variant="primary" size="sm" onClick={props.onClose}>
                {t("computerHistory.wechat.guideDoneButton")}
              </Button>
            ) : null}
          </>
        )}
      >
        <div className="ch-wechat-guide">
          {step === "disk" && readerError === "wechat_data_access_required" ? (
            <p className="ch-wechat-consent__body">{t("computerHistory.wechat.guideDiskCurrentApp")}</p>
          ) : null}
          {body ? <p className="ch-wechat-consent__body" style={{ whiteSpace: "pre-line" }}>{body}</p> : null}
          {step === "disk" && diskAccess !== "idle" && diskAccess !== "checking" ? (
            <p className="ch-wechat-consent__body">{t("computerHistory.wechat.guideDiskReturn")}</p>
          ) : null}
          {permissionError ? <p className="ch__error" role="alert">{t("computerHistory.wechat.guideDiskActionFailed")}</p> : null}
        </div>
      </Modal>
    </div>,
    document.body,
  );
}
