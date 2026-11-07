import { ChevronDown, Link2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollabClient, CollabJoinMode, CollabMember, CollabMembers, CollabProject, CollabRole } from "../api/collab-client.js";
import { Button } from "../components/button.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { Modal } from "../components/modal.js";
import type { MessageKey } from "../i18n/messages.js";
import { useTranslation } from "../i18n/use-translation.js";
import { memberColor } from "./collab-member-color.js";
import styles from "./collab-page.module.css";

const ROLE_LABELS: Record<CollabRole, MessageKey> = {
  owner: "collab.members.owner",
  admin: "collab.members.admin",
  member: "collab.members.member"
};

const JOIN_MODE_LABELS: Record<CollabJoinMode, MessageKey> = {
  direct: "collab.members.joinDirect",
  approval: "collab.members.joinApproval"
};

/**
 * 弹窗开着时的刷新间隔。申请落在云端，本机只是读它：对方在别的电脑上提交申请后，这里不必关掉重开就能看到，
 * 看板在弹窗关着时也用同一个间隔查待审核数。
 */
export const MEMBER_REQUESTS_POLL_MS = 4_000;

/**
 * 「邀请成员」/「项目成员 · N」: copy one's invite link, and for owners and admins the join mode, the requests waiting
 * for review, and each other member's role. The cloud decides who may do what; this only hides what would be refused.
 */
export function ProjectMembersDialog(props: {
  open: boolean;
  collab: CollabClient;
  /** The cloud project. */
  projectId: string;
  onClose: () => void;
  onToast: (message: string) => void;
  /** The member count changed, so the board header and the sidebar show the new one. */
  onProjectChanged?: (project: CollabProject) => void;
  /** 待审核的申请数，弹窗关着时看板照样能在「邀请」入口上带角标。 */
  onRequestsChange?: (count: number) => void;
}) {
  const { t } = useTranslation();
  const { collab, projectId, onProjectChanged, onRequestsChange, onToast } = props;
  const [view, setView] = useState<CollabMembers | null>(null);
  const [failed, setFailed] = useState(false);
  /** The action in flight, so a second click does not send it twice. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Which picker is open: the join mode, or a member's role by user id. */
  const [menu, setMenu] = useState<string | null>(null);
  const [removing, setRemoving] = useState<CollabMember | null>(null);
  /** 上一次读到的成员与申请：轮询据此判断该不该重画，以及有没有新申请要提示。 */
  const latest = useRef<CollabMembers | null>(null);
  /** 操作进行中不轮询，免得刚点下去的结果被一份旧列表盖掉。 */
  const acting = useRef(false);
  acting.current = busy !== null;

  const load = useCallback(async () => {
    try {
      const next = await collab.listMembers(projectId);
      latest.current = next;
      setView(next);
      setFailed(false);
      onProjectChanged?.(next.project);
      onRequestsChange?.(next.requests.length);
    } catch {
      setFailed(true);
    }
  }, [collab, projectId, onProjectChanged, onRequestsChange]);

  /**
   * 轮询走的静默刷新：只把变了的成员与申请换上去，失败不弹错，也不清空正在用的列表。
   * 新申请出现时提示一次，让邀请人不用盯着这张列表。
   */
  const refreshQuietly = useCallback(async () => {
    if (acting.current) return;
    try {
      const next = await collab.listMembers(projectId);
      const previous = latest.current;
      latest.current = next;
      onRequestsChange?.(next.requests.length);
      if (previous) {
        const known = new Set(previous.requests.map((old) => old.userId));
        const added = next.requests.filter((request) => !known.has(request.userId));
        const newest = added[added.length - 1];
        if (newest) onToast(t("collab.members.newRequest", { name: newest.name }));
      }
      if (!previous || !sameView(previous, next)) {
        setView(next);
        onProjectChanged?.(next.project);
      }
    } catch {
      // 静默刷新失败保留当前列表，下一个周期再试。
    }
  }, [collab, projectId, onProjectChanged, onRequestsChange, onToast, t]);

  useEffect(() => {
    if (!props.open) return;
    latest.current = null;
    setView(null);
    setFailed(false);
    setMenu(null);
    void load();
  }, [props.open, load]);

  // 申请由别的电脑提交，本机没有推送通道：弹窗开着时按固定间隔读一次，成员与申请都能自己更新。
  const canManage = view?.canManage === true;
  useEffect(() => {
    if (!props.open || !canManage) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void refreshQuietly();
    }, MEMBER_REQUESTS_POLL_MS);
    return () => clearInterval(timer);
  }, [props.open, canManage, refreshQuietly]);

  async function run(key: string, action: () => Promise<string | null>) {
    if (busy) return;
    setBusy(key);
    setMenu(null);
    try {
      const message = await action();
      if (message) onToast(message);
      await load();
    } catch (cause) {
      onToast(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  async function copyInvite() {
    if (busy) return;
    setBusy("invite");
    try {
      const invite = await collab.createInvite(projectId);
      await navigator.clipboard.writeText(invite.shareText);
      onToast(t("collab.members.linkCopied"));
    } catch (cause) {
      onToast(cause instanceof Error && cause.name !== "NotAllowedError" ? messageOf(cause) : t("collab.session.copyFailed"));
    } finally {
      setBusy(null);
    }
  }

  const others = view ? view.members.filter((member) => !member.mine).length : 0;
  // Alone in the project, the dialog is about inviting; with others in it, it is the member list.
  const title = view && others > 0
    ? t("collab.members.title", { count: String(view.members.length) })
    : t("collab.members.inviteTitle");

  return (
    <>
      <Modal
        open={props.open}
        title={title}
        subtitle={view && others > 0 ? undefined : t("collab.members.inviteSubtitle")}
        onClose={props.onClose}
        closeLabel={t("common.close")}
        closeContent={<X size={16} aria-hidden="true" />}
        className={styles.membersModal}
        backdropClassName={styles.backdrop}
      >
        <Button variant="primary" className={styles.inviteButton} disabled={busy === "invite"} onClick={() => void copyInvite()}>
          <Link2 size={15} aria-hidden="true" />
          {t("collab.members.copyLink")}
        </Button>

        {view?.canManage ? (
          <div className={styles.joinModeRow}>
            <span>{t("collab.members.joinMode")}</span>
            <span className={styles.pickerWrap}>
              <button
                type="button"
                className={styles.inlinePicker}
                aria-haspopup="menu"
                aria-expanded={menu === "joinMode"}
                disabled={busy !== null}
                onClick={() => setMenu(menu === "joinMode" ? null : "joinMode")}
              >
                {t(JOIN_MODE_LABELS[view.joinMode])}
                <ChevronDown size={14} aria-hidden="true" />
              </button>
              {menu === "joinMode" ? (
                <div className={styles.inlineMenu} role="menu">
                  {(["direct", "approval"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={view.joinMode === mode}
                      className={styles.menuItem}
                      onClick={() => void run("joinMode", async () => {
                        await collab.setJoinMode(projectId, mode);
                        return null;
                      })}
                    >
                      {t(JOIN_MODE_LABELS[mode])}
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          </div>
        ) : null}

        <div className={styles.membersDivider} />

        {failed ? (
          <div className={styles.membersEmpty} role="alert">
            <p>{t("collab.members.loadFailed")}</p>
            <Button size="sm" onClick={() => void load()}>{t("collab.retry")}</Button>
          </div>
        ) : !view ? (
          <p className={styles.membersEmpty}>{t("collab.loading")}</p>
        ) : (
          <>
            {view.requests.length ? (
              <section className={styles.memberSection} aria-label={t("collab.members.requests", { count: String(view.requests.length) })}>
                <h3 className={styles.memberSectionTitle}>{t("collab.members.requests", { count: String(view.requests.length) })}</h3>
                {view.requests.map((request) => (
                  <div key={request.userId} className={styles.memberRow}>
                    <MemberAvatar name={request.name} />
                    <span className={styles.memberText}>
                      <span className={styles.memberName}>{request.name}</span>
                      <span className={styles.memberHint}>{t("collab.members.requestVia", { name: request.inviterName })}</span>
                    </span>
                    <span className={styles.footerButtons}>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => void run(`reject:${request.userId}`, async () => {
                          await collab.rejectRequest(projectId, request.userId);
                          return t("collab.members.rejected", { name: request.name });
                        })}
                      >
                        {t("collab.members.reject")}
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy !== null}
                        onClick={() => void run(`approve:${request.userId}`, async () => {
                          await collab.approveRequest(projectId, request.userId);
                          return t("collab.members.approved", { name: request.name });
                        })}
                      >
                        {t("collab.members.approve")}
                      </Button>
                    </span>
                  </div>
                ))}
              </section>
            ) : null}

            <section className={styles.memberSection} aria-label={title}>
              {view.members.map((member) => (
                <div key={member.userId} className={styles.memberRow}>
                  <MemberAvatar name={member.name} />
                  <span className={styles.memberText}>
                    <span className={styles.memberName}>
                      {member.name}
                      {member.mine ? t("collab.members.you") : ""}
                    </span>
                  </span>
                  {member.role === "owner" ? (
                    <span className={styles.roleTag}>{t("collab.members.owner")}</span>
                  ) : view.canManage && !member.mine ? (
                    <span className={styles.pickerWrap}>
                      <button
                        type="button"
                        className={styles.inlinePicker}
                        aria-haspopup="menu"
                        aria-expanded={menu === member.userId}
                        aria-label={`${member.name} ${t(ROLE_LABELS[member.role])}`}
                        disabled={busy !== null}
                        onClick={() => setMenu(menu === member.userId ? null : member.userId)}
                      >
                        {t(ROLE_LABELS[member.role])}
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                      {menu === member.userId ? (
                        <div className={styles.inlineMenu} role="menu">
                          {(["admin", "member"] as const).map((role) => (
                            <button
                              key={role}
                              type="button"
                              role="menuitemradio"
                              aria-checked={member.role === role}
                              className={styles.menuItem}
                              onClick={() => void run(`role:${member.userId}`, async () => {
                                if (member.role !== role) await collab.setMemberRole(projectId, member.userId, role);
                                return null;
                              })}
                            >
                              {t(ROLE_LABELS[role])}
                            </button>
                          ))}
                          <div className={styles.menuSeparator} role="separator" />
                          <button
                            type="button"
                            role="menuitem"
                            className={`${styles.menuItem} ${styles.menuItemDanger}`}
                            onClick={() => {
                              setMenu(null);
                              setRemoving(member);
                            }}
                          >
                            {t("collab.members.remove")}
                          </button>
                        </div>
                      ) : null}
                    </span>
                  ) : (
                    <span className={styles.roleText}>{t(ROLE_LABELS[member.role])}</span>
                  )}
                </div>
              ))}
            </section>
          </>
        )}
      </Modal>
      <ConfirmDialog
        open={removing !== null}
        title={t("collab.members.removeTitle", { name: removing?.name ?? "" })}
        message={t("collab.members.removeMessage")}
        cancelLabel={t("collab.cancel")}
        confirmLabel={t("collab.members.remove")}
        confirmVariant="danger"
        confirmDisabled={busy !== null}
        icon={null}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const member = removing;
          setRemoving(null);
          if (member) {
            void run(`remove:${member.userId}`, async () => {
              await collab.removeMember(projectId, member.userId);
              return t("collab.members.removed", { name: member.name });
            });
          }
        }}
      />
    </>
  );
}

function MemberAvatar(props: { name: string }) {
  return (
    <span className={styles.avatar} style={{ background: memberColor(props.name) }} aria-hidden="true">
      {Array.from(props.name.trim())[0] ?? "?"}
    </span>
  );
}

/** 成员、申请与加入方式都没变时保留原对象，列表不跟着每次轮询重画。 */
function sameView(left: CollabMembers, right: CollabMembers): boolean {
  return left.canManage === right.canManage
    && left.joinMode === right.joinMode
    && left.project.memberCount === right.project.memberCount
    && fingerprint(left) === fingerprint(right);
}

function fingerprint(view: CollabMembers): string {
  const members = view.members.map((member) => `${member.userId}:${member.name}:${member.role}:${member.mine}`).join("|");
  const requests = view.requests.map((request) => `${request.userId}:${request.name}:${request.inviterName}`).join("|");
  return `${members}\n${requests}`;
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message.trim() : String(cause).trim();
  return raw.startsWith("[") || raw.startsWith("{") ? "" : raw;
}
