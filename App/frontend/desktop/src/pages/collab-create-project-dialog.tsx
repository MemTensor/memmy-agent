import { Cloud, Folder, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createHttpCollabClient, type CollabClient, type CollabProject } from "../api/collab-client.js";
import { requestCollabTour } from "../app/collab-projects-store.js";
import { prepareProjectDirectory } from "../api/projects-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useOptionalApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import styles from "./collab-page.module.css";

const MAX_PROJECT_NAME_CHARS = 20;

/** One dialog for the whole app, so creating a project never needs to change the page behind it. */
export function CollabCreateProjectDialog(props: {
  open: boolean;
  onClose: () => void;
  /** The project exists on this computer; the caller opens its board. */
  onCreated: (localProjectId: string) => void;
  /** The project's cloud record was created and is about to be bound. */
  onShared: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
  /** The local project exists but sharing did not start; it opens without sharing. */
  onShareFailed: (reason: string) => void;
  /** Switches the same dialog to joining a shared project; both entries live in one place now. */
  onJoinProject?: () => void;
}) {
  // Rendered by AppFrame, which also runs in tests and error states without providers.
  const { clients } = useOptionalApiClients();
  const collab = useMemo(
    () => (clients ? createHttpCollabClient(clients.runtimeConfig) : null),
    [clients]
  );
  if (!collab) return null;
  return <CreateProjectModal {...props} collab={collab} />;
}

export function CreateProjectModal(props: {
  open: boolean;
  collab: CollabClient;
  onClose: () => void;
  onCreated: (localProjectId: string) => void;
  onShared: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
  onShareFailed: (reason: string) => void;
  onJoinProject?: () => void;
}) {
  const { t } = useTranslation();
  const bridge = useOptionalAgentRuntimeBridge();
  const { clients } = useOptionalApiClients();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  /** Off by default: a project stays on this computer unless the person asks for members to see it. */
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const trimmed = name.trim();
  const valid = trimmed.length > 0 && Array.from(trimmed).length <= MAX_PROJECT_NAME_CHARS;

  useEffect(() => {
    if (props.open) {
      setName("");
      setDirectory(null);
      setShare(false);
      setError(null);
    }
  }, [props.open]);

  async function chooseDirectory() {
    // Any existing folder is fine here: the project's tasks run in it, it does not have to be empty.
    const picked = await window.memmy?.selectProjectDirectory?.().catch(() => null);
    if (picked && !picked.canceled) setDirectory(picked.path);
  }

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const chosenDirectory = directory;
    // The project always needs a working directory; without a picked folder a managed one is created for it.
    let workingDirectory = chosenDirectory;
    let localProjectId: string | null = null;
    try {
      if (!workingDirectory) {
        if (!clients) throw new Error(t("collab.create.localFailed"));
        workingDirectory = await prepareProjectDirectory(clients.runtimeConfig, trimmed);
      }
      const outcome = await bridge?.taskStateCoordinator.mutateProject({
        kind: "create",
        input: {
          // Always its own record: sharing a folder with an existing project must not merge the two.
          mode: chosenDirectory ? "existing" : "blank",
          path: workingDirectory,
          name: trimmed,
          allowShared: true
        }
      });
      localProjectId = outcome?.status === "committed" ? outcome.project?.id ?? null : null;
      if (!localProjectId) throw new Error(t("collab.create.localFailed"));
    } catch (cause) {
      setError(messageOf(cause) || t("collab.create.localFailed"));
      setBusy(false);
      return;
    }

    if (!share) {
      setBusy(false);
      props.onCreated(localProjectId);
      return;
    }

    const createdLocalProjectId = localProjectId;
    /** 只有云端记录真的建成了才开始引导：建失败时项目只是本机项目，那些与成员相关的步骤没有对象。 */
    let sharingStarted = false;
    try {
      // The cloud record points at the folder the project already runs in, so both keep the same directory.
      const created = await props.collab.createProject(trimmed, workingDirectory);
      sharingStarted = true;
      props.onShared(created.project);
      try {
        await props.collab.bindLocalProject(created.project.id, createdLocalProjectId);
        props.onBound(created.project.id, createdLocalProjectId);
      } catch (cause) {
        // Sharing works without the binding; the next launch retries it, so this is not worth blocking on.
        props.onBindFailed(messageOf(cause));
      }
    } catch (cause) {
      // The project exists locally; only sharing did not start, and the board can retry it.
      props.onShareFailed(messageOf(cause));
    } finally {
      setBusy(false);
    }
    // 刚建立协作：看板打开后走一遍首次引导（本机已看过则不再出现）。
    if (sharingStarted) requestCollabTour(createdLocalProjectId);
    props.onCreated(createdLocalProjectId);
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.create.title")}
      subtitle={t("collab.create.subtitle")}
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
            <Button variant="ghost" onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>
              {t("collab.create.submit")}
            </Button>
          </span>
        </>
      )}
    >
      <div className={styles.projectTabs} role="tablist">
        <button type="button" role="tab" aria-selected="true" className={`${styles.projectTab} ${styles.projectTabOn}`}>
          {t("collab.create.title")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          className={styles.projectTab}
          onClick={props.onJoinProject}
        >
          {t("collab.join.pasteTitle")}
        </button>
      </div>
      {/* 与项目配置同一套行式排布：左侧标题与说明，右侧输入框 / 按钮 / 开关 */}
      <div className={styles.settingsRows}>
        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            {/* 字数限制写在输入框的占位里，说明位置不再重复一句 */}
            <div className={styles.settingsRowTitle}>{t("collab.create.name")}</div>
          </div>
          <div className={styles.settingsRowControl}>
            <input
              ref={inputRef}
              className={styles.settingsRowInput}
              value={name}
              maxLength={40}
              placeholder={t("collab.create.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                // 中文等输入法用回车确认候选词（组词上屏），那不是提交意图：否则半成品拼音会被当成项目名。
                if (event.key !== "Enter" || isComposingKeyboardEvent(event)) return;
                void submit();
              }}
            />
          </div>
        </div>

        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            <div className={styles.settingsRowTitle}>{t("collab.create.dirOptional")}</div>
            {/* 选过目录就把路径显示在说明位置，不再另占一行 */}
            <div className={`${styles.settingsRowDesc}${directory ? ` ${styles.settingsRowPath}` : ""}`} title={directory ?? undefined}>
              {directory ?? t("collab.create.dirHint")}
            </div>
          </div>
          <div className={styles.settingsRowControl}>
            <Button size="sm" onClick={() => void chooseDirectory()}>
              {directory ? t("collab.create.dirChange") : t("collab.create.dirPick")}
            </Button>
          </div>
        </div>

        <div className={styles.settingsRow}>
          <div className={styles.settingsRowText}>
            <div className={styles.settingsRowTitle}>{t("collab.create.share")}</div>
            <div className={styles.settingsRowDesc}>{t("collab.create.shareHint")}</div>
          </div>
          <div className={styles.settingsRowControl}>
            <button
              type="button"
              role="switch"
              aria-checked={share}
              aria-label={t("collab.create.share")}
              onClick={() => setShare(!share)}
              className={`${styles.settingsSwitch}${share ? ` ${styles.settingsSwitchOn}` : ""}`}
            />
          </div>
        </div>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
