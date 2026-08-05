import { describe, expect, it } from "vitest";
import {
  clearPendingFirstEncounterTaskLaunch,
  consumePendingFirstEncounterTaskLaunch,
  FIRST_ENCOUNTER_RELAY_PROMPT_KEY,
  PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY,
  readFirstEncounterRelayPrompt,
  writeFirstEncounterRelayPrompt,
  writePendingFirstEncounterTaskLaunch
} from "../first-encounter-task-launch.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("first encounter task launch", () => {
  it("stores and consumes a trimmed report task prompt", () => {
    const storage = new MemoryStorage();

    writePendingFirstEncounterTaskLaunch(storage, "  帮我整理项目背景  ", { now: 123 });

    expect(storage.getItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY)).toBe(JSON.stringify({
      prompt: "帮我整理项目背景",
      createdAt: 123
    }));
    expect(consumePendingFirstEncounterTaskLaunch(storage)).toEqual({
      prompt: "帮我整理项目背景",
      createdAt: 123
    });
    expect(storage.getItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY)).toBeNull();
  });

  it("stores assistant content and seeded chat ids for Home to open without re-running the agent", () => {
    const storage = new MemoryStorage();

    writePendingFirstEncounterTaskLaunch(storage, "Organize my latest project", {
      assistantContent: "  Hi Xiaoyan,\n\nFirst report body.  ",
      chatId: "chat-seeded",
      sessionKey: "websocket:chat-seeded",
      now: 456
    });

    expect(consumePendingFirstEncounterTaskLaunch(storage)).toEqual({
      prompt: "Organize my latest project",
      assistantContent: "Hi Xiaoyan,\n\nFirst report body.",
      chatId: "chat-seeded",
      sessionKey: "websocket:chat-seeded",
      createdAt: 456
    });
  });

  it("clears a pending task before opening the empty first conversation", () => {
    const storage = new MemoryStorage();
    writePendingFirstEncounterTaskLaunch(storage, "这条内容不应自动发送");

    clearPendingFirstEncounterTaskLaunch(storage);

    expect(consumePendingFirstEncounterTaskLaunch(storage)).toBeNull();
  });

  it("persists the language- and workspace-aware relay prompt for Home", () => {
    const storage = new MemoryStorage();

    writeFirstEncounterRelayPrompt(storage, "  项目路径是：/Users/jiang/MyProject/memmy-agent-jiang  ");

    expect(storage.getItem(FIRST_ENCOUNTER_RELAY_PROMPT_KEY)).toBe("项目路径是：/Users/jiang/MyProject/memmy-agent-jiang");
    expect(readFirstEncounterRelayPrompt(storage)).toBe("项目路径是：/Users/jiang/MyProject/memmy-agent-jiang");
  });
});
