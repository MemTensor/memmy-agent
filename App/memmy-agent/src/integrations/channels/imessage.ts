import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { BaseChannel } from "./base.js";

/** Imessage module. */
const defaultRunCommand: CommandRunner = async (file, args) => {
  const { execFile } = await import("node:child_process");
  return promisify(execFile)(file, args);
};

/** Type definition for command runner. */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string }>;

export class IMessageConfig {
  enabled = false;
  allowFrom: string[] = [];
  dbPath = "";
  pollIntervalMs = 2000;

  constructor(init: Partial<IMessageConfig> = {}) {
    this.enabled = init.enabled ?? this.enabled;
    this.allowFrom = init.allowFrom ?? [];
    this.dbPath = init.dbPath ?? "";
    const interval = init.pollIntervalMs ?? 2000;
    this.pollIntervalMs = interval > 0 ? interval : 2000;
  }
}

/** Definition for send script. */
export const SEND_SCRIPT = [
  "on run {targetHandle, messageText}",
  '  tell application "Messages"',
  "    set targetService to 1st account whose service type = iMessage",
  "    set targetBuddy to participant targetHandle of targetService",
  "    send messageText to targetBuddy",
  "  end tell",
  "end run",
].join("\n");

export class IMessageChannel extends BaseChannel {
  override name = "imessage";
  override displayName = "iMessage";
  override config: IMessageConfig;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private runCommand: CommandRunner;

  static override defaultConfig(): Record<string, any> {
    return new IMessageConfig() as any;
  }

  constructor(
    config: Partial<IMessageConfig> = {},
    bus?: any,
    options: { runCommand?: CommandRunner } = {},
  ) {
    const cfg = config instanceof IMessageConfig ? config : new IMessageConfig(config);
    super("imessage", cfg, bus);
    this.config = cfg;
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  private resolveDbPath(): string {
    return this.config.dbPath || path.join(os.homedir(), "Library", "Messages", "chat.db");
  }

  private async querySqlite(sql: string): Promise<any[]> {
    const { stdout } = await this.runCommand("sqlite3", [
      "-readonly",
      "-json",
      this.resolveDbPath(),
      sql,
    ]);
    const trimmed = String(stdout ?? "").trim();
    return trimmed ? JSON.parse(trimmed) : [];
  }

  private async readMaxRowId(): Promise<number> {
    const rows = await this.querySqlite("SELECT MAX(ROWID) AS maxId FROM message");
    return Number(rows[0]?.maxId ?? 0);
  }

  async start(): Promise<void> {
    try {
      this.lastRowId = await this.readMaxRowId();
      this.lastError = null;
      this.running = true;
      this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
      this.timer.unref?.();
    } catch (err) {
      this.recordPermissionError(err);
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async poll(): Promise<void> {
    try {
      const rows = await this.querySqlite(
        "SELECT message.ROWID AS rowid, message.text AS text, handle.id AS handle " +
          "FROM message JOIN handle ON message.handle_id = handle.ROWID " +
          `WHERE message.ROWID > ${this.lastRowId} AND message.is_from_me = 0 AND message.text IS NOT NULL ` +
          "ORDER BY message.ROWID",
      );
      for (const row of rows) {
        this.lastRowId = Math.max(this.lastRowId, Number(row.rowid));
        const handle = String(row.handle ?? "");
        const text = String(row.text ?? "");
        if (!handle || !text) continue;
        await this.handleMessage({ senderId: handle, chatId: handle, content: text, isDm: true });
      }
      this.lastError = null;
    } catch (err) {
      this.recordPermissionError(err);
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    const handle = String(msg.chatId ?? "");
    if (!handle || !msg.content) return;
    try {
      await this.runCommand("osascript", ["-e", SEND_SCRIPT, handle, msg.content]);
    } catch (err) {
      this.recordPermissionError(err);
      throw err;
    }
  }

  override permissionErrorHint(error: unknown): string | null {
    const text = String((error as any)?.stderr ?? (error as any)?.message ?? error ?? "");
    if (
      /CANTOPEN|unable to open database|not permitted|EPERM|authorization denied|full disk/i.test(
        text,
      )
    ) {
      return "iMessage 需要「完全磁盘访问」权限：系统设置 › 隐私与安全性 › 完全磁盘访问，勾选本应用后重试。";
    }
    if (/-1743|not authoriz|Automation|自动化/i.test(text)) {
      return "iMessage 发送需要「自动化」权限：系统设置 › 隐私与安全性 › 自动化，允许本应用控制「信息」。";
    }
    return null;
  }
}
