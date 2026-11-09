import { Cloud, Folder, MessageSquare, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createHttpCollabClient, type CollabClient, type CollabInvitePreview, type CollabProject } from "../api/collab-client.js";
import { useOptionalApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import { memberColor } from "./collab-member-color.js";
import styles from "./collab-page.module.css";

const TOAST_MS = 2_400;
/** Avatars on the project card; the prototype shows three. */
const CARD_AVATARS = 3;

/** One dialog for the whole app, opened from the sidebar's project menu. */
export function CollabJoinProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The person is in the project; the caller makes its local project and opens the board. */
  onJoined: (project: CollabProject) => void;
  /** 申请已提交。调用方把它放进侧边栏，显示项目名称和「申请中」。 */
  onApplied?: (application: { projectId: string; projectName: string }) => void;
  /** Switches the same dialog to creating a project; both entries live in one place now. */
  onCreateProject?: () => void;
}) {
  // Rendered by AppFrame, which also runs in tests and error states without providers.
  const { clients } = useOptionalApiClients();
  const collab = useMemo(() => (clients ? createHttpCollabClient(clients.runtimeConfig) : null), [clients]);
  if (!collab) return null;
  return <JoinProjectModal {...props} collab={collab} />;
}

/**
 * Paste an invite link, then decide: the project, who invited, what joining shares, and where tasks will run. The
 * project's join mode decides whether the button joins at once or sends a request (PRD 3.4).
 */
export function JoinProjectModal(props: {
  open: boolean;
  collab: CollabClient;
  onClose: () => void;
  onJoined: (project: CollabProject) => void;
  onApplied?: (application: { projectId: string; projectName: string }) => void;
  onCreateProject?: () => void;
}) {
  const { t } = useTranslation();
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<CollabInvitePreview | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.open) return;
    setReference("");
    setPreview(null);
    setDirectory(null);
    setError(null);
  }, [props.open]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  function showToast(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), TOAST_MS);
  }

  async function readInvite() {
    if (!reference.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await props.collab.previewInvite(reference.trim()));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function chooseDirectory() {
    const picked = await window.memmy?.selectProjectDirectory?.().catch(() => null);
    if (picked && !picked.canceled) setDirectory(picked.path);
  }

  async function join() {
    if (!preview || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await props.collab.joinProject(reference.trim(), directory ?? undefined);
      if (result.status === "pending") {
        props.onApplied?.({ projectId: result.projectId, projectName: preview.projectName });
        props.onClose();
        showToast(t("collab.join.applied"));
        return;
      }
      if (result.project) {
        props.onClose();
        showToast(t("collab.join.joined", { name: result.project.name }));
        props.onJoined(result.project);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const pending = preview?.status === "pending";
  const primaryLabel = !preview
    ? t("collab.join.next")
    : preview.status === "member"
      ? t("collab.join.open")
      : pending
        ? t("collab.join.pending")
        : preview.joinMode === "direct"
          ? t("collab.join.join")
          : t("collab.join.apply");

  return (
    <>
      <Modal
        open={props.open}
        title={preview ? t("collab.join.title", { name: preview.inviterName }) : t("collab.join.pasteTitle")}
        onClose={props.onClose}
        closeLabel={t("common.close")}
        closeContent={<X size={16} aria-hidden="true" />}
        initialFocusRef={inputRef}
        className={styles.createModal}
        backdropClassName={styles.backdrop}
        footer={(
          <>
            <span />
            <span className={styles.footerButtons}>
              <Button variant="ghost" onClick={props.onClose}>{preview ? t("collab.join.later") : t("collab.cancel")}</Button>
              <Button
                variant="primary"
                disabled={busy || pending || (!preview && !reference.trim())}
                onClick={() => void (preview ? join() : readInvite())}
              >
                {primaryLabel}
              </Button>
            </span>
          </>
        )}
      >
        <div className={styles.projectTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected="false"
            className={styles.projectTab}
            onClick={props.onCreateProject}
          >
            {t("collab.create.title")}
          </button>
          <button type="button" role="tab" aria-selected="true" className={`${styles.projectTab} ${styles.projectTabOn}`}>
            {t("collab.join.pasteTitle")}
          </button>
        </div>
        {preview ? (
          <>
            <div className={styles.joinCard}>
              <span className={styles.joinCardIcon} aria-hidden="true"><Cloud size={20} /></span>
              <span className={styles.joinCardName}>{preview.projectName}</span>
              <span className={styles.avatarStack} aria-label={preview.memberNames.join("、")}>
                {preview.memberNames.slice(0, CARD_AVATARS).map((name, index) => (
                  <span key={`${name}-${index}`} className={styles.avatar} style={{ background: memberColor(name) }} aria-hidden="true">
                    {Array.from(name.trim())[0] ?? "?"}
                  </span>
                ))}
              </span>
            </div>
            <ul className={styles.joinNotes}>
              <li className={styles.joinNote}>
                <MessageSquare size={16} aria-hidden="true" className={styles.joinNoteIcon} />
                <span>{t("collab.join.noteSessions")}</span>
              </li>
              <li className={styles.joinNote}>
                <Sparkles size={16} aria-hidden="true" className={styles.joinNoteIcon} />
                <span>{t("collab.join.noteAgent")}</span>
              </li>
            </ul>
            {preview.status === "member" ? null : (
              <div className={styles.field}>
                <span>{t("collab.create.dirOptional")}</span>
                <div className={styles.dirField}>
                  <Folder size={15} aria-hidden="true" className={styles.dirIcon} />
                  <span className={`${styles.dirPath} ${directory ? "" : styles.dirPlaceholder}`}>
                    {directory ?? t("collab.create.dirUnset")}
                  </span>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => void chooseDirectory()}>
                    {directory ? t("collab.create.dirChange") : t("collab.create.dirPick")}
                  </Button>
                </div>
                <small className={styles.fieldHint}>{t("collab.join.dirHint")}</small>
              </div>
            )}
          </>
        ) : (
          <label className={styles.field}>
            <span>{t("collab.join.linkLabel")}</span>
            <input
              ref={inputRef}
              value={reference}
              placeholder={t("collab.join.pastePlaceholder")}
              onChange={(event) => setReference(event.target.value)}
              onKeyDown={(event) => {
                // 回车确认输入法候选词时不要当成“读邀请”；粘贴链接本身不经过输入法。
                if (event.key !== "Enter" || isComposingKeyboardEvent(event)) return;
                void readInvite();
              }}
            />
          </label>
        )}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </Modal>
      {toast ? <div className={styles.toast} role="status">{toast}</div> : null}
    </>
  );
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
