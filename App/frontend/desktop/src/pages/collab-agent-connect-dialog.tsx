import { Info, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AddedAgent, CollabClient } from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { Modal } from "../components/modal.js";
import { useTranslation } from "../i18n/use-translation.js";
import styles from "./collab-agent-connect-dialog.module.css";

/**
 * 让 Memmy 能在一个本机上已有的 Agent 里使用协作项目：用户给名字（知道技能目录时可以一起给），
 * 剩下交给一条本机任务——找到这个 Agent 读取技能的目录，把 memmy-project 装进去。
 * 这一步不关联任何会话，Memmy 也不读这个 Agent 的任务记录；加入项目由它自己提交。
 */
export function CollabAgentConnectDialog(props: {
  open: boolean;
  /** 新建的那条任务属于这个项目：说明里点名，用户知道它落在哪里。 */
  projectName: string;
  /** 已添加的 Agent：列在弹窗里，可以移除。 */
  added: AddedAgent[];
  collab: CollabClient | null;
  onClose: () => void;
  onStart: (name: string, skillDirectory?: string) => void;
  /** 移除后重新读一次清单。 */
  onRemoved: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [skillDirectory, setSkillDirectory] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const trimmed = name.trim();

  useEffect(() => {
    if (!props.open) return;
    setName("");
    setSkillDirectory("");
    setError(null);
  }, [props.open]);

  const start = useCallback(() => {
    if (!trimmed) return;
    const folder = skillDirectory.trim();
    props.onStart(trimmed, folder || undefined);
  }, [props, skillDirectory, trimmed]);

  /** 文件夹选择器：技能目录是一个本机路径，让用户点选比手输可靠。 */
  async function chooseSkillDirectory() {
    const picked = await window.memmy?.selectProjectDirectory?.().catch(() => null);
    if (picked && !picked.canceled) setSkillDirectory(picked.path);
  }

  async function remove(agent: AddedAgent) {
    if (!props.collab || removing) return;
    setRemoving(agent.name);
    setError(null);
    try {
      await props.collab.removeAddedAgent(agent.name);
      props.onRemoved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("collab.agentConnect.removeFailed"));
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Modal
      open={props.open}
      title={t("collab.agentConnect.title")}
      subtitle={t("collab.agentConnect.subtitle")}
      onClose={props.onClose}
      closeLabel={t("common.close")}
      closeContent={<X size={16} aria-hidden="true" />}
      initialFocusRef={nameRef}
      className={styles.dialog}
      backdropClassName={styles.backdrop}
      footer={(
        <span className={styles.footer}>
          <Button variant="ghost" onClick={props.onClose}>{t("collab.cancel")}</Button>
          <Button variant="primary" disabled={!trimmed} onClick={start}>
            {t("collab.agentConnect.start")}
          </Button>
        </span>
      )}
    >
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t("collab.agentConnect.name")}</span>
        <input
          ref={nameRef}
          className={styles.input}
          value={name}
          placeholder={t("collab.agentConnect.namePlaceholder")}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") start();
          }}
        />
      </label>
      <div className={styles.field}>
        <span className={styles.fieldLabel}>
          {t("collab.agentConnect.skillDir")}
          <span className={styles.optional}>{t("collab.agentConnect.optional")}</span>
        </span>
        <div className={styles.pathRow}>
          <span
            className={`${styles.pathValue}${skillDirectory ? "" : ` ${styles.pathEmpty}`}`}
            title={skillDirectory || undefined}
          >
            {skillDirectory || t("collab.agentConnect.skillDirUnset")}
          </span>
          <Button size="sm" onClick={() => void chooseSkillDirectory()}>
            {t(skillDirectory ? "collab.agentConnect.skillDirChange" : "collab.agentConnect.skillDirPick")}
          </Button>
        </div>
        <span className={styles.fieldHint}>{t("collab.agentConnect.skillDirHint")}</span>
      </div>
      <div className={styles.note}>
        <Info size={15} aria-hidden="true" className={styles.noteIcon} />
        <div className={styles.noteText}>
          <p>{t("collab.agentConnect.note", { project: props.projectName })}</p>
          {/* 给一句能直接照着说的话，否则「在对话里说明」太抽象 */}
          <p className={styles.noteExample}>{t("collab.agentConnect.noteExample", { project: props.projectName })}</p>
        </div>
      </div>
      {props.added.length ? (
        <section className={styles.added} aria-label={t("collab.agentConnect.addedTitle")}>
          <b className={styles.addedTitle}>{t("collab.agentConnect.addedTitle")}</b>
          <ul className={styles.addedList}>
            {props.added.map((agent) => (
              <li key={agent.sourceId} className={styles.addedRow}>
                <span className={styles.addedName}>{agent.name}</span>
                <button
                  type="button"
                  className={styles.addedRemove}
                  disabled={removing !== null}
                  onClick={() => void remove(agent)}
                >
                  {removing === agent.name ? t("collab.agentConnect.removing") : t("collab.agentConnect.remove")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
    </Modal>
  );
}
