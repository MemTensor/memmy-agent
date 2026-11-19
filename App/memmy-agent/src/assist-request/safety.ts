/**
 * 成员协助：Memmy 自己作为执行方时的敏感操作检查。
 *
 * <p>外部 Agent 有「帮我批准」那一层（ACP 的 {@code session/request_permission}），Memmy 没有；
 * 这里补一个同等作用的检查：协助会话里，工具执行前按规则判断这一步是不是四类敏感操作之一，
 * 是的话拦下这一步，让模型在结果里写明要做什么、为什么。</p>
 *
 * <p>只对协助会话生效（会话元数据里有 {@code assistRequest}），普通任务完全不受影响。
 * 只有 {@code approval: "deny"} 的协助会话才拦——她在授权弹窗里点过允许的那次照常执行。</p>
 */

/** 拦下时回给模型的那句话的开头：两端按它认出「这一步按协助规则跳过了」（云端的 skipped 列表由它汇总）。 */
export const ASSIST_SKIPPED_MARKER = "按协助规则没有执行：";

/** 协助会话的批准策略：`deny` 拦下敏感操作，`allow` 不拦。 */
export type AssistApproval = "deny" | "allow";

/**
 * 工具调用所属的场景：项目目录、附件目录与临时目录里写文件不算敏感操作。
 * `exists` 由调用方给（运行时这一层能直接看磁盘），判断「覆盖已有文件」用它。
 */
export interface AssistToolContext {
  /** 本次协助所在的项目文件夹。 */
  workspace?: string | null;
  /** 额外允许写入的目录：附件目录、临时目录。 */
  allowedRoots?: readonly string[];
  /** 这个路径上已经有文件。 */
  exists?: (path: string) => boolean;
}

/** 这次工具调用属于四类敏感操作里的哪一类；不是敏感操作时返回 null。 */
export function assistSensitiveReason(
  toolName: string,
  args: Record<string, unknown>,
  context: AssistToolContext = {}
): string | null {
  const name = toolName.toLowerCase();
  if (name === "exec" || name.endsWith("bash") || name.endsWith("shell") || name === "run_command") {
    const command = readString(args, ["command", "cmd", "script"]);
    return command ? shellSensitiveReason(command) : null;
  }
  if (name === "write_file" || name === "edit_file" || name === "apply_patch" || name === "multi_edit") {
    const path = readString(args, ["path", "file_path", "filePath", "target"]);
    if (!path) return null;
    // 写一个已经存在的文件才算覆盖；新文件在项目文件夹、附件目录与临时目录里是正常的工作产物。
    const existing = args.exists === true || args.file_exists === true || context.exists?.(expandHome(path)) === true;
    if (!existing) return null;
    if (insideAllowedRoot(expandHome(path), context)) return null;
    return `覆盖已有文件 ${path}`;
  }
  if (name === "delete_file" || name === "remove_file" || name === "trash_file") {
    return `删除文件 ${readString(args, ["path", "file_path", "target"]) || ""}`.trim();
  }
  return null;
}

/** 展开 `~`：工具参数里常写成 `~/Library/...`。 */
export function expandHome(path: string): string {
  if (!path.startsWith("~")) return path;
  const home = process.env.HOME ?? "";
  return `${home}${path.slice(1)}`;
}

/** 这个路径是不是在这些目录里：项目文件夹、附件目录、临时目录。 */
function insideAllowedRoot(path: string, context: AssistToolContext): boolean {
  const roots = [context.workspace ?? "", ...(context.allowedRoots ?? [])].filter(Boolean);
  const normalized = path.replace(/\/+$/u, "");
  return roots.some((root) => {
    const base = root.replace(/\/+$/u, "");
    return normalized === base || normalized.startsWith(`${base}/`);
  });
}

/** 一条命令是不是敏感操作：管道、`&&`、`;`、`sh -c` 里的子命令都要拆开看。 */
export function shellSensitiveReason(command: string): string | null {
  for (const segment of splitCommand(command)) {
    const reason = segmentReason(segment);
    if (reason) return reason;
  }
  return null;
}

/** 拆开一条命令：按 `&&`、`||`、`;`、`|`、换行拆，`sh -c "…"` / `bash -c "…"` 里的那一段再拆一次。 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  const queue = [command];
  while (queue.length) {
    const current = queue.shift()!;
    // 去掉简单的引号包裹，方便命中 `sh -c "rm -rf x"`。
    for (const piece of current.split(/&&|\|\||[;|\n]/u)) {
      const segment = piece.trim().replace(/^["']|["']$/gu, "").trim();
      if (!segment) continue;
      parts.push(segment);
      const nested = /^(?:sudo\s+)?(?:\w+\/)?(?:sh|bash|zsh|python3?|node|perl)\s+-[a-z]*c\s+(.+)$/u.exec(segment);
      if (nested?.[1]) queue.push(nested[1].replace(/^["']|["']$/gu, ""));
      else if (/^(?:python3?|node)\s+-e\s+(.+)$/u.test(segment)) {
        const inline = /^(?:python3?|node)\s+-e\s+(.+)$/u.exec(segment)![1]!;
        queue.push(inline.replace(/^["']|["']$/gu, ""));
      }
    }
  }
  return parts;
}

/** 一条（已拆开的）子命令属于哪类敏感操作。 */
function segmentReason(segment: string): string | null {
  const text = segment.trim();
  const words = text.split(/\s+/u);
  const command = words[0]?.replace(/^.*\//u, "") ?? "";
  const rest = words.slice(1).join(" ");

  // 删除与覆盖。
  if (["rm", "rmdir", "unlink", "shred", "truncate"].includes(command)) return `删除或覆盖文件（${clip(text)}）`;
  if (command === "find" && /\s-delete\b/u.test(` ${rest}`)) return `删除或覆盖文件（${clip(text)}）`;
  if (command === "git" && /^(reset\s+--hard|clean\b)/u.test(rest)) return `删除或覆盖文件（${clip(text)}）`;
  if (command === "mv" && !/\s-[a-z]*n\b/u.test(` ${rest}`)) return `覆盖文件（${clip(text)}）`;
  if (command === "cp" && /\s-[a-z]*f\b/u.test(` ${rest}`)) return `覆盖文件（${clip(text)}）`;
  // 「> 已存在的文件」只有在调用方说明它存在时才拦：这里保守地拦住所有 `>` 重定向到非临时路径的写法。
  if (/(^|[^0-9])>{1,2}\s*\S/u.test(text) && !/^echo\b/u.test(text) && !/>\s*\/dev\/null/u.test(text)) {
    return `覆盖文件（${clip(text)}）`;
  }
  // Python 里的删除与覆盖。
  if (/shutil\.rmtree|os\.remove|os\.unlink|Path\([^)]*\)\.unlink/u.test(text)) return `删除或覆盖文件（${clip(text)}）`;

  // 读取密钥与登录凭据。
  if (CERT_PATHS.test(text)) return `读取密钥和登录凭据（${clip(text)}）`;
  if (/^security\s+find-(?:generic|internet)-password/u.test(text)) return `读取密钥和登录凭据（${clip(text)}）`;
  if (/(^|\s)(?:cat|less|more|head|tail|grep|rg|strings|open)\s[^|]*\.env\b/u.test(text)) {
    return `读取密钥和登录凭据（${clip(text)}）`;
  }

  // 对外发送。
  if (command === "git" && /^push\b/u.test(rest)) return `对外发送（${clip(text)}）`;
  if (["scp", "rsync"].includes(command) && /[^:]+:/u.test(rest)) return `对外发送（${clip(text)}）`;
  if (["curl", "wget"].includes(command) && UPLOAD_FLAGS.test(` ${rest}`)) return `对外发送（${clip(text)}）`;
  if (command === "npm" && /^publish\b/u.test(rest)) return `对外发送（${clip(text)}）`;
  if (command === "cargo" && /^publish\b/u.test(rest)) return `对外发送（${clip(text)}）`;
  if (command === "twine" && /^upload\b/u.test(rest)) return `对外发送（${clip(text)}）`;
  if (command === "gh" && /^(release|gist|pr)\b/u.test(rest)) return `对外发送（${clip(text)}）`;
  if (["mail", "mailx", "sendmail"].includes(command)) return `对外发送（${clip(text)}）`;

  // 修改系统或 Agent 的设置。
  if (command === "launchctl") return `修改系统设置（${clip(text)}）`;
  if (command === "crontab") return `修改系统设置（${clip(text)}）`;
  if (["defaults", "systemsetup", "spctl", "nvram"].includes(command)) return `修改系统设置（${clip(text)}）`;
  if (command === "npm" && /^(i|install)\s+(?:-g|--global)\b/u.test(rest)) return `全局安装（${clip(text)}）`;
  if (["brew", "port"].includes(command) && /^(install|uninstall|upgrade)\b/u.test(rest)) {
    return `安装软件（${clip(text)}）`;
  }
  if (command === "pip" || command === "pip3") {
    const install = /^install\b/u.test(rest);
    if (install && !/--user\b/u.test(rest) && !/VIRTUAL_ENV/u.test(text)) return `安装软件（${clip(text)}）`;
  }
  // 配置文件与 Agent 目录：只有真的在写它们时才算，读日志、列目录是正常的排查动作。
  if (WRITES.test(text)) {
    if (SHELL_RC.test(text)) return `修改 shell 配置（${clip(text)}）`;
    if (AGENT_CONFIG.test(text)) return `修改 Agent 或 Memmy 的设置（${clip(text)}）`;
  }
  return null;
}

/** 凭据与私钥的路径：出现在命令里的任何位置都算。 */
const CERT_PATHS = /(?:~|\$HOME)\/\.(?:ssh|aws|kube|gnupg)\b|\/\.ssh\/|(?:^|\s|["'=])\.env\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.pem\b|\/etc\/shadow\b|Library\/Keychains\b/u;

/** curl / wget 带上传或提交数据的写法。 */
const UPLOAD_FLAGS = /\s(?:-T|--upload-file|-d|--data(?:-binary|-raw|-urlencode|-ascii)?|-F|--form|-X\s*(?:POST|PUT|DELETE|PATCH)|--method\s*(?:POST|PUT|DELETE|PATCH))\b/u;

/** 这条命令会写文件：重定向、覆盖、追加、改动链接或权限。读日志、列目录不算。 */
const WRITES = /(?:^|\s)>>?\s*\S|(?:^|\s)(?:tee|cp|mv|ln|mkdir|chmod|chown|touch|rm|dd|install|patch)\b|sed\s+-i\b|perl\s+-[a-z]*i\b|python3?\s+-c\b[^\n]*open\([^)]*['"]w/u;

/** shell 的配置文件：改它们等于改这台电脑的行为。 */
const SHELL_RC = /(?:^|[\s"'=])(?:~|\$HOME)?\/?\.(?:zshrc|zprofile|bashrc|bash_profile|profile|zshenv|inputrc)\b/u;

/** 各 Agent 与 Memmy 自己的配置目录：改它们的钩子、MCP、模型设置。 */
const AGENT_CONFIG = /(?:~|\$HOME)\/\.(?:claude|codex|cursor|memmy|dsh|qoder|gemini|config)\b|\/\.config\/(?:claude|opencode|hermes)\b/u;

/** 一段命令在说明里最多留多少：一句话能读完就够。 */
function clip(value: string): string {
  const clean = value.replace(/\s+/gu, " ").trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean;
}

function readString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
