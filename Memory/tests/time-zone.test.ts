import { describe, expect, it } from "vitest";
import { panelDateKey, panelDateKeys } from "../src/service/read-model/model-costs.js";
import {
  formatZonedTime,
  isoTimeToUtc,
  resolveTimeZone,
  zonedDateKey
} from "../src/utils/time.js";

describe("user timezone handling", () => {
  it("interprets offset-less imported times using the current fixed offset", () => {
    expect(isoTimeToUtc("2026-08-06T12:30:15", "Asia/Shanghai"))
      .toBe("2026-08-06T04:30:15.000Z");
    expect(isoTimeToUtc("2026-08-06T12:30:15+08:00", "America/New_York"))
      .toBe("2026-08-06T04:30:15.000Z");
    expect(isoTimeToUtc("2026-01-15T12:00:00", "UTC-05:00"))
      .toBe("2026-01-15T17:00:00.000Z");
    expect(isoTimeToUtc("2026-07-15T12:00:00", "UTC-04:00"))
      .toBe("2026-07-15T16:00:00.000Z");
    expect(resolveTimeZone("UTC+8")).toBe("+08:00");
    expect(resolveTimeZone("Asia/Shanghai")).toBe("+08:00");
  });

  it("formats and groups instants by the user's local calendar day", () => {
    const instant = "2026-08-06T16:30:00.000Z";
    expect(zonedDateKey(instant, "Asia/Shanghai")).toBe("2026-08-07");
    expect(panelDateKey(instant, "America/Los_Angeles")).toBe("2026-08-06");
    expect(panelDateKeys(instant, 2, "Asia/Shanghai")).toEqual([
      "2026-08-06",
      "2026-08-07"
    ]);
    expect(formatZonedTime(instant, "Asia/Shanghai"))
      .toBe("2026-08-07 00:30:00 UTC+08:00");
  });

  it("rejects unknown IANA timezones", () => {
    expect(() => resolveTimeZone("Mars/Base")).toThrow("invalid timezone: Mars/Base");
  });
});
