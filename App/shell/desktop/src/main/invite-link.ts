/**
 * 邀请链接：浏览器打开 {cloud}/api/i/{code} 后，落地页用 `memmy://invite/<code>` 唤起桌面端，
 * 桌面端据此弹出「加入项目」并带好邀请码。
 *
 * <p>解析放在这里而不是 main.ts：一条链接可能来自 macOS 的 open-url、Windows 的 second-instance
 * 命令行，也可能在冷启动时就在 argv 里，三处都要用同一套规则，而且都要能单独测。</p>
 *
 * <p>只认 `invite/<code>` 一条路径：以后要加别的深链接，各自加一条规则，不要把整段 URL 透给渲染层。</p>
 */

/** 与 electron-builder 里声明的协议一致；渲染层内部用的 `memmy://prod.app` 只是分析用的地址，不会进这里。 */
export const INVITE_LINK_SCHEME = "memmy";

/** 主进程 → 渲染层：收到了一个邀请链接。 */
export const INVITE_LINK_CHANNEL = "memmy:open-invite";

/** 渲染层取走启动前就排队的邀请（冷启动时 open-url / argv 比界面先到）。 */
export const TAKE_INVITE_LINKS_CHANNEL = "memmy:take-invite-links";

/** 与云端 CollabService.INVITE_CODE 一致：16–32 位 base64url 字符。 */
const INVITE_CODE = /^[A-Za-z0-9_-]{16,32}$/u;

/**
 * 从一条深链接里取出邀请码。
 *
 * <p>接受 `memmy://invite/<code>`、`memmy:///invite/<code>` 与末尾带斜杠的写法；大小写不敏感。
 * 路径不对、邀请码格式不对都返回 null，调用方据此忽略，不把任意内容传给界面。</p>
 *
 * @param value 原始链接，来自命令行参数或 open-url。
 * @returns 合法的邀请码，或 null。
 */
export function parseInviteLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(`${INVITE_LINK_SCHEME}:`)) return null;
  const rest = trimmed.slice(INVITE_LINK_SCHEME.length + 1).replace(/^\/+/u, "");
  const match = /^invite\/([^/?#]+)\/?$/iu.exec(rest);
  if (!match) return null;
  const code = match[1] ?? "";
  return INVITE_CODE.test(code) ? code : null;
}

/**
 * 在一串命令行参数里找第一个邀请链接。
 *
 * <p>Windows 与 Linux 把链接作为参数交给第二个实例，冷启动时则混在自身的 argv 里；顺序不固定，
 * 所以逐个试，找到第一个合法的就用。</p>
 *
 * @param argv 进程或 second-instance 给出的参数。
 * @returns 邀请码，或 null。
 */
export function findInviteLink(argv: readonly string[] | undefined | null): string | null {
  if (!argv) return null;
  for (const argument of argv) {
    const code = parseInviteLink(argument);
    if (code) return code;
  }
  return null;
}
