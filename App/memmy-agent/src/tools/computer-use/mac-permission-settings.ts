import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMemmyComputerUseServer } from "../../config/computer-use-server.js";

const execFileAsync = promisify(execFile);
export type MacPermission = "accessibility" | "inputMonitoring" | "screenRecording";
const PANELS: Record<MacPermission, string> = {
  accessibility: "Privacy_Accessibility",
  inputMonitoring: "Privacy_ListenEvent",
  screenRecording: "Privacy_ScreenCapture",
};

/** Only recognize native permission errors, never arbitrary page/AX text. */
export function computerUsePermissionError(serverName: string, result: any): MacPermission | null {
  if (!isMemmyComputerUseServer(serverName) || result?.isError !== true) return null;
  for (const item of result.content ?? []) {
    if (item?.type !== "text" || typeof item.text !== "string") continue;
    const text = item.text.trim();
    if (text.startsWith("Accessibility permission is required.")) return "accessibility";
    if (/^(Screen Recording|Screen Capture) permission is required\./.test(text)) return "screenRecording";
  }
  return null;
}

/** The recorder emits this prefix only after checking its own native identity. */
export function computerHistoryPermissionError(message: string): MacPermission | null {
  // A grant can be revoked between the initial probe and creation of the
  // in-app event tap. Recognize only the recorder's own prefixed failure.
  if (/(?:^|\n)human history recording failed: (?:Input Monitoring permission is required for Memmy Computer Use\.|Unable to create the event tap\.)/.test(message)) {
    return "inputMonitoring";
  }
  const match = message.match(/(?:^|\n)human history recording failed: missing macOS permission: ([^.]+)\./);
  if (!match) return null;
  const missing = match[1].split(", ").map((name) => name.trim());
  if (missing.includes("Accessibility")) return "accessibility";
  if (missing.includes("Input Monitoring")) return "inputMonitoring";
  if (missing.includes("Screen Recording")) return "screenRecording";
  return null;
}

/** One automatic jump per feature/permission per process; failed opens can retry. */
export class MacPermissionSettingsGuide {
  private readonly pending = new Map<string, Promise<boolean>>();
  constructor(
    private readonly platform: string = process.platform,
    private readonly open: (url: string) => Promise<void> = async (url) => {
      await execFileAsync("/usr/bin/open", [url], { timeout: 5000 });
    },
  ) {}

  async show(source: "computer-use" | "computer-history", permission: MacPermission, userRequested = false): Promise<boolean> {
    if (this.platform !== "darwin") return false;
    const key = `${source}:${permission}`;
    const existing = userRequested ? undefined : this.pending.get(key);
    if (existing) return existing;
    const pending = Promise.resolve()
      .then(() => this.open(`x-apple.systempreferences:com.apple.preference.security?${PANELS[permission]}`))
      .then(() => true)
      .catch(() => { this.pending.delete(key); return false; });
    this.pending.set(key, pending);
    return pending;
  }
}

export const macPermissionSettingsGuide = new MacPermissionSettingsGuide();
