import { describe, expect, it } from "vitest";
import { repairWebmDuration } from "../webm-duration.js";

function fixture(duration = 1) {
  const bytes = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x80,
    0x18, 0x53, 0x80, 0x67, 0xff,
    0x15, 0x49, 0xa9, 0x66, 0x8e,
    0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40,
    0x44, 0x89, 0x84, 0, 0, 0, 0,
    0x1f, 0x43, 0xb6, 0x75, 0x81, 0x12,
  ]);
  new DataView(bytes.buffer).setFloat32(25, duration);
  return new Blob([bytes], { type: "audio/webm" });
}

describe("WebM duration repair", () => {
  it("corrects Chrome's 1ms header while preserving every packet offset", async () => {
    const original = fixture();
    const repaired = await repairWebmDuration(original, 234000);
    expect(repaired.size).toBe(original.size);
    expect(repaired.type).toBe(original.type);
    const before = new Uint8Array(await original.arrayBuffer());
    const after = new Uint8Array(await repaired.arrayBuffer());
    expect(new DataView(after.buffer).getFloat32(25)).toBe(234000);
    expect(after.slice(0, 25)).toEqual(before.slice(0, 25));
    expect(after.slice(29)).toEqual(before.slice(29));
  });

  it("leaves valid metadata, other formats and malformed input unchanged", async () => {
    for (const blob of [fixture(234000), new Blob(["not webm"]), fixture().slice(0, 28)]) {
      expect(await repairWebmDuration(blob, 234000)).toBe(blob);
    }
    const blob = fixture();
    expect(await repairWebmDuration(blob, Number.NaN)).toBe(blob);
    expect(await repairWebmDuration(blob, 0)).toBe(blob);
  });
});
