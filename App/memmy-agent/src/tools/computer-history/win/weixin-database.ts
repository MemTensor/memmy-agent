import path from "node:path";

const win = path.win32;

/** Weixin 4 process name. WeChatAppEx is a plugin and is not the client. */
const WEIXIN_PROCESS = "weixin";
const ACCOUNT_DIRECTORY = /^wxid_[0-9a-z_]+$/iu;
const MESSAGE_DATABASE = /^message_\d+\.db$/iu;

export type WeixinDatabaseLookupCode = "wechat_login_required" | "current_account_ambiguous";

export class WeixinDatabaseLookupError extends Error {
  constructor(readonly code: WeixinDatabaseLookupCode) {
    super(code);
  }
}

export interface WeixinProcess {
  name: string;
  executable: string;
}

export interface WeixinAccountRoot {
  accountDirectoryName: string;
  /** Account `db_storage` directory, the same root the Mac reader uses. */
  databaseRoot: string;
}

/** Directory listing injected so the lookup can be tested without a Windows disk. */
export interface WindowsDirectoryReader {
  directories(parent: string): string[];
  files(parent: string): string[];
}

/** Strip the quotes some uninstall entries store around the install directory. */
export function normalizeWindowsPath(value: string): string {
  const trimmed = value.trim().replace(/^["']+|["']+$/gu, "").trim();
  return trimmed ? win.normalize(trimmed) : "";
}

/**
 * Prefer the running Weixin.exe. Fall back to the uninstall location only when
 * Weixin is not running. Distinct install paths are not guessed between.
 */
export function selectWeixinExecutable(processes: WeixinProcess[], uninstallLocation?: string | null): string | null {
  const executables = new Map<string, string>();
  for (const process of processes) {
    if (process.name.trim().toLowerCase() !== WEIXIN_PROCESS) continue;
    const executable = normalizeWindowsPath(process.executable);
    if (win.basename(executable).toLowerCase() !== "weixin.exe") continue;
    executables.set(executable.toLowerCase(), executable);
  }
  if (executables.size > 1) return null;
  if (executables.size === 1) return [...executables.values()][0];
  const location = uninstallLocation ? normalizeWindowsPath(uninstallLocation) : "";
  return location ? win.join(location, "Weixin.exe") : null;
}

/** Paths ending in `xwechat_files` recorded by Weixin after a custom storage move. */
export function dataRootsFromConfigText(text: string): string[] {
  const source = text.replace(/\\\\/g, "\\");
  const found = new Set<string>();
  for (const match of source.matchAll(/[A-Za-z]:\\(?:[^\\"\r\n]+\\)*xwechat_files\b/giu)) {
    const root = normalizeWindowsPath(match[0]);
    if (root) found.add(root);
  }
  return [...found];
}

export function defaultWeixinSearchRoot(documentsDirectory: string): string {
  return win.join(normalizeWindowsPath(documentsDirectory), "xwechat_files");
}

function hasNumberedMessageDatabase(reader: WindowsDirectoryReader, accountDirectory: string): boolean {
  const messageDirectory = win.join(accountDirectory, "db_storage", "message");
  return reader.files(messageDirectory).some((name) => MESSAGE_DATABASE.test(name));
}

function accountsIn(reader: WindowsDirectoryReader, root: string): WeixinAccountRoot[] {
  return reader.directories(root)
    .filter((name) => ACCOUNT_DIRECTORY.test(name))
    .map((name) => win.join(root, name))
    .filter((directory) => hasNumberedMessageDatabase(reader, directory))
    .map((directory) => ({
      accountDirectoryName: win.basename(directory),
      databaseRoot: win.join(directory, "db_storage"),
    }));
}

/**
 * Search configured storage roots first. A root may be `xwechat_files` itself
 * or a parent that contains it. The default Documents folder is used only when
 * Weixin has not recorded another location.
 */
export function findWeixinAccounts(
  reader: WindowsDirectoryReader,
  input: { documentsDirectory: string; configuredPaths?: string[] },
): WeixinAccountRoot[] {
  const configured = (input.configuredPaths ?? []).map(normalizeWindowsPath).filter(Boolean);
  const roots = configured.length > 0 ? configured : [defaultWeixinSearchRoot(input.documentsDirectory)];
  const found = new Map<string, WeixinAccountRoot>();
  for (const root of roots) {
    const containers = [root];
    if (reader.directories(root).some((name) => name.toLowerCase() === "xwechat_files")) {
      containers.push(win.join(root, "xwechat_files"));
    }
    for (const container of containers) {
      for (const account of accountsIn(reader, container)) {
        found.set(account.databaseRoot.toLowerCase(), account);
      }
    }
  }
  return [...found.values()];
}

export function selectWeixinAccount(accounts: WeixinAccountRoot[]): WeixinAccountRoot {
  if (accounts.length === 0) throw new WeixinDatabaseLookupError("wechat_login_required");
  if (accounts.length > 1) throw new WeixinDatabaseLookupError("current_account_ambiguous");
  return accounts[0];
}
