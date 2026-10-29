import type { PluginUiCall } from "./plugin-ui-context.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Use the last unanswered interaction, rather than the plugin's running state. */
export function pendingPluginInteraction(
  calls: readonly PluginUiCall[],
  answered: ReadonlySet<string> = new Set(),
): { call: PluginUiCall; type: string; cardType: string } | null {
  for (const call of [...calls].reverse()) {
    if (call.pluginId === "legal-labor" && call.capabilityId === "guide-open") continue;
    if (call.events.some((event) => event.type === "result" || event.type === "error")) continue;
    for (const event of [...call.events].reverse()) {
      if (event.type !== "interaction"
        || answered.has(`${call.pluginId}:${call.callId}:${event.request.interactionId}`)) continue;
      const payload = record(event.request.payload);
      return { call, type: event.request.type, cardType: typeof payload.cardType === "string" ? payload.cardType : "" };
    }
  }
  return null;
}

/** A submitted card is still part of the live call until the plugin reports a result. */
export function hasAnsweredUnresolvedPluginInteraction(
  calls: readonly PluginUiCall[],
  answered: ReadonlySet<string> = new Set(),
): boolean {
  return answeredUnresolvedPluginInteraction(calls, answered) !== null;
}

export function answeredUnresolvedPluginInteraction(
  calls: readonly PluginUiCall[],
  answered: ReadonlySet<string> = new Set(),
): { call: PluginUiCall; type: string; cardType: string } | null {
  const call = [...calls].reverse().find((candidate) =>
    !(candidate.pluginId === "legal-labor" && candidate.capabilityId === "guide-open") &&
    !candidate.events.some((event) => event.type === "result" || event.type === "error"));
  if (!call) return null;
  const latestInteraction = [...call.events].reverse().find((event) => event.type === "interaction");
  if (latestInteraction?.type !== "interaction"
    || !answered.has(`${call.pluginId}:${call.callId}:${latestInteraction.request.interactionId}`)) return null;
  const payload = record(latestInteraction.request.payload);
  return { call, type: latestInteraction.request.type, cardType: typeof payload.cardType === "string" ? payload.cardType : "" };
}

export function questionWaitingLabel(title: string | null | undefined, english = false): string {
  const value = title?.trim();
  if (!value) return english ? "Waiting for your answer" : "等待用户回答";
  if (english) return /^Wait(?:ing)?\b/iu.test(value) ? value : `Waiting for ${value}`;
  return /^(?:等待|待)/u.test(value) ? value : `等待${value}`;
}

function pluginInteractionTitle(call: PluginUiCall): string | null {
  const event = [...call.events].reverse().find((item) => item.type === "interaction");
  const title = event?.type === "interaction" ? record(event.request.payload).title : null;
  return typeof title === "string" && title.trim() ? title.trim() : null;
}

/** The transcript and sidebar describe the same pending action at different lengths. */
export function pluginInteractionWaitingLabel(
  pending: NonNullable<ReturnType<typeof pendingPluginInteraction>>,
  english = false,
  compact = false,
): string {
  if (pending.call.pluginId === "literature-review") {
    const labels: Record<string, [string, string, string, string]> = {
      "review-spec": ["等待确认研究需求", "待确认需求", "Waiting to confirm research requirements", "Confirm requirements"],
      "source-import": ["等待用户补充文献", "待补充文献", "Waiting for local literature", "Add literature"],
      keywords: ["等待确认检索关键词", "待确认关键词", "Waiting to confirm search keywords", "Confirm keywords"],
      "paper-selection": ["等待筛选参考文献", "待筛选文献", "Waiting to select references", "Select references"],
      "fulltext-recovery": ["等待补充文献全文", "待补充全文", "Waiting for full-text documents", "Add full texts"],
      outline: ["等待确认综述大纲", "待确认大纲", "Waiting to confirm review outline", "Confirm outline"],
    };
    const label = labels[pending.cardType];
    if (label) return label[english ? (compact ? 3 : 2) : (compact ? 1 : 0)];
  }
  const title = pluginInteractionTitle(pending.call);
  if (title) {
    return compact ? english ? `Await ${title}` : `待${title}`
      : questionWaitingLabel(title, english);
  }
  const fallback: Record<string, [string, string, string, string]> = {
    "file-input": ["等待上传文件", "待上传文件", "Waiting for file upload", "Upload files"],
    question: ["等待用户回答", "待用户回答", "Waiting for your answer", "Answer question"],
    approval: ["等待确认操作", "待你确认", "Waiting for your approval", "Confirm action"],
    "audio-record": ["等待录音", "待录音", "Waiting for recording", "Record audio"],
    custom: ["等待完成卡片操作", "待完成操作", "Waiting for card action", "Complete action"],
  };
  const label = fallback[pending.type] ?? ["等待你的操作", "待你操作", "Waiting for your action", "Action needed"];
  return label[english ? (compact ? 3 : 2) : (compact ? 1 : 0)];
}

/** A submitted card keeps its process action, without the live waiting prefix. */
export function reviewInteractionCompletedLabel(cardType: string, english = false): string | null {
  const review: Record<string, [string, string]> = {
    "review-spec": ["确认研究需求", "Confirm research requirements"],
    "source-import": ["用户补充文献", "Add local literature"],
    keywords: ["确认检索关键词", "Confirm search keywords"],
    "paper-selection": ["筛选参考文献", "Select papers"],
    "fulltext-recovery": ["补充文献全文", "Add full texts"],
    outline: ["确认综述大纲", "Confirm review outline"]
  };
  const known = review[cardType];
  return known ? known[english ? 1 : 0] : null;
}

export function pluginInteractionCompletedLabel(
  interaction: { call: PluginUiCall; type: string; cardType: string }, english = false,
): string {
  const known = interaction.call.pluginId === "literature-review"
    ? reviewInteractionCompletedLabel(interaction.cardType, english) : null;
  if (known) return known;
  if (interaction.type === "question") return english ? "Asked the user" : "向用户提问";
  if (interaction.type === "file-input") return english ? "Uploaded files" : "用户上传文件";
  return pluginInteractionTitle(interaction.call) ?? (english ? "Completed card action" : "已完成卡片操作");
}
