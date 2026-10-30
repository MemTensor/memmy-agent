import type { HistoryEvent } from "../core/recording.js";
import type { HistoryContentQuality } from "../core/platform-driver.js";

/** Last persisted sample quality; absence of events or excluded content is not a failure. */
export function contentQuality(event: HistoryEvent): HistoryContentQuality | undefined {
  if (!event.accessibility?.nodes.length) return undefined;
  const nodes = event.accessibility.nodes.filter(node => !node.redaction);
  const text = nodes.some(node => node.documentStatus === "available" && (!!node.text?.trim() || !!node.visibleText?.trim())
    || !!node.value?.trim() && (node.valueSource !== "msaa.name" || ["Text", "Document"].includes(node.controlType))
    || event.details?.browser === true && ["Text", "Hyperlink"].includes(node.controlType) && !!node.name?.trim());
  if (event.accessibility.truncated) return { timestamp: event.timestamp, status: "partial", reason: "budget_exceeded" };
  if (text) return { timestamp: event.timestamp, status: "available", reason: "text_read" };
  if (event.accessibility.nodes.some(node => node.documentStatus === "read_failed")) return { timestamp: event.timestamp, status: "unavailable", reason: "read_failed" };
  if (nodes.some(node => node.name?.trim() || node.valueSource === "msaa.name" && node.value?.trim())) return { timestamp: event.timestamp, status: "partial", reason: "labels_only" };
  return undefined;
}
