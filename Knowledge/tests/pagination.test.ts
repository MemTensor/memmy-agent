import { expect, it } from "vitest";
import { visiblePages } from "../src/ui/pagination.js";

it("shows every page when the range is short", () => {
  expect(visiblePages(1, 4)).toEqual([1, 2, 3, 4]);
});

it("keeps the first and last pages with a gap in the middle", () => {
  expect(visiblePages(1, 62)).toEqual([1, 2, 3, 4, "gap", 61, 62]);
  expect(visiblePages(30, 62)).toEqual([1, 2, "gap", 29, 30, 31, "gap", 61, 62]);
  expect(visiblePages(62, 62)).toEqual([1, 2, "gap", 59, 60, 61, 62]);
});
