import { afterEach, describe, expect, it } from "vitest";
import {
  configureUserTimeZone,
  detectedUserTimeZone,
  userTimeZone
} from "../user-time-zone.js";

afterEach(() => configureUserTimeZone());

describe("userTimeZone", () => {
  it("prefers config and detects the system timezone only when config is absent", () => {
    configureUserTimeZone("UTC");
    expect(userTimeZone()).toBe("+00:00");

    configureUserTimeZone();
    expect(userTimeZone()).toBe(detectedUserTimeZone());
  });
});
