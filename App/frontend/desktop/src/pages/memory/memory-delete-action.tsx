import { useState } from "react";
import { useTranslation } from "../../i18n/use-translation.js";
import { Trash2 } from "./memory-prototype-icons.js";
import { toErrorMessage } from "./remote-state.js";

export interface MemoryDrawerDeleteActionProps {
  onDelete: () => Promise<void>;
}

export function MemoryDrawerDeleteAction(props: MemoryDrawerDeleteActionProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDeleteClick() {
    if (!confirming) {
      setConfirming(true);
      setError(null);
      return;
    }

    setDeleting(true);
    setError(null);
    try {
      await props.onDelete();
      setDeleting(false);
      setConfirming(false);
    } catch (deleteError) {
      setDeleting(false);
      setError(toErrorMessage(deleteError));
    }
  }

  return (
    <footer className="memory-drawer__footer">
      <div className="memory-delete-action">
        <div className="memory-delete-action__controls">
          <button
            type="button"
            className={`memory-delete-button${confirming ? " memory-delete-button--confirming" : ""}`}
            onClick={() => void handleDeleteClick()}
            disabled={deleting}
          >
            <Trash2 size={12} />
            {deleting ? t("memory.delete.deleting") : confirming ? t("memory.delete.confirm") : t("memory.delete.button")}
          </button>
          {confirming && !deleting && (
            <button
              type="button"
              className="memory-delete-cancel-button"
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              {t("memory.delete.cancel")}
            </button>
          )}
        </div>
        {confirming && <div className="memory-delete-action__hint">{t("memory.delete.confirmHint")}</div>}
        {error && <div className="memory-delete-action__error">{error}</div>}
      </div>
    </footer>
  );
}
