export const WECHAT_PERMISSION_RETURN_KEY = "memmy.computerHistory.wechatPermissionReturn";
const RETURN_MAX_AGE_MS = 24 * 60 * 60_000;

type PermissionReturn = { sessionId: string | null; createdAt: number };

/** This remembers a settings destination, never permission or WeChat consent. */
export function readWeChatPermissionReturn(): PermissionReturn | null {
  try {
    const raw = window.localStorage.getItem(WECHAT_PERMISSION_RETURN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const age = Date.now() - value?.createdAt;
    if (typeof value?.createdAt !== "number" || age < 0 || age > RETURN_MAX_AGE_MS) {
      clearWeChatPermissionReturn();
      return null;
    }
    return { createdAt: value.createdAt, sessionId: typeof value.sessionId === "string" ? value.sessionId : null };
  } catch { return null; }
}

export function clearWeChatPermissionReturn(): void {
  try { window.localStorage.removeItem(WECHAT_PERMISSION_RETURN_KEY); } catch { /* Optional navigation restore. */ }
}

export async function rememberWeChatPermissionReturn(isActive: () => boolean = () => true): Promise<void> {
  const sessionId = await window.memmy?.getComputerHistoryPermissionSessionId?.().catch(() => null) ?? null;
  if (!isActive()) return;
  try {
    window.localStorage.setItem(WECHAT_PERMISSION_RETURN_KEY, JSON.stringify({ sessionId, createdAt: Date.now() }));
  } catch { /* The guide explains the manual return path when storage is unavailable. */ }
}

export async function shouldReturnToWeChatSettings(): Promise<boolean> {
  const pending = readWeChatPermissionReturn();
  if (!pending) return false;
  const sessionId = await window.memmy?.getComputerHistoryPermissionSessionId?.().catch(() => null) ?? null;
  return !sessionId || !pending.sessionId || pending.sessionId !== sessionId;
}
