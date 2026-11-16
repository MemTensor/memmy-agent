/**
 * 草稿里的共享选择。在已共享的项目里新建任务默认共享给成员，用户可在发送前关掉。草稿在发出第一条消息之前
 * 还没有会话 id，本机后端无从记录，所以先记在这里：会话建立时由 `handOffDraftShare` 把这张草稿的选择交给
 * 新会话，再走与已有任务相同的接口。
 *
 * <p>默认只在草稿上生效。已有任务没有记录时一律按「不共享」处理（本机后端的规则），不会因为这里的默认值
 * 被改成共享；由系统新建的任务（例如「添加 Agent 支持」）不经过 `handOffDraftShare`，同样不共享。</p>
 */
import type { CollabClient } from "../api/collab-client.js";

/** 已共享项目里的新建任务默认共享给成员。 */
const DRAFT_SHARE_DEFAULT = true;

/** 草稿上的选择，键是草稿的 scope key（`draft-<n>`）。关掉也要记，否则会落回默认值。 */
const draftIntents = new Map<string, boolean>();

/**
 * 刚从草稿接手「共享」、本机记录还没写好的会话。开关在这段时间里按「已共享」显示，
 * 写入结束（成功或失败）后清掉，之后以本机记录为准。
 */
const pendingShares = new Set<string>();

/** 这张草稿当前是否共享：没动过开关时取默认值。 */
export function draftShareIntent(draftScopeKey: string): boolean {
  return draftIntents.get(draftScopeKey) ?? DRAFT_SHARE_DEFAULT;
}

/** 记下用户在草稿上的选择。 */
export function setDraftShareIntent(draftScopeKey: string, shared: boolean): void {
  draftIntents.set(draftScopeKey, shared);
}

/**
 * 取出并清除这张草稿的选择：会话已建立，之后由本机记录说了算。草稿不在已共享的项目里时，
 * 输入框旁没有开关，一律不共享。
 */
export function takeDraftShareIntent(draftScopeKey: string, inSharedProject: boolean): boolean {
  const shared = draftShareIntent(draftScopeKey);
  draftIntents.delete(draftScopeKey);
  return inSharedProject && shared;
}

/** 这条会话是否刚从草稿接手了「共享」、本机记录还在写。 */
export function isSharePending(conversationId: string): boolean {
  return pendingShares.has(conversationId);
}

/** 会话自己的共享状态已经确定（用户在会话里动过开关）：不再按草稿的选择显示。 */
export function clearSharePending(conversationId: string): void {
  pendingShares.delete(conversationId);
}

/**
 * 新会话建立时调用：按草稿的选择决定是否共享，需要共享就写入本机记录。草稿不在已共享的项目里、
 * 没有协作客户端、或用户在草稿里关掉了开关时什么都不做，返回 null。
 * 写入失败只影响这一条新任务，开关之后读本机记录会显示为未共享。
 */
export function handOffDraftShare(input: {
  collab: Pick<CollabClient, "setTaskSharing"> | null;
  /** 草稿所属项目对应的云端项目 id；本机项目、没有协作时为 null。 */
  onlineProjectId: string | null;
  draftScopeKey: string;
  chatId: string;
}): Promise<void> | null {
  const { collab, onlineProjectId, draftScopeKey, chatId } = input;
  const inSharedProject = Boolean(onlineProjectId && collab);
  if (!takeDraftShareIntent(draftScopeKey, inSharedProject) || !onlineProjectId || !collab) return null;
  pendingShares.add(chatId);
  const settle = () => {
    pendingShares.delete(chatId);
  };
  return collab.setTaskSharing(onlineProjectId, chatId, true).then(settle, settle);
}

/** Test seam: drops every recorded choice. */
export function resetShareIntents(): void {
  draftIntents.clear();
  pendingShares.clear();
}
