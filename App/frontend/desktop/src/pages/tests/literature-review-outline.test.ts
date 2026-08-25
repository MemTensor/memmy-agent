import { describe, expect, it } from "vitest";
import {
  LITREV_CONTEXT_STORAGE_KEY,
  LITREV_PROJECT_CONTEXT_STORAGE_KEY,
  LITREV_PROMPT_STORAGE_KEY,
  LITREV_SETUP_QUESTIONS,
  LITREV_SOURCE_INPUT_STORAGE_KEY,
  moveOutlineItem,
  type LitrevOutlineItem
} from "../literature-review-model.js";

const outline: LitrevOutlineItem[] = [
  { id: "a", text: "A", level: 0 },
  { id: "a-1", text: "A.1", level: 1 },
  { id: "b", text: "B", level: 0 },
  { id: "c", text: "C", level: 0 }
];

describe("literature review outline hierarchy", () => {
  it("changes hierarchy even when dropped at the same position", () => {
    const moved = moveOutlineItem(outline, 2, 2, 1);

    expect(moved.map((item) => [item.id, item.level])).toEqual([
      ["a", 0],
      ["a-1", 1],
      ["b", 1],
      ["c", 0]
    ]);
  });

  it("promotes a level-two item when dropped at the same position", () => {
    const moved = moveOutlineItem(outline, 1, 1, 0);

    expect(moved.map((item) => [item.id, item.level])).toEqual([
      ["a", 0],
      ["a-1", 0],
      ["b", 0],
      ["c", 0]
    ]);
  });

  it("prevents an orphan level-two item at the beginning", () => {
    const moved = moveOutlineItem(outline, 2, 0, 1);

    expect(moved[0]).toMatchObject({ id: "b", level: 0 });
  });

  it("moves existing children together with their level-one parent", () => {
    const moved = moveOutlineItem(outline, 0, 3, 0);

    expect(moved.map((item) => item.id)).toEqual(["b", "c", "a", "a-1"]);
    expect(moved.at(-1)?.level).toBe(1);
  });
});

describe("literature review frontend model", () => {
  it("keeps the original two scope cards and their choices without a default answer", () => {
    expect(LITREV_SETUP_QUESTIONS.map((question) => question.id)).toEqual(["field", "time"]);
    expect(LITREV_SETUP_QUESTIONS.map((question) => question.options.length)).toEqual([4, 4]);
    expect(LITREV_SETUP_QUESTIONS.every((question) => !("answer" in question) && !("defaultAnswer" in question))).toBe(true);
  });

  it("exports stable non-demo launch storage keys", () => {
    expect([
      LITREV_PROMPT_STORAGE_KEY,
      LITREV_SOURCE_INPUT_STORAGE_KEY,
      LITREV_CONTEXT_STORAGE_KEY,
      LITREV_PROJECT_CONTEXT_STORAGE_KEY
    ]).toEqual([
      "memmy.literatureReview.prompt",
      "memmy.literatureReview.sourceInput",
      "memmy.literatureReview.contexts",
      "memmy.literatureReview.projectId"
    ]);
  });
});
