/**
 * 协作项目只在账号模式存在。API Key 模式（byok）是纯本机环境：这台机器上可能还留着上次登录的凭据，
 * 但云端项目、成员与共享在那里都不该出现。未选择模式或账号模式照旧，由是否登录决定能不能读。
 *
 * <p>放在一处判断：侧栏、看板、新建弹窗与后端同一口径，避免某处漏掉就漏出云端内容。</p>
 */
export function collabEnabledFor(userMode: string | undefined): boolean {
  return userMode !== "byok";
}
