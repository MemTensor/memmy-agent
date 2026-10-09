import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolLoader } from "../../../src/core/agent-runtime/tools/loader.js";
import { isComputerHistorySupported } from "../../../src/tools/computer-history/platform.js";
import { ComputerHistoryTool } from "../../../src/tools/computer-history/mac/computer-history.js";
import {
  ComputerHistoryGetSettingsTool,
  ComputerHistoryStatusTool,
  ComputerHistoryUpdateSettingsTool,
} from "../../../src/tools/computer-history/mac/computer-history-settings.js";

const service = vi.hoisted(() => ({ get: vi.fn(() => ({})) }));
vi.mock("../../../src/tools/computer-history/mac/computer-history-api.js", () => ({
  getComputerHistoryDemoService: service.get,
}));

const classes = [ComputerHistoryTool, ComputerHistoryStatusTool, ComputerHistoryGetSettingsTool, ComputerHistoryUpdateSettingsTool];
const names = ["computer_history", "computer_history_status", "computer_history_get_settings", "computer_history_update_settings"];

afterEach(() => {
  vi.unstubAllEnvs();
  service.get.mockClear();
});

describe.each(["win32", "linux"] as const)("Computer History unavailable on %s", (platform) => {
  it.each([undefined, "1", "0"])("cannot register or invoke tools with MEMMY_COMPUTER_HISTORY=%s", async (enabled) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    vi.stubEnv("MEMMY_COMPUTER_HISTORY", enabled);

    expect(isComputerHistorySupported()).toBe(false);
    for (const cls of classes) expect(cls.enabled()).toBe(false);
    const registry = new ToolLoader({ testClasses: classes }).loadRegistry();
    expect(registry.getDefinitions()).toEqual([]);
    for (const name of names) {
      expect(registry.get(name)).toBeUndefined();
      await expect(registry.execute(name, {})).resolves.toContain(`Tool '${name}' not found`);
    }
    expect(service.get).not.toHaveBeenCalled();
  });
});

describe("Computer History macOS availability", () => {
  it.each([undefined, "1"])("registers the existing tools with MEMMY_COMPUTER_HISTORY=%s", (enabled) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("MEMMY_COMPUTER_HISTORY", enabled);

    expect(isComputerHistorySupported()).toBe(true);
    for (const cls of classes) expect(cls.enabled()).toBe(true);
    const registry = new ToolLoader({ testClasses: classes }).loadRegistry();
    expect(registry.toolNames.sort()).toEqual([...names].sort());
  });

  it("still respects an explicit opt-out", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    vi.stubEnv("MEMMY_COMPUTER_HISTORY", "0");

    expect(isComputerHistorySupported()).toBe(true);
    const registry = new ToolLoader({ testClasses: classes }).loadRegistry();
    expect(registry.getDefinitions()).toEqual([]);
    expect(service.get).not.toHaveBeenCalled();
  });
});
