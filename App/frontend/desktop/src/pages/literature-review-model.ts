/**
 * Frontend-only contracts for launching and editing a literature review.
 *
 * This module intentionally contains no sample research content. Backend-owned
 * keywords, outlines, references, task progress, and artifacts start empty in
 * the UI and can be populated by the real research workflow later.
 */

import type { MessageKey } from "../i18n/messages.js";

export const LITREV_PROMPT_STORAGE_KEY = "memmy.literatureReview.prompt";
export const LITREV_SOURCE_INPUT_STORAGE_KEY = "memmy.literatureReview.sourceInput";
export const LITREV_CONTEXT_STORAGE_KEY = "memmy.literatureReview.contexts";
export const LITREV_PROJECT_CONTEXT_STORAGE_KEY = "memmy.literatureReview.projectId";

export interface LitrevLaunchContext {
  kind: "path";
  id: string;
  label: string;
  fileCount?: number;
  totalBytes?: number;
}

export type LitrevQuestionId = "field" | "time";

export interface LitrevSetupOption {
  id: string;
  labelKey: MessageKey;
}

export interface LitrevSetupQuestion {
  id: LitrevQuestionId;
  labelKey: MessageKey;
  options: readonly LitrevSetupOption[];
}

/** Product-defined scope choices. The page deliberately starts with no selected answer. */
export const LITREV_SETUP_QUESTIONS: readonly LitrevSetupQuestion[] = [
  {
    id: "field",
    labelKey: "literatureReview.questions.field.label",
    options: [
      { id: "ai-computer-science", labelKey: "literatureReview.questions.field.aiComputerScience" },
      { id: "finance-economics", labelKey: "literatureReview.questions.field.financeEconomics" },
      { id: "medicine-life-sciences", labelKey: "literatureReview.questions.field.medicineLifeSciences" },
      { id: "social-sciences", labelKey: "literatureReview.questions.field.socialSciences" }
    ]
  },
  {
    id: "time",
    labelKey: "literatureReview.questions.time.label",
    options: [
      { id: "last-3-years", labelKey: "literatureReview.questions.time.last3Years" },
      { id: "last-5-years", labelKey: "literatureReview.questions.time.last5Years" },
      { id: "last-10-years", labelKey: "literatureReview.questions.time.last10Years" },
      { id: "no-limit", labelKey: "literatureReview.questions.time.noLimit" }
    ]
  }
];

export interface LitrevKeyword {
  id: string;
  text: string;
  weight: number;
  selected: boolean;
}

export interface LitrevOutlineItem {
  id: string;
  text: string;
  level: 0 | 1;
}

export interface LitrevReference {
  id: string;
  title: string;
  meta: string;
  source: "web" | "local";
  selected: boolean;
}

/**
 * Reorders an outline entry and applies its requested hierarchy level.
 * Top-level entries carry their existing level-two children when reordered.
 */
export function moveOutlineItem(
  items: LitrevOutlineItem[],
  fromIndex: number,
  targetIndex: number,
  requestedLevel: 0 | 1
): LitrevOutlineItem[] {
  if (!items[fromIndex] || !items[targetIndex]) return items;
  const source = items[fromIndex]!;
  let blockEnd = fromIndex + 1;
  if (source.level === 0) {
    while (blockEnd < items.length && items[blockEnd]?.level === 1) blockEnd += 1;
  }
  const block = items.slice(fromIndex, blockEnd);
  const targetInsideBlock = targetIndex >= fromIndex && targetIndex < blockEnd;
  const remaining = [
    ...items.slice(0, fromIndex),
    ...items.slice(blockEnd)
  ];
  const insertIndex = targetInsideBlock
    ? fromIndex
    : fromIndex < targetIndex
      ? targetIndex - block.length + 1
      : targetIndex;
  const safeInsertIndex = Math.max(0, Math.min(insertIndex, remaining.length));
  const hasParentBefore = remaining
    .slice(0, safeInsertIndex)
    .some((item) => item.level === 0);
  const level: 0 | 1 = requestedLevel === 1 && hasParentBefore ? 1 : 0;
  const movedBlock = [{ ...block[0]!, level }, ...block.slice(1)];
  return [
    ...remaining.slice(0, safeInsertIndex),
    ...movedBlock,
    ...remaining.slice(safeInsertIndex)
  ];
}
