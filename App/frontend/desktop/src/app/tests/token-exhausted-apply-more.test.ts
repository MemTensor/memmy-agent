import { describe, expect, it } from "vitest";
import {
  consumeTokenExhaustedApplyMoreRequest,
  TOKEN_EXHAUSTED_APPLY_MORE_EVENT,
  writeTokenExhaustedApplyMoreRequest
} from "../token-exhausted-apply-more.js";

describe("token exhausted apply-more request", () => {
  it("writes and consumes a one-shot request from session storage", () => {
    const storage = new MapStorage();

    expect(consumeTokenExhaustedApplyMoreRequest(storage)).toBe(false);
    writeTokenExhaustedApplyMoreRequest(storage);
    expect(consumeTokenExhaustedApplyMoreRequest(storage)).toBe(true);
    expect(consumeTokenExhaustedApplyMoreRequest(storage)).toBe(false);
  });

  it("uses a stable event name for same-page settings listeners", () => {
    expect(TOKEN_EXHAUSTED_APPLY_MORE_EVENT).toBe("memmy:token-exhausted-apply-more");
  });
});

class MapStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
