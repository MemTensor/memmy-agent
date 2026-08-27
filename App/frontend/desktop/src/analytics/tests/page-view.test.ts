import { describe, expect, it } from "vitest";
import {
  buildMemorySubPageViewEvent,
  buildRoutePageViewEvent,
  resolveMemorySubPagePath,
  shouldDeferRoutePageView
} from "../page-view.js";

describe("analytics page view", () => {
  it("defers top-level page_view for memory routes", () => {
    expect(shouldDeferRoutePageView("/memory")).toBe(true);
    expect(shouldDeferRoutePageView("/memory-sources")).toBe(true);
    expect(shouldDeferRoutePageView("/main")).toBe(false);
  });

  it("builds route page_view events", () => {
    expect(buildRoutePageViewEvent("/main", "/welcome", false)).toEqual({
      name: "page_view",
      params: {
        page_title: "Home",
        page_location: "memmy://app/main",
        page_referrer: "memmy://app/welcome"
      },
      consentTier: "basic"
    });
  });

  it("builds memory sub-page page_view events", () => {
    expect(buildMemorySubPageViewEvent("tasks", "overview", false)).toEqual({
      name: "page_view",
      params: {
        page_title: "Memory/Tasks",
        page_location: "memmy://app/memory/tasks",
        page_referrer: "memmy://app/memory/overview"
      },
      consentTier: "basic"
    });

    expect(resolveMemorySubPagePath("sources")).toBe("/memory/sources");
    expect(buildMemorySubPageViewEvent("overview", null, true)).toEqual({
      name: "page_view",
      params: {
        page_title: "Memory/Overview",
        page_location: "memmy://prod.app/memory/overview",
        page_referrer: ""
      },
      consentTier: "basic"
    });
  });
});
