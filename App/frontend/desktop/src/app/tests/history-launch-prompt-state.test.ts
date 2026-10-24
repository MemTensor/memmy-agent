import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeComputerHistoryLaunchEnable,
  hasComputerHistoryLaunchEnable,
  requestComputerHistoryLaunchEnable,
} from "../computer-history-launch-intent.js";
import {
  HISTORY_LAUNCH_PROMPT_EXPIRES_AT,
  areOtherPromptsDeferredForHistoryLaunch,
  deferOtherPromptsForHistoryLaunch,
  markHistoryLaunchPromptActioned,
  markHistoryLaunchPromptDismissed,
  markHistoryLaunchPromptShown,
  readHistoryLaunchPromptState,
  shouldOfferHistoryLaunchPrompt,
} from "../history-launch-prompt-state.js";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("History launch announcement", () => {
  let storage: MemoryStorage;
  beforeEach(() => { storage = new MemoryStorage(); });

  it("appears once on a supported platform through 2026-10-31 China time", () => {
    const state = readHistoryLaunchPromptState(storage);
    const during = Date.parse("2026-10-31T23:59:59+08:00");
    const expired = Date.parse(HISTORY_LAUNCH_PROMPT_EXPIRES_AT);
    expect(shouldOfferHistoryLaunchPrompt({ state, supported: true, nowMs: during })).toBe(true);
    expect(shouldOfferHistoryLaunchPrompt({ state, supported: true, nowMs: expired })).toBe(false);
    expect(shouldOfferHistoryLaunchPrompt({ state, supported: false, nowMs: during })).toBe(false);
    markHistoryLaunchPromptShown(storage);
    expect(shouldOfferHistoryLaunchPrompt({ state: readHistoryLaunchPromptState(storage), supported: true, nowMs: during })).toBe(false);
  });

  it("persists close and action independently", () => {
    markHistoryLaunchPromptDismissed(storage);
    expect(readHistoryLaunchPromptState(storage)).toEqual({ shown: true, dismissed: true, actioned: false });
    storage.clear();
    markHistoryLaunchPromptActioned(storage);
    expect(readHistoryLaunchPromptState(storage)).toEqual({ shown: true, dismissed: false, actioned: true });
  });

  it("consumes the enable handoff once and expires abandoned navigation", () => {
    requestComputerHistoryLaunchEnable(storage, 10_000);
    expect(hasComputerHistoryLaunchEnable(storage, 10_001)).toBe(true);
    expect(consumeComputerHistoryLaunchEnable(storage, 10_001)).toBe(true);
    expect(consumeComputerHistoryLaunchEnable(storage, 10_001)).toBe(false);
    requestComputerHistoryLaunchEnable(storage, 10_000);
    expect(hasComputerHistoryLaunchEnable(storage, 70_001)).toBe(false);
    expect(consumeComputerHistoryLaunchEnable(storage, 70_001)).toBe(false);
  });

  it("keeps other promotional prompts out of the consent flow for this session", () => {
    expect(areOtherPromptsDeferredForHistoryLaunch(storage)).toBe(false);
    deferOtherPromptsForHistoryLaunch(storage);
    expect(areOtherPromptsDeferredForHistoryLaunch(storage)).toBe(true);
  });
});
