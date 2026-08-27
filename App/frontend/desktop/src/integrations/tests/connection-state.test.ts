import { describe, expect, it } from "vitest";
import { deriveIntegrationState, type IntegrationConnection } from "../connection-state.js";

describe("deriveIntegrationState", () => {
  it.each([
    ["ACTIVE", "connected"],
    ["connected", "connected"],
    ["INITIATED", "pending"],
    ["PENDING", "pending"],
    ["initializing", "pending"],
    ["EXPIRED", "expired"],
    ["FAILED", "error"],
    ["error", "error"]
  ] as const)("把 %s 映射为 %s", (status, expected) => {
    const connection: IntegrationConnection = { id: "conn-github", toolkit: "github", status };

    expect(deriveIntegrationState(connection)).toBe(expected);
  });

  it("没有连接记录时返回 disconnected", () => {
    expect(deriveIntegrationState()).toBe("disconnected");
  });
});
