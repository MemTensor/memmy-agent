import { describe, expect, it } from "vitest";
import {
  moveOutlineItem,
  type LitrevOutlineItem
} from "../literature-review-demo-data.js";

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
