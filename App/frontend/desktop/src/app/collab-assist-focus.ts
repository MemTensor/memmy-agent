/**
 * 打开看板上的某一次协助：执行方在授权弹窗里选了外部 Agent、或从通知点开时，应用切到那个项目的看板，
 * 并在右侧展开这次协助的详情。
 *
 * 与 `collab-projects-store` 的 `tourFor` 同一个做法：写入方只记一个请求，看板读到后消费掉，
 * 不会因为之后再打开看板又弹一次。
 */
type Listener = () => void;

export interface AssistFocus {
  /** 云端项目 id：看板按它判断请求是不是属于当前项目。 */
  projectId: string;
  threadId: string;
}

let focus: AssistFocus | null = null;
const listeners = new Set<Listener>();

export function subscribeAssistFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getAssistFocus(): AssistFocus | null {
  return focus;
}

export function requestAssistFocus(next: AssistFocus): void {
  focus = next;
  for (const listener of listeners) listener();
}

export function consumeAssistFocus(): void {
  if (!focus) return;
  focus = null;
  for (const listener of listeners) listener();
}
