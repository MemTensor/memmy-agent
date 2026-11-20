import { describe, expect, it } from "vitest";
import { ToolDiscovery, definitionName, sessionToolDiscovery } from "../../../src/core/agent-runtime/tool-discovery.js";
import { estimatePromptTokens } from "../../../src/utils/helpers.js";

function definition(name: string, description = name, properties = {}) {
  return { type: "function", function: { name, description, parameters: { type: "object", properties } } };
}

const catalog = [definition("read_file"), definition("calendar_events", "查询日历会议和日程 Calendar meetings", { starts_at: { type: "string" } }),
  definition("weather_forecast", "天气预报 Weather forecast")];

describe("tool discovery", () => {
  it("keeps 500 schemas out of the initial request and activates only matches without duplicating schemas in results", () => {
    const all = [definition("read_file"), ...Array.from({ length: 500 }, (_, i) => definition(`mcp_inventory_item_${i}`, `Inventory ${i}`, { internal_marker: { type: "string" } }))];
    const state = new ToolDiscovery();
    expect(state.definitions(all).map(definitionName)).toEqual(["tool_search", "read_file"]);
    const result = state.search({ query: "mcp_inventory_item_123", limit: 1 });
    expect(JSON.parse(result).tools.map((tool: any) => tool.name)).toEqual(["mcp_inventory_item_123"]);
    expect(result).not.toContain("internal_marker");
    state.search({ query: "mcp_inventory_item_123", limit: 1 });
    expect(state.definitions(all).map(definitionName)).toEqual(["tool_search", "read_file", "mcp_inventory_item_123"]);
  });

  it.each(["日历会议", "Calendar meetings", "starts_at"])("retrieves descriptions and parameter names for %s", query => {
    const state = new ToolDiscovery();
    state.definitions(catalog);
    expect(JSON.parse(state.search({ query, limit: 1 })).tools[0].name).toBe("calendar_events");
  });

  it("resets on compaction, isolates sessions and does not persist activation on recovery", () => {
    const session = { lastConsolidated: 0, metadata: {} as Record<string, any> };
    const state = sessionToolDiscovery(session);
    state.definitions(catalog);
    state.search({ query: "calendar_events", limit: 1 });
    expect(sessionToolDiscovery(session).definitions(catalog).map(definitionName)).toContain("calendar_events");
    expect(sessionToolDiscovery({ ...session }).definitions(catalog).map(definitionName)).not.toContain("calendar_events");
    session.lastConsolidated = 5;
    expect(sessionToolDiscovery(session).definitions(catalog).map(definitionName)).not.toContain("calendar_events");
    state.search({ query: "weather_forecast", limit: 1 });
    session.metadata.lastSummary = { text: "new summary" };
    expect(sessionToolDiscovery(session).definitions(catalog).map(definitionName)).not.toContain("weather_forecast");
  });

  it("uses current definitions and removes disabled tools from both search and activation", () => {
    const state = new ToolDiscovery();
    state.definitions(catalog);
    state.search({ query: "calendar_events", limit: 1 });
    const changed = definition("calendar_events", "new version", { timezone: { type: "string" } });
    expect(state.definitions([changed])).toContainEqual(changed);
    state.definitions([catalog[2]]);
    expect(JSON.parse(state.search({ query: "calendar_events", limit: 1 })).tools).toEqual([]);
    expect(state.definitions(catalog).map(definitionName)).not.toContain("calendar_events");
  });

  it("bounds definitions by tokens and reports oversized tools without cutting schemas", () => {
    const state = new ToolDiscovery();
    const all = [...catalog, definition("oversized", "x ".repeat(20_000))];
    state.definitions(all, 1_500);
    expect(JSON.parse(state.search({ query: "oversized", limit: 1 })).omittedForBudget).toBeGreaterThan(0);
    state.search({ query: "calendar_events", limit: 1 });
    const visible = state.definitions(all, 1_500);
    expect(estimatePromptTokens([], visible)).toBeLessThanOrEqual(1_500);
    expect(visible.find(tool => definitionName(tool) === "calendar_events")).toEqual(catalog[1]);
  });

  it("keeps discovery reachable in tiny windows and prioritizes resident tools", () => {
    const state = new ToolDiscovery();
    expect(state.definitions(catalog, 1).map(definitionName)).toEqual(["tool_search"]);
    state.definitions(catalog);
    state.search({ query: "calendar_events", limit: 1 });
    const visible = state.definitions([catalog[1], catalog[0]], 400);
    expect(visible.map(definitionName).slice(0, 2)).toEqual(["tool_search", "read_file"]);
  });

  it.each([null, [], {}, { query: "" }, { query: "x", limit: 0 }, { query: "x", limit: 9 }, { query: "x", limit: 1.5 }, { query: "x", extra: true }])("rejects invalid discovery arguments %j", args => {
    expect(new ToolDiscovery().search(args)).toMatch(/^Error:/u);
  });

  it("bounds source hints and never lists the complete catalog in errors", () => {
    const state = new ToolDiscovery();
    const visible = state.definitions(Array.from({ length: 500 }, (_, i) => definition(`source${i}_lookup`, "d".repeat(500))));
    expect(visible[0].function.description.length).toBeLessThan(5_000);
    const small = state.definitions(Array.from({ length: 500 }, (_, i) => definition(`source${i}_lookup`, "d".repeat(500))), 700);
    expect(estimatePromptTokens([], small)).toBeLessThanOrEqual(700);
    expect(small[0].function.description).toContain("After context compaction");
    expect(state.search({ query: "unmatchedterm" })).not.toContain("source499_lookup");
  });
});
