import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useTranslation } from "../../i18n/use-translation.js";

export function ComputerHistoryRecordingConfirmation(props: {
  open: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const { t } = useTranslation();
  const [noticeBefore, noticeAfter] = t("computerHistory.enableModelNotice").split("{operations}");

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

  return createPortal(
    <div className="ch-recording-confirmation">
      <ConfirmDialog
        open
        title={t("computerHistory.enableTitle")}
        width={440}
        cancelLabel={t("dialog.cancel")}
        closeLabel={t("common.close")}
        confirmLabel={t("computerHistory.enableConfirm")}
        message={(
          <ul className="ch-recording-confirmation__details">
            <li>
              {noticeBefore}
              <strong className="font-semibold text-text-ink">{t("computerHistory.enableAllOperations")}</strong>
              {noticeAfter}{t("computerHistory.enableLocalNotice")}
            </li>
          </ul>
        )}
        onCancel={props.onCancel}
        onConfirm={props.onConfirm}
      />
    </div>,
    document.body
  );
}
