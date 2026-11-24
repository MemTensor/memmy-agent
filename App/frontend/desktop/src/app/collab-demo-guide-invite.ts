/**
 * 小饭团演示的收尾请求：完成弹窗里点「邀请同事」时，看板要打开成员弹窗。
 * 与看板之间只传一个一次性请求，看板读完即清掉。
 */
let pending = false;
const listeners = new Set<() => void>();

export function requestDemoGuideInvite(): void {
  pending = true;
  for (const listener of listeners) listener();
}

export function consumeDemoGuideInvite(): void {
  if (!pending) return;
  pending = false;
  for (const listener of listeners) listener();
}

export function demoGuideInvitePending(): boolean {
  return pending;
}

export function subscribeDemoGuideInvite(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetDemoGuideInvite(): void {
  pending = false;
  listeners.clear();
}
