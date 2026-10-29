import fs from "node:fs";
import path from "node:path";
import type { WeChatMessageEvidence } from "./wechat-message-batch.js";
import { correlateWeChatWindowEvidence, type WeChatWindowTextEvidence } from "./wechat-message-correlation.js";

/** IDs already written anywhere in the retained unified History event stream. */
function writtenMessageIds(segmentsDirectory: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(segmentsDirectory)) return ids;
  for (const segment of fs.readdirSync(segmentsDirectory, { withFileTypes: true })) {
    if (!segment.isDirectory()) continue;
    const file = path.join(segmentsDirectory, segment.name, "events.jsonl");
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"wechat_message"')) continue;
      try {
        const event = JSON.parse(line) as { eventType?: string; details?: { messageId?: unknown } };
        if (event.eventType === "wechat_message" && typeof event.details?.messageId === "string") {
          ids.add(event.details.messageId);
        }
      } catch { /* A partially written last line is retried from the cursor. */ }
    }
  }
  return ids;
}

function visibleWeChatText(eventsFile: string): WeChatWindowTextEvidence[] {
  if (!fs.existsSync(eventsFile)) return [];
  const candidates: WeChatWindowTextEvidence[] = [];
  fs.readFileSync(eventsFile, "utf8").split("\n").forEach((line, index) => {
    if (!line.includes("com.tencent.xinWeChat") || !line.includes('"ax"')) return;
    try {
      const event = JSON.parse(line) as {
        sequence?: unknown; timestamp?: unknown;
        application?: { bundleId?: unknown }; ax?: { mode?: unknown; text?: unknown };
      };
      if (event.application?.bundleId !== "com.tencent.xinWeChat"
        || typeof event.timestamp !== "string" || typeof event.ax?.text !== "string") return;
      event.ax.text.split("\n").forEach((raw, lineIndex) => {
        if (event.ax?.mode === "diffFromPrevious" && !raw.startsWith("+ ")) return;
        const fields = (raw.startsWith("+ ") ? raw.slice(2) : raw).split("|");
        if (!["AXStaticText", "AXGroup", "AXTextArea", "AXTextField", "AXCell"].includes(fields[0])) return;
        for (const [fieldIndex, value] of [fields[2], fields[3], fields.slice(5).join("|")].entries()) {
          if (value?.trim()) candidates.push({
            observationId: `ax:${String(event.sequence ?? index)}:${lineIndex}:${fieldIndex}`,
            observedAt: event.timestamp as string,
            text: value.trim(),
          });
        }
      });
    } catch { /* Ignore interrupted JSONL writes. */ }
  });
  return candidates;
}

/**
 * Append canonical WeChat rows to the same event stream used by the normal
 * recorder. The caller acknowledges the database cursor only after this
 * function returns, so a crash replays safely across segment rotations.
 */
export function appendWeChatMessagesToHistory(
  segmentsDirectory: string,
  eventsFile: string,
  messages: WeChatMessageEvidence[],
  observedAt = new Date().toISOString(),
): number {
  if (!messages.length) return 0;
  const ids = writtenMessageIds(segmentsDirectory);
  const correlated = correlateWeChatWindowEvidence(messages, visibleWeChatText(eventsFile));
  const windowObservations = new Map(correlated.map((item) =>
    [item.message.messageId, item.windowObservationIds]));
  fs.chmodSync(path.dirname(eventsFile), 0o700);
  if (fs.existsSync(eventsFile)) fs.chmodSync(eventsFile, 0o600);
  let appended = 0;
  for (const message of messages) {
    if (ids.has(message.messageId)) continue;
    const event = {
      recordType: "human_event",
      eventType: "wechat_message",
      timestamp: observedAt,
      application: { name: "WeChat", bundleId: "com.tencent.xinWeChat" },
      details: {
        source: message.source,
        accountFingerprint: message.accountFingerprint,
        conversationId: message.conversationId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName,
        fromSelf: message.fromSelf,
        chatKind: message.chatKind,
        chatName: message.chatName,
        messageCreatedAt: message.createdAt,
        windowObservationIds: windowObservations.get(message.messageId) ?? [],
        kind: message.kind,
        text: message.text,
      },
    };
    fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    ids.add(message.messageId);
    appended += 1;
  }
  return appended;
}
