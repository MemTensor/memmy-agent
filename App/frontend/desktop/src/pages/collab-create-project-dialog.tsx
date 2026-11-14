import { Folder, FolderPlus, Users, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createHttpCollabClient, type CollabClient, type CollabProject } from "../api/collab-client.js";
import { ApiRequestError } from "../api/http.js";
import {
  getCollabProjectsSnapshot,
  requestCollabAccessPrompt,
  subscribeCollabProjects
} from "../app/collab-projects-store.js";
import { prepareProjectDirectory } from "../api/projects-client.js";
import { useOptionalAgentRuntimeBridge } from "../app/agent-runtime-bridge.js";
import { useOptionalApiClients } from "../app/providers.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import { isComposingKeyboardEvent } from "../utils/keyboard.js";
import { InfoHint } from "./collab-info-hint.js";
import styles from "./collab-page.module.css";

const MAX_PROJECT_NAME_CHARS = 20;

/** One dialog for the whole app, so creating a project never needs to change the page behind it. */
export function CollabCreateProjectDialog(props: {
  open: boolean;
  /**
   * 协作项目只在账号模式可用。API Key 模式传 false：弹窗里不出现「与成员共享」，
   * 也就不出现「加入项目」——两者都需要云端账号。
   */
  shareAvailable?: boolean;
  /** 打开时「与成员共享」是否已经开启：新功能介绍的最后一页会要求默认共享。 */
  defaultShare?: boolean;
  /**
   * 新手引导的体验入口：名称预填好、协作开关已打开，用户只需点「创建项目」。
   * 弹窗不加新控件，也不写额外说明；蒙版由引导画在上面，所以要交出自己的暗底。
   */
  demo?: boolean;
  onClose: () => void;
  /**
   * The project exists on this computer. `shareRequested` says whether the person tried to share it: a project that
   * was never meant to be shared lands in a new session, one that sharing was attempted for lands on its board.
   */
  onCreated: (localProjectId: string, outcome: { shareRequested: boolean }) => void;
  /** The project's cloud record was created and is about to be bound. */
  onShared: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
  /** The local project exists but sharing did not start; it opens without sharing. */
  onShareFailed: (reason: string) => void;
  /**
   * 共享没开起来是因为本人可创建的协作项目数已达上限（传入上限值）。
   * 与「服务不可用」分开：项目照建在本机，要说明的是额度，不是稍后重试。
   */
  onShareLimitReached?: (limit: number) => void;
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
  shareAvailable?: boolean;
  defaultShare?: boolean;
  demo?: boolean;
  collab: CollabClient;
  onClose: () => void;
  onCreated: (localProjectId: string, outcome: { shareRequested: boolean }) => void;
  onShared: (project: CollabProject) => void;
  onBound: (projectId: string, localProjectId: string) => void;
  onBindFailed: (reason: string) => void;
  onShareFailed: (reason: string) => void;
  onShareLimitReached?: (limit: number) => void;
  onJoinProject?: () => void;
}) {
  const { t } = useTranslation();
  const bridge = useOptionalAgentRuntimeBridge();
  const { clients } = useOptionalApiClients();
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  /** Off unless the opener asked for it: a project otherwise stays on this computer. */
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** API Key 模式没有云端账号可共享：整个共享入口（含加入项目）都不出现。 */
  const shareAvailable = props.shareAvailable !== false;
  const trimmed = name.trim();
  const nameLength = Array.from(trimmed).length;
  const valid = nameLength > 0 && nameLength <= MAX_PROJECT_NAME_CHARS;
  /**
   * 本人名下的协作项目有几个、最多能有几个：达到上限时先说清这次只建在本机。
   * 上限由云端随列表给出，所以数字不在前端写死。
   */
  const projectsStore = useSyncExternalStore(subscribeCollabProjects, getCollabProjectsSnapshot, getCollabProjectsSnapshot);
  const ownedCount = (projectsStore.projects ?? []).filter((project) => project.role === "owner").length;
  const ownedLimit = projectsStore.maxOwnedProjects;
  /** 额度用完只在准备共享时才值得提：不开共享的话，这一行与自己无关。 */
  const overQuota = share && ownedLimit !== null && ownedCount >= ownedLimit;
  /**
   * 新手引导的演示只在这一个时机出现：本人第一次创建共享项目，也就是还没有自己拥有的在线项目。
   * 加入过别人的项目不影响：加入他人项目本身不演示，之后第一次自己创建时仍然演示。
   * 带了这个标记也不代表一定演示：云端会再判断开关、名单与是否已经体验过，返回 `demo.active` 才真的开始。
   */
  const firstSharedProject = share && shareAvailable && ownedCount === 0;

  /**
   * 打开那一刻的默认勾选：用 ref 带上，effect 只在打开时读一次，弹窗开着时这个值变化不会重置人的选择。
   */
  const demo = props.demo === true && shareAvailable;
  const defaultShareOnOpen = demo || props.defaultShare === true;
  const shareOnOpenRef = useRef(defaultShareOnOpen && shareAvailable);
  shareOnOpenRef.current = defaultShareOnOpen && shareAvailable;

  useEffect(() => {
    if (props.open) {
      // 体验入口的名字替人填好，用户也可以改；普通新建仍然留空等人输入。
      setName(demo ? t("collab.demo.projectName") : "");
      setDirectory(null);
      setShare(shareOnOpenRef.current);
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
      // 只建在本机：直接进入这个项目的新会话，看板留给共享过的那条路径。
      props.onCreated(localProjectId, { shareRequested: false });
      return;
    }

    const createdLocalProjectId = localProjectId;
    /** 只有云端记录真的建成了才开始引导：建失败时项目只是本机项目，那些与成员相关的步骤没有对象。 */
    let sharingStarted = false;
    try {
      // The cloud record points at the folder the project already runs in, so both keep the same directory.
      const created = await props.collab.createProject(trimmed, workingDirectory, {
        demo: firstSharedProject
      });
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
      // 数量上限不是服务故障：同样把项目留在本机，但提示要说清是额度用完，不是稍后重试。
      if (isQuotaExceeded(cause) && ownedLimit !== null) {
        props.onShareLimitReached?.(ownedLimit);
      } else {
        props.onShareFailed(messageOf(cause));
      }
    } finally {
      setBusy(false);
    }
    // 刚开启共享：看板打开后，若还没授权「在其他 Agent 中使用协作项目」，询问一次。
    if (sharingStarted) requestCollabAccessPrompt(createdLocalProjectId);
    // 共享成功、共享失败与达到上限都回看板：授权询问与顶部提示都挂在看板上。
    props.onCreated(createdLocalProjectId, { shareRequested: true });
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.create.title")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      // 演示里不把光标塞进名称框：要点的是「创建项目」，蒙版也只亮它。
      initialFocusRef={demo ? undefined : inputRef}
      className={`${styles.createModal} ${styles.simpleCreateModal}`}
      backdropClassName={demo ? `${styles.backdrop} ${styles.backdropYield}` : styles.backdrop}
      bodyClassName={styles.simpleCreateBody}
      footerClassName={styles.simpleCreateFooter}
      footer={(
        <>
          {shareAvailable && props.onJoinProject ? (
            <Button variant="secondary" size="sm" onClick={props.onJoinProject}>
              {t("collab.create.joinEntry")}
            </Button>
          ) : <span />}
          <span className={styles.footerButtons}>
            <Button variant="ghost" onClick={props.onClose}>{t("collab.cancel")}</Button>
            <Button
              variant="primary"
              disabled={!valid || busy}
              data-demo-guide={demo ? "create-project-submit" : undefined}
              onClick={() => void submit()}
            >
              {t("collab.create.submit")}
            </Button>
          </span>
        </>
      )}
    >
      {/* 名称占满一行：图标与竖线在框内左侧，其余都交给输入本身，不放常驻说明 */}
      <div className={styles.simpleNameField}>
        <span className={styles.simpleNameIcon} aria-hidden="true"><Folder size={16} /></span>
        <span className={styles.simpleNameDivider} aria-hidden="true" />
        <input
          ref={inputRef}
          className={styles.simpleNameInput}
          value={name}
          maxLength={40}
          aria-label={t("collab.create.name")}
          placeholder={t("collab.create.name")}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            // 中文等输入法用回车确认候选词（组词上屏），那不是提交意图：否则半成品拼音会被当成项目名。
            if (event.key !== "Enter" || isComposingKeyboardEvent(event)) return;
            void submit();
          }}
        />
      </div>
      {/* 超出上限才出现一行提示；平时不显示字数规则 */}
      {nameLength > MAX_PROJECT_NAME_CHARS ? (
        <p className={styles.simpleNameHint} role="alert">
          {t("collab.create.nameTooLong", { max: MAX_PROJECT_NAME_CHARS })}
        </p>
      ) : null}

      <div className={styles.simpleSectionLabel}>
        <span>{t("collab.create.folder")}</span>
        <InfoHint label={t("collab.create.folderHelpLabel")} text={t("collab.create.dirHint")} />
      </div>
      {/* 只支持一个目录：选了就把那一行显示出来，没选时给一个大框放「添加」 */}
      <div className={styles.simpleFolderBox}>
        {directory ? (
          <div className={styles.simpleFolderRow}>
            <Folder size={15} aria-hidden="true" className={styles.simpleFolderIcon} />
            <button
              type="button"
              className={styles.simpleFolderName}
              title={directory}
              aria-label={t("collab.create.folderChange")}
              onClick={() => void chooseDirectory()}
            >
              {folderNameOf(directory)}
            </button>
            <button
              type="button"
              className={styles.simpleFolderRemove}
              aria-label={t("collab.create.folderRemove")}
              onClick={() => setDirectory(null)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <div className={styles.simpleFolderEmpty}>
            <span>{t("collab.create.folderEmpty")}</span>
            <Button size="sm" variant="secondary" className={styles.simpleFolderAdd} onClick={() => void chooseDirectory()}>
              <FolderPlus size={14} aria-hidden="true" />
              {t("collab.create.folderAdd")}
            </Button>
          </div>
        )}
      </div>

      {shareAvailable ? (
        <>
          {/* 共享和名称、文件夹一样是一个字段框：不用分隔线另起一段，点整框任意位置都能切换（问号除外） */}
          <div
            className={`${styles.simpleShareField}${share ? ` ${styles.simpleShareFieldOn}` : ""}`}
            onClick={() => setShare((current) => !current)}
          >
            <Users size={16} aria-hidden="true" className={styles.simpleShareIcon} />
            <span className={styles.simpleShareLabel}>{t("collab.create.shareToggle")}</span>
            <span className={styles.simpleShareHint} onClick={(event) => event.stopPropagation()}>
              <InfoHint
                placement="above"
                label={t("collab.create.shareHelpLabel")}
                text={t("collab.create.shareHint")}
              />
            </span>
            {/* 开关自己不处理点击：点击会冒泡到整框只切换一次，键盘的空格 / 回车同样产生点击 */}
            <button
              type="button"
              role="switch"
              aria-checked={share}
              aria-label={t("collab.create.shareToggle")}
              className={`${styles.settingsSwitch}${share ? ` ${styles.settingsSwitchOn}` : ""}`}
            />
          </div>
          {/* 已达上限时先说清：仍然可以建，只是这次只建在本机 */}
          {overQuota ? (
            <p className={styles.simpleQuotaHint}>{t("collab.create.shareQuotaHint", { limit: ownedLimit })}</p>
          ) : null}
        </>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </Modal>
  );
}

/** 只显示末级目录名，完整路径留到悬停提示里。 */
function folderNameOf(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}

/** 本机后端把云端的数量上限错误码单独映射出来，桌面端据此区分「额度用完」与「服务不可用」。 */
function isQuotaExceeded(cause: unknown): boolean {
  return cause instanceof ApiRequestError && cause.code === "collab_quota_exceeded";
}
