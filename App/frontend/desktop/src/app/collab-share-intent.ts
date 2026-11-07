/**
 * 草稿里的共享选择。新建任务在发出第一条消息之前还没有会话 id，云端无从记录，所以先记在这里：
 * 发送时把这张草稿的意图交给新会话（见 home-page 的 `onChatResolved`），再走与已有任务相同的接口。
 * 键是草稿的 scope key（`draft-<n>`），发送成功或放弃草稿后不再有意义。
 */
const intents = new Map<string, boolean>();

/** 这张草稿是否已经被勾选为共享。 */
export function shareIntentFor(scopeKey: string): boolean {
  return intents.get(scopeKey) === true;
}

/** 记下草稿的选择；关闭时删掉，避免留下一张「想共享」的空记录。 */
export function setShareIntent(scopeKey: string, shared: boolean): void {
  if (shared) intents.set(scopeKey, true);
  else intents.delete(scopeKey);
}

/** 取出并清除这张草稿的意图：会话已创建，之后由云端记录说了算。 */
export function takeShareIntent(scopeKey: string): boolean {
  const shared = intents.get(scopeKey) === true;
  intents.delete(scopeKey);
  return shared;
}

/** Test seam: drops every recorded choice. */
export function resetShareIntents(): void {
  intents.clear();
}
