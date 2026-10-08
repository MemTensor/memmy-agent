import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeRecordingMenuBarBitmap } from "../src/main/menu-bar-recording-indicator.js";

function bitmap(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [b, g, r, a] = paint(x, y);
      const offset = (y * width + x) * 4;
      buffer.writeUInt8(b, offset);
      buffer.writeUInt8(g, offset + 1);
      buffer.writeUInt8(r, offset + 2);
      buffer.writeUInt8(a, offset + 3);
    }
  }
  return buffer;
}

function pixel(buffer: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [buffer.readUInt8(offset), buffer.readUInt8(offset + 1), buffer.readUInt8(offset + 2), buffer.readUInt8(offset + 3)];
}

describe("menu bar recording indicator", () => {
  it("places a small opaque orange dot to the right of the glyph", () => {
    const width = 8;
    const height = 8;
    const source = bitmap(width, height, (x, y) => x === 1 && y === 1 ? [0, 0, 0, 200] : [0, 0, 0, 0]);
    const composed = composeRecordingMenuBarBitmap({ source, width, height, scale: 1, ink: 0 });

    expect(composed.height).toBe(height);
    expect(composed.width).toBe(width + 2 + 4);
    expect(pixel(composed.bitmap, composed.width, 1, 1)).toEqual([0, 0, 0, 200]);

    const dotX = width + 2 + 2;
    const dot = pixel(composed.bitmap, composed.width, dotX, height / 2);
    expect(dot[3]).toBe(255);
    expect(dot[2]).toBe(0xfd);
    expect(dot[1]).toBe(0x89);
    expect(dot[0]).toBe(0x34);
    expect(pixel(composed.bitmap, composed.width, width, height / 2)[3]).toBe(0);
  });

  it("paints the glyph white, premultiplied, for a dark menu bar", () => {
    const source = bitmap(4, 4, () => [0, 0, 0, 128]);
    const composed = composeRecordingMenuBarBitmap({ source, width: 4, height: 4, scale: 1, ink: 255 });
    expect(pixel(composed.bitmap, composed.width, 0, 0)).toEqual([128, 128, 128, 128]);
  });

  it("rejects a bitmap that does not match its dimensions", () => {
    expect(() => composeRecordingMenuBarBitmap({
      source: Buffer.alloc(8),
      width: 2,
      height: 2,
      scale: 1,
      ink: 0,
    })).toThrow(/pixel dimensions/);
  });

  it("draws the recording mark into the tray image instead of a plain text bullet", () => {
    const source = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
    expect(source).toContain("composeRecordingMenuBarBitmap");
    expect(source).toContain("menu-bar-appearance.node");
    expect(source).toContain("menuBarAppearance()");
    expect(source).not.toContain("shouldUseDarkColorsForSystemIntegratedUI");
    expect(source).not.toContain('setTitle(recording ? "●"');
  });
});
