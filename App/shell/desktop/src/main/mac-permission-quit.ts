/** The original macOS Apple event, read synchronously before quit cleanup. */
export interface MacPermissionQuitContext {
  eventClass: string;
  eventId: string;
  senderBundleId: string | null;
  senderExecutablePath: string | null;
  quitReason: string | null;
}

const SYSTEM_SETTINGS_EXECUTABLES = new Set([
  "/System/Applications/System Settings.app/Contents/MacOS/System Settings",
  "/System/Applications/System Preferences.app/Contents/MacOS/System Preferences",
]);
const PRIVACY_SETTINGS_EXECUTABLE = "/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/MacOS/SecurityPrivacyExtension";

/** Recognizes only a permission-panel quit, preserving ordinary and system exits. */
export function isMacPermissionSystemQuit(context: MacPermissionQuitContext | null | undefined,
  request: { permissionRequested?: boolean; systemSessionEnding?: boolean } = {}): boolean {
  if (!context || context.eventClass !== "aevt" || context.eventId !== "quit"
    || request.systemSessionEnding || !context.senderExecutablePath) {
    return false;
  }
  // Privacy & Security uses rlgo for permission Quit & Reopen too. Only a
  // recent, host-owned permission request can disambiguate that request.
  if (context.quitReason !== null
    && !(context.quitReason === "rlgo" && request.permissionRequested === true
      && request.systemSessionEnding === false)) return false;
  if (context.senderBundleId === "com.apple.systempreferences") {
    return SYSTEM_SETTINGS_EXECUTABLES.has(context.senderExecutablePath);
  }
  return context.senderBundleId === "com.apple.settings.PrivacySecurity.extension"
    && context.senderExecutablePath === PRIVACY_SETTINGS_EXECUTABLE;
}

/** System termination must also veto the activate-during-cleanup fallback. */
export function isMacSystemSessionQuit(context: MacPermissionQuitContext | null | undefined): boolean {
  return Boolean(context?.eventClass === "aevt" && context.eventId === "quit"
    && ["rest", "shut", "logo", "rlgo", "quia"].includes(context.quitReason ?? ""));
}

/** In-memory, one-use intents; one guide cannot cancel another permission panel. */
export class MacPermissionRestartIntent {
  private sequence = 0;
  private current = new Map<number, { beganAt: number; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  begin(): number {
    const beganAt = this.now();
    for (const [token, request] of this.current) {
      if (beganAt > request.expiresAt) this.current.delete(token);
    }
    const token = ++this.sequence;
    this.current.set(token, { beganAt, expiresAt: beganAt + 5 * 60_000 });
    return token;
  }

  finish(token: number, approved: boolean): void {
    const request = this.current.get(token);
    if (!request) return;
    if (!approved) { this.current.delete(token); return; }
    request.expiresAt = Math.min(request.expiresAt, this.now() + 30_000);
  }

  consume(): boolean {
    const now = this.now();
    const valid = [...this.current.values()].some(request => now >= request.beganAt && now <= request.expiresAt);
    this.current.clear();
    return valid;
  }
}

/** Only the permission panels opened by Memmy's own settings controls qualify. */
export const MACOS_PERMISSION_SETTINGS_DEEPLINKS = new Set([
  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
]);

/** Register before opening Settings, so a fast Quit & Reopen cannot race the IPC reply. */
export async function openMacPermissionSettingsFromRenderer(
  rawUrl: string,
  senderIsMainWindow: boolean,
  openExternal: (url: string) => Promise<unknown>,
  intent: MacPermissionRestartIntent,
): Promise<boolean> {
  const url = rawUrl.trim();
  if (!MACOS_PERMISSION_SETTINGS_DEEPLINKS.has(url)) return false;
  if (!senderIsMainWindow) throw new Error("Invalid permission settings request");
  const token = intent.begin();
  try { await openExternal(url); }
  catch (error) { intent.finish(token, false); throw error; }
  return true;
}
