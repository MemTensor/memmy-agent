/**
 * 任务级的共享开关：协作项目里一条 Memmy 任务是否对成员可见。默认关闭，打开才上传。
 *
 * <p>草稿（还没有会话 id）先记在本机，发送第一条消息后由 home-page 交给新会话；已有任务直接读写本机接口，
 * 状态以本项目自己的 links 文件为准，所以换一台设备或换个成员看到的都是各自的选择。</p>
 */
import { Cloud, CloudOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CollabClient } from "../api/collab-client.js";
import { shareIntentFor, setShareIntent } from "../app/collab-share-intent.js";
import { useTranslation } from "../i18n/use-translation.js";

export type CollabShareToggleProps = {
  collab: CollabClient | null;
  /** 云端项目 id。 */
  projectId: string;
  /** 当前会话 id；草稿为 null，此时只在发送后生效。 */
  conversationId: string | null;
  /** 草稿的 scope key，用来记住发送前的选择。 */
  draftScopeKey: string;
  /** 保存失败时通知页面；文案由页面按语言取。 */
  onError: () => void;
};

export function CollabShareToggle(props: CollabShareToggleProps) {
  const { t } = useTranslation();
  const { collab, projectId, conversationId, draftScopeKey, onError } = props;
  /** 会话存在后，会话 id 本身就是这张草稿的 scope key。 */
  const scopeKey = conversationId ?? draftScopeKey;
  const [shared, setShared] = useState(() => shareIntentFor(scopeKey));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // 已有任务读一次本机记录；刚发完第一条消息时，草稿里的选择还在 store 里，先按它显示。
  useEffect(() => {
    setShared(shareIntentFor(scopeKey));
    if (!conversationId) {
      setLoaded(true);
      return;
    }
    if (!collab) return;
    let cancelled = false;
    setLoaded(false);
    const pending = shareIntentFor(scopeKey);
    collab.taskSharing(projectId, conversationId)
      .then((state) => {
        if (cancelled) return;
        setShared(pending || state.shared);
        setLoaded(true);
      })
      .catch(() => {
        // 读不到就按「未共享」显示：开关仍可点，写成功后再以返回值纠正。
        if (cancelled) return;
        setShared(pending);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [collab, conversationId, projectId, scopeKey]);

  const toggle = useCallback(async () => {
    if (saving) return;
    const next = !shared;
    if (!conversationId) {
      setShareIntent(scopeKey, next);
      setShared(next);
      return;
    }
    if (!collab) return;
    setSaving(true);
    setShared(next);
    try {
      const state = await collab.setTaskSharing(projectId, conversationId, next);
      // 云端（本机 links）已经记下了，草稿期的临时选择不再需要。
      setShareIntent(scopeKey, false);
      setShared(state.shared);
    } catch {
      setShareIntent(scopeKey, false);
      setShared(!next);
      onError();
    } finally {
      setSaving(false);
    }
  }, [collab, conversationId, onError, projectId, saving, scopeKey, shared]);

  const label = shared ? t("collab.share.shared") : t("collab.share.label");
  const hint = shared
    ? t("collab.share.hintOn")
    : conversationId
      ? t("collab.share.hintOff")
      : t("collab.share.hintDraft");

  return (
    <button
      type="button"
      role="switch"
      aria-checked={shared}
      aria-label={label}
      title={hint}
      disabled={saving || (Boolean(conversationId) && !loaded)}
      onClick={() => void toggle()}
      className={`composer-share-chip${shared ? " composer-share-chip--on" : ""}`}
    >
      {shared ? <Cloud size={13} strokeWidth={1.9} aria-hidden="true" /> : <CloudOff size={13} strokeWidth={1.9} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
