/**
 * 任务级的共享开关：协作项目里一条 Memmy 任务是否对成员可见。只在已共享的项目里出现。
 *
 * <p>新建任务（草稿）默认开启，用户可在发送前关掉；选择先记在本机，发送第一条消息后由 home-page 交给新会话。
 * 已有任务直接读写本机接口，没有记录时按未共享显示，状态以本项目自己的 links 文件为准，所以换一台设备
 * 或换个成员看到的都是各自的选择。</p>
 */
import { Cloud, CloudOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { CollabClient } from "../api/collab-client.js";
import {
  clearSharePending,
  draftShareIntent,
  isSharePending,
  setDraftShareIntent
} from "../app/collab-share-intent.js";
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
  const [shared, setShared] = useState(() => (conversationId ? isSharePending(conversationId) : draftShareIntent(draftScopeKey)));
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  // 草稿显示自己的选择（默认开启）；已有任务读一次本机记录。刚发完第一条消息时，草稿交过来的「共享」
  // 可能还没写进本机记录，先按它显示。
  useEffect(() => {
    if (!conversationId) {
      setShared(draftShareIntent(draftScopeKey));
      setLoaded(true);
      return;
    }
    const pending = isSharePending(conversationId);
    setShared(pending);
    if (!collab) return;
    let cancelled = false;
    setLoaded(false);
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
  }, [collab, conversationId, draftScopeKey, projectId]);

  const toggle = useCallback(async () => {
    if (saving) return;
    const next = !shared;
    if (!conversationId) {
      setDraftShareIntent(draftScopeKey, next);
      setShared(next);
      return;
    }
    if (!collab) return;
    setSaving(true);
    setShared(next);
    // 用户在会话里动了开关，草稿交过来的临时状态不再需要。
    clearSharePending(conversationId);
    try {
      const state = await collab.setTaskSharing(projectId, conversationId, next);
      setShared(state.shared);
    } catch {
      setShared(!next);
      onError();
    } finally {
      setSaving(false);
    }
  }, [collab, conversationId, draftScopeKey, onError, projectId, saving, shared]);

  // 草稿还没有共享任何内容，所以不写「已共享」，开关的开合由样式表示。
  const label = shared && conversationId ? t("collab.share.shared") : t("collab.share.label");
  const hint = !shared
    ? t("collab.share.hintOff")
    : conversationId
      ? t("collab.share.hintOn")
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
