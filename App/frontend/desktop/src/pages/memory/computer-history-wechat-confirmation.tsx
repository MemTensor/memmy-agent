import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { Button } from "../../components/button.js";
import { Modal } from "../../components/modal.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { openExternalUrl } from "../../utils/open-url.js";
import { isWindowsDesktopPlatform } from "../../utils/window-fullscreen.js";

type WeChatGuideConnection = "disabled" | "unavailable" | "needs_setup" | "connecting" | "connected" | "error";
type DiskAccess = "idle" | "checking" | "needed";

const MACOS_FULL_DISK_ACCESS_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

export function ComputerHistoryWeChatConfirmation(props: {
  open: boolean;
  busy: boolean;
  connection: WeChatGuideConnection | null;
  phase: string | null;
  error: string | null;
  onCancel(): void;
  onLoggedIn(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const windows = isWindowsDesktopPlatform();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [started, setStarted] = useState(false);
  const [phoneAck, setPhoneAck] = useState(false);
  const [diskAccess, setDiskAccess] = useState<DiskAccess>("idle");
  const startedConnection = useRef(false);
  const openRef = useRef(props.open);
  openRef.current = props.open;
  const onLoggedInRef = useRef(props.onLoggedIn);
  onLoggedInRef.current = props.onLoggedIn;
  const startConnectionRef = useRef(() => {});
  startConnectionRef.current = () => {
    if (startedConnection.current) return;
    startedConnection.current = true;
    setDiskAccess("idle");
    setStarted(true);
    onLoggedInRef.current();
  };

  useEffect(() => {
    if (!props.open) {
      setStarted(false);
      setPhoneAck(false);
      setDiskAccess("idle");
      startedConnection.current = false;
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open || diskAccess !== "needed") return;
    let cancelled = false;
    const recheck = () => {
      if (document.visibilityState === "hidden") return;
      const check = window.memmy?.getFullDiskAccessStatus;
      if (!check) return;
      void check().then((granted) => {
        if (cancelled || !granted || !openRef.current) return;
        startConnectionRef.current();
      }).catch(() => undefined);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [diskAccess, props.open]);

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
    if (startedConnection.current || diskAccess === "checking") return;
    const check = windows ? undefined : window.memmy?.getFullDiskAccessStatus;
    if (!check) {
      startConnectionRef.current();
      return;
    }
    setDiskAccess("checking");
    void check().then((granted) => {
      if (!openRef.current || startedConnection.current) return;
      if (granted) {
        startConnectionRef.current();
        return;
      }
      setDiskAccess("needed");
      void openExternalUrl(MACOS_FULL_DISK_ACCESS_URL);
    }).catch(() => {
      if (!openRef.current || startedConnection.current) return;
      startConnectionRef.current();
    });
  }

  const waitingForPhone = props.phase === "awaiting_wechat_login" || props.phase === "waiting_for_login";
  const step = diskAccess === "needed"
    ? "disk"
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
    : step === "login" ? t(windows ? "computerHistory.wechat.guideLoginTitleWindows" : "computerHistory.wechat.guideLoginTitle")
      : step === "phone" ? t("computerHistory.wechat.guidePhoneTitle")
        : step === "done" ? t("computerHistory.wechat.guideDoneTitle")
          : step === "failed" ? t("computerHistory.wechat.guideFailedTitle")
            : t("computerHistory.wechat.guideMemmyTitle");
  const body = step === "disk" ? t("computerHistory.wechat.guideDiskBody")
    : step === "login" ? t(windows ? "computerHistory.wechat.guideLoginBodyWindows" : "computerHistory.wechat.guideLoginBody")
      : step === "phone" ? t("computerHistory.wechat.guidePhoneBody")
        : step === "failed" ? (props.error || t("computerHistory.wechat.guideFailedBody"))
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
        onClose={step === "done" ? props.onClose : props.onCancel}
        footer={(
          <>
            {step !== "done" ? (
              <Button ref={cancelRef} type="button" variant="ghost" size="sm" onClick={props.onCancel}>
                {t("dialog.cancel")}
              </Button>
            ) : null}
            {step === "login" ? (
              <Button type="button" variant="primary" size="sm" disabled={diskAccess === "checking"} onClick={onLoginConfirmed}>
                {t("computerHistory.wechat.guideLoginButton")}
              </Button>
            ) : null}
            {step === "disk" ? (
              <Button type="button" variant="primary" size="sm" onClick={() => void openExternalUrl(MACOS_FULL_DISK_ACCESS_URL)}>
                {t("computerHistory.wechat.guideDiskButton")}
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
          {body ? <p className="ch-wechat-consent__body">{body}</p> : null}
        </div>
      </Modal>
    </div>,
    document.body,
  );
}
