/** App-wide notification center: a top-right stack with a queue for overflow. */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "../i18n/use-translation.js";
import { NotificationToast, type NotificationVariant } from "./notification-toast.js";

/** Max notifications visible at once; extras wait in the queue until a slot frees. */
export const NOTIFICATION_STACK_MAX_VISIBLE = 3;

export interface NotificationInput {
  variant?: NotificationVariant;
  title: string;
  body?: string;
  /** Optional emphasized value shown as the hero line, e.g. a credited token amount. */
  emphasis?: string;
  /** Optional icon override; defaults to the variant icon. */
  icon?: LucideIcon;
  /** Optional inline action link; clicking it runs onAction, then dismisses the notification. */
  actionLabel?: string;
  onAction?: () => void;
  /** Side effect to run when this notification is dismissed (e.g. refresh balance). */
  onClose?: () => void;
}

interface NotificationItem extends NotificationInput {
  id: string;
}

export interface NotificationCenterValue {
  /** Enqueues a notification and returns its id. */
  notify(input: NotificationInput): string;
  /** Dismisses a notification by id (runs its onClose). */
  dismiss(id: string): void;
}

const NotificationCenterContext = createContext<NotificationCenterValue | null>(null);

let notificationSeq = 0;

function nextNotificationId(): string {
  notificationSeq += 1;
  return `notification-${notificationSeq}-${Date.now()}`;
}

/** Provides notify/dismiss and renders the top-right stack. */
export function NotificationCenterProvider(props: { children: ReactNode }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const closeCallbacksRef = useRef(new Map<string, (() => void) | undefined>());

  const dismiss = useCallback((id: string) => {
    if (!closeCallbacksRef.current.has(id)) {
      return;
    }
    const onClose = closeCallbacksRef.current.get(id);
    closeCallbacksRef.current.delete(id);
    setItems((current) => current.filter((item) => item.id !== id));
    onClose?.();
  }, []);

  const notify = useCallback((input: NotificationInput) => {
    const id = nextNotificationId();
    closeCallbacksRef.current.set(id, input.onClose);
    setItems((current) => [...current, { ...input, id }]);
    return id;
  }, []);

  const value = useMemo<NotificationCenterValue>(() => ({ notify, dismiss }), [notify, dismiss]);

  // Keep FIFO order; show the first N, render newest-of-those on top.
  const visible = items.slice(0, NOTIFICATION_STACK_MAX_VISIBLE);
  const stack = typeof document === "undefined" || visible.length === 0
    ? null
    : createPortal(
        <div className="memmy-notification-stack" role="region" aria-label={t("notifications.regionLabel")}>
          {[...visible].reverse().map((item) => (
            <NotificationToast
              key={item.id}
              variant={item.variant}
              title={item.title}
              body={item.body}
              emphasis={item.emphasis}
              icon={item.icon}
              actionLabel={item.actionLabel}
              onAction={item.onAction ? () => {
                item.onAction?.();
                dismiss(item.id);
              } : undefined}
              onDismiss={() => dismiss(item.id)}
            />
          ))}
        </div>,
        document.body
      );

  return (
    <NotificationCenterContext.Provider value={value}>
      {props.children}
      {stack}
    </NotificationCenterContext.Provider>
  );
}

/** Access the notification center; throws outside the provider. */
export function useNotificationCenter(): NotificationCenterValue {
  const value = useContext(NotificationCenterContext);
  if (!value) {
    throw new Error("useNotificationCenter must be used within NotificationCenterProvider");
  }
  return value;
}
