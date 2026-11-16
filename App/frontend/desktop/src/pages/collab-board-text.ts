/**
 * 看板上与「人」有关的文字：任务行的摘要与提示条里的成员指代。
 *
 * 摘要的问题来自 Cursor / Codex：它们把「任务完成」这类通知当成一轮写进会话，云端早先按最后一轮存摘要，
 * 任务行于是显示成一串 `<timestamp>`、`<system_notification>` 标签。云端现在生成摘要时跳过这些轮次，
 * 这里兜住升级前上传的旧记录：识别到通知就返回空串，调用方退回标题或干脆不显示。
 */
const NOTIFICATION_TURN_PREFIXES = ["<timestamp>", "<system_notification>", "<task>"];

/** 可读的任务摘要；整条都是 Agent 通知时返回空串。 */
export function readableSummary(lastQuestion: string): string {
  const text = lastQuestion.trim();

  if (!text) return "";
  const head = text.toLowerCase();

  return NOTIFICATION_TURN_PREFIXES.some((prefix) => head.startsWith(prefix)) ? "" : text;
}

/**
 * 提示条里怎么称呼留下任务的成员：一个人就说名字，两个人并列，更多的只点第一位加人数。
 * 三个人以上不逐个列，提示条只有一行，名字长了会把「输入 @ 可引用」挤掉。
 */
export function memberNamesLabel(names: string[], language: "zh-CN" | "en-US"): string {
  const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
  const first = unique[0];

  if (!first) return "";
  if (unique.length === 1) return first;
  if (unique.length === 2) return unique.join(language === "zh-CN" ? "、" : " and ");

  return language === "zh-CN"
    ? `${first}等 ${unique.length} 位成员`
    : `${first} and ${unique.length - 1} other members`;
}
