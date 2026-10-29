import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useTranslation } from "../../i18n/use-translation.js";
import { openExternalUrl } from "../../utils/open-url.js";

const READING_DELAY_MS = 3_000;
const SOURCE_URL = "https://github.com/MemTensor/memmy-agent";

export function ComputerHistoryWeChatRiskConfirmation(props: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  const [remainingSeconds, setRemainingSeconds] = useState(3);
  const readyAt = useRef(Infinity);
  const finished = useRef(false);

  useLayoutEffect(() => {
    finished.current = false;
    setRemainingSeconds(3);
    readyAt.current = props.open ? performance.now() + READING_DELAY_MS : Infinity;
    if (!props.open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      readyAt.current = Infinity;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const timer = window.setInterval(() => {
      setRemainingSeconds(Math.max(0, Math.ceil((readyAt.current - performance.now()) / 1_000)));
    }, 250);
    return () => window.clearInterval(timer);
  }, [props.open]);

  if (!props.open) return null;

  const cancel = () => {
    if (finished.current) return;
    finished.current = true;
    props.onCancel();
  };
  const confirm = () => {
    if (finished.current || remainingSeconds > 0 || performance.now() < readyAt.current) return;
    finished.current = true;
    props.onConfirm();
  };

  return createPortal(
    <div className="ch-recording-confirmation">
      <ConfirmDialog
        open
        title={t("computerHistory.wechat.riskTitle")}
        width={520}
        contentMaxHeight="max(160px, min(480px, calc(100dvh - 200px)))"
        cancelLabel={t("dialog.cancel")}
        closeLabel={t("common.close")}
        confirmLabel={remainingSeconds > 0
          ? t("computerHistory.wechat.riskCountdown", { seconds: remainingSeconds })
          : t("computerHistory.wechat.riskConfirm")}
        confirmDisabled={remainingSeconds > 0}
        message={(
          <div className="flex flex-col gap-3">
            <p className="ch-wechat-consent__body">{t("computerHistory.wechat.riskReading")}</p>
            <p className="ch-wechat-consent__body">{t("computerHistory.wechat.riskModel")}</p>
            <p className="ch-wechat-consent__body">{t("computerHistory.wechat.riskAccount")}</p>
            <p className="ch-wechat-consent__body">
              {t("computerHistory.wechat.riskSourceBefore")}
              <a href={SOURCE_URL} target="_blank" rel="noopener noreferrer"
                className="text-action-sky underline underline-offset-2"
                onClick={(event) => {
                  event.preventDefault();
                  void openExternalUrl(SOURCE_URL);
                }}>
                {t("computerHistory.wechat.riskSourceLink")}
              </a>
              {t("computerHistory.wechat.riskSourceAfter")}
            </p>
            <p className="ch-wechat-consent__body">{t("computerHistory.wechat.riskReadNotice")}</p>
          </div>
        )}
        onCancel={cancel}
        onConfirm={confirm}
      />
    </div>,
    document.body,
  );
}
