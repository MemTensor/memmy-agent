import { describe, expect, it } from "vitest";
import {
  clearPendingFirstEncounterTaskLaunch,
  consumePendingFirstEncounterTaskLaunch,
  PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY,
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

    writePendingFirstEncounterTaskLaunch(storage, "  帮我整理项目背景  ", 123);

    expect(storage.getItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY)).toBe(JSON.stringify({
      prompt: "帮我整理项目背景",
      createdAt: 123
    }));
    expect(consumePendingFirstEncounterTaskLaunch(storage)).toBe("帮我整理项目背景");
    expect(storage.getItem(PENDING_FIRST_ENCOUNTER_TASK_LAUNCH_KEY)).toBeNull();
  });

  it("clears a pending task before opening the empty first conversation", () => {
    const storage = new MemoryStorage();
    writePendingFirstEncounterTaskLaunch(storage, "这条内容不应自动发送");

    clearPendingFirstEncounterTaskLaunch(storage);

    expect(consumePendingFirstEncounterTaskLaunch(storage)).toBeNull();
  });
});
