export const HISTORY_PERMISSION_SETUP_KEY = "memmy.computerHistory.permissionSetup";
type SetupAction = "start" | "resume";
type PermissionSetup = { action: SetupAction; sessionId: string | null };

export function readHistoryPermissionIntent(): PermissionSetup | null {
  try {
    const raw = window.localStorage.getItem(HISTORY_PERMISSION_SETUP_KEY);
    if (raw === "start" || raw === "resume") return { action: raw, sessionId: null };
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (value?.action !== "start" && value?.action !== "resume") return null;
    return { action: value.action, sessionId: typeof value.sessionId === "string" ? value.sessionId : null };
  } catch { return null; }
}

export function readHistoryPermissionSetup(): SetupAction | null {
  return readHistoryPermissionIntent()?.action ?? null;
}

/** Remember the user's enable intent and app process, never a permission grant. */
export function saveHistoryPermissionSetup(action: SetupAction | null, sessionId?: string): void {
  try {
    if (action) window.localStorage.setItem(HISTORY_PERMISSION_SETUP_KEY, JSON.stringify({
      action, sessionId: sessionId ?? readHistoryPermissionIntent()?.sessionId ?? null,
    }));
    else window.localStorage.removeItem(HISTORY_PERMISSION_SETUP_KEY);
  } catch { /* The in-memory guide still works when storage is unavailable. */ }
}
