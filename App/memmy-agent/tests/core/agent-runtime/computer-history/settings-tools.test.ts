import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ObservationSettingsStore } from "../../../../src/core/agent-runtime/computer-history/settings-store.js";
import {
  ComputerHistoryGetSettingsTool,
  ComputerHistoryStatusTool,
  ComputerHistoryUpdateSettingsTool,
  runStateFrom,
} from "../../../../src/core/agent-runtime/tools/computer-history-settings.js";
import { ToolLoader } from "../../../../src/core/agent-runtime/tools/loader.js";

const temporaryDirectories: string[] = [];

function temporaryStore(): ObservationSettingsStore {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-observation-"));
  temporaryDirectories.push(directory);
  return new ObservationSettingsStore(path.join(directory, "observation-settings.json"));
}

const snapshot = (status: string) => ({
  capture: { status, startedAt: "2026-09-08T00:00:00.000Z", error: null },
  privacy: {
    screenshots: false,
    audio: false,
    rawRetentionHours: 48,
    markdownDirectory: "/tmp/histories",
  },
});

afterEach(() => {
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("Computer History settings tools", () => {
  it("registers all three tools alongside retrieval", () => {
    const registry = new ToolLoader({
      testClasses: [
        ComputerHistoryStatusTool,
        ComputerHistoryGetSettingsTool,
        ComputerHistoryUpdateSettingsTool,
      ],
    }).loadRegistry();

    expect(registry.get("computer_history_status")).toBeDefined();
    expect(registry.get("computer_history_get_settings")).toBeDefined();
    expect(registry.get("computer_history_update_settings")).toBeDefined();
  });

  it("maps capture status onto the recorder lifecycle vocabulary", () => {
    expect(runStateFrom("recording")).toBe("running");
    expect(runStateFrom("idle")).toBe("stopped");
    expect(runStateFrom("stopping")).toBe("stopping");
    expect(runStateFrom("failed")).toBe("failed");
  });

  it("reports where the event stream lives so the agent can search it", async () => {
    const tool = new ComputerHistoryStatusTool(
      { snapshot: () => snapshot("recording") } as any,
      temporaryStore(),
    );
    const result = JSON.parse(await tool.execute());

    expect(result.state).toBe("running");
    expect(result.event_stream_root_path).toBe("/tmp/histories");
    expect(result.privacy).toMatchObject({ screenshots: false, audio: false });
  });

  it("returns the safe default before the user has configured anything", async () => {
    const result = JSON.parse(await new ComputerHistoryGetSettingsTool(temporaryStore()).execute());

    expect(result.settings.observation.defaultApplicationBehavior).toBe("do_not_observe");
    expect(result.settings.observation.rules).toEqual([]);
  });

  it("round-trips a full document through update and get", async () => {
    const store = temporaryStore();
    const document = {
      observation: {
        defaultApplicationBehavior: "observe",
        defaultURLBehavior: "observe",
        rules: [{ scope: "url", urlDomain: "bank.com", behavior: "do_not_observe" }],
      },
    };

    const written = JSON.parse(
      await new ComputerHistoryUpdateSettingsTool(store).execute({ settings: document }),
    );
    expect(written.status).toBe("ok");

    const read = JSON.parse(await new ComputerHistoryGetSettingsTool(store).execute());
    expect(read.settings).toEqual(document);
  });

  it("rejects an invalid document instead of writing a partial policy", async () => {
    const store = temporaryStore();
    const result = await new ComputerHistoryUpdateSettingsTool(store).execute({
      settings: { observation: { defaultApplicationBehavior: "observe" } },
    });

    expect(result).toContain("invalid Computer History settings");
    expect(fs.existsSync(store.filePath)).toBe(false);
  });

  it("warns the agent that an update replaces the whole document", () => {
    const description = new ComputerHistoryUpdateSettingsTool(temporaryStore()).description;
    expect(description).toContain("replaces the whole document");
    expect(description).toContain("computer_history_get_settings first");
  });
});
