/** Confirm dialog module. */
import { X } from "lucide-react";
import { useId, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "./button.js";
import { Memmy, type MemmyPose } from "./mascot/memmy.js";
import { Modal } from "./modal.js";

export type ConfirmDialogSizeValue = number | string;
export type ConfirmDialogConfirmVariant = "primary" | "danger";

export interface ConfirmDialogProps {
  open: boolean;
  message: ReactNode;
  cancelLabel?: string;
  closeLabel?: string;
  confirmLabel: string;
  ariaLabel?: string;
  buttonMinWidth?: ConfirmDialogSizeValue;
  confirmDisabled?: boolean;
  confirmVariant?: ConfirmDialogConfirmVariant;
  contentMaxHeight?: ConfirmDialogSizeValue;
  icon?: ReactNode | null;
  iconContainerSize?: number;
  iconPose?: MemmyPose;
  iconSize?: number;
  maxWidth?: ConfirmDialogSizeValue;
  minHeight?: ConfirmDialogSizeValue;
  title?: string;
  width?: ConfirmDialogSizeValue;
  onCancel?: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  const descriptionId = useId();
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  const showCancelButton = Boolean(props.cancelLabel && props.onCancel);
  const iconContainerSize = props.iconContainerSize ?? 56;
  const iconSize = props.iconSize ?? 48;
  const title = props.title ?? (typeof props.message === "string" ? props.message : props.confirmLabel);
  const accessibleLabel = props.ariaLabel ?? title;
  const showTitle = props.title != null && props.title.trim().length > 0;
  const dialogStyle: CSSProperties = {
    maxWidth: toCssSize(props.maxWidth ?? "calc(100vw - 32px)"),
    minHeight: toCssSize(props.minHeight ?? (showTitle ? 152 : 180)),
    width: toCssSize(props.width ?? 360)
  };
  const iconContainerStyle: CSSProperties = {
    height: iconContainerSize,
    width: iconContainerSize
  };
  const contentStyle: CSSProperties = {
    maxHeight: toCssSize(props.contentMaxHeight ?? "max(72px, min(220px, calc(100dvh - 220px)))")
  };
  const buttonStyle: CSSProperties | undefined = showTitle
    ? undefined
    : { minWidth: toCssSize(props.buttonMinWidth ?? 72) };

  if (!props.open) {
    return null;
  }

  const icon = props.icon ?? (props.iconPose ? <Memmy pose={props.iconPose} size={iconSize} /> : null);

  return (
    <Modal
      open={props.open}
      title={title}
      showHeader={showTitle}
      showCloseButton={showTitle && showCancelButton}
      closeLabel={props.closeLabel ?? "Close"}
      closeContent={<X size={16} aria-hidden="true" />}
      ariaLabel={showTitle ? props.ariaLabel : accessibleLabel}
      ariaDescribedBy={descriptionId}
      className={showTitle ? "confirm-dialog confirm-dialog--titled" : "confirm-dialog"}
      bodyClassName="confirm-dialog__body"
      footerClassName="confirm-dialog__footer"
      style={dialogStyle}
      initialFocusRef={showCancelButton ? cancelButtonRef : confirmButtonRef}
      onClose={props.onCancel}
      footer={(
        <>
          {showCancelButton && (
            <Button
              ref={cancelButtonRef}
              type="button"
              variant={showTitle ? "ghost" : "soft"}
              size="sm"
              onClick={props.onCancel}
              style={buttonStyle}
            >
              {props.cancelLabel}
            </Button>
          )}
          <Button
            ref={confirmButtonRef}
            type="button"
            variant={props.confirmVariant ?? "primary"}
            size="sm"
            disabled={props.confirmDisabled}
            onClick={props.onConfirm}
            style={buttonStyle}
          >
            {props.confirmLabel}
          </Button>
        </>
      )}
    >
      {icon && (
        <div
          className="confirm-dialog__icon"
          style={iconContainerStyle}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}
      <div
        id={descriptionId}
        className={icon ? "confirm-dialog__message" : "confirm-dialog__message confirm-dialog__message--no-icon"}
        style={contentStyle}
      >
        {props.message}
      </div>
    </Modal>
  );
}

function toCssSize(value: ConfirmDialogSizeValue): string {
  return typeof value === "number" ? `${value}px` : value;
}
