/** Logical points. A 4pt dot matches the small status light beside other menu-bar icons. */
const RECORDING_DOT_DIAMETER = 4;
const RECORDING_DOT_GAP = 2;
/** Orange sampled from the Memmy app icon background. */
const RECORDING_ORANGE = { b: 0x34, g: 0x89, r: 0xfd };

export interface RecordingMenuBarBitmap {
  bitmap: Buffer;
  width: number;
  height: number;
}

/**
 * Draws an orange recording dot to the right of a menu-bar glyph.
 *
 * `source` is premultiplied BGRA, the format Electron's `toBitmap` / `createFromBitmap` use.
 * `ink` is 0 on a light menu bar and 255 on a dark one; template images cannot keep a colored dot.
 */
export function composeRecordingMenuBarBitmap(input: {
  source: Buffer;
  width: number;
  height: number;
  scale: number;
  ink: 0 | 255;
}): RecordingMenuBarBitmap {
  const { source, width, height, scale, ink } = input;
  if (width <= 0 || height <= 0 || scale <= 0 || source.length !== width * height * 4) {
    throw new Error("Menu bar bitmap size does not match its pixel dimensions");
  }
  const gap = Math.max(1, Math.round(RECORDING_DOT_GAP * scale));
  const diameter = Math.max(4, Math.round(RECORDING_DOT_DIAMETER * scale));
  const outWidth = width + gap + diameter;
  const out = Buffer.alloc(outWidth * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      const dst = (y * outWidth + x) * 4;
      const alpha = source.readUInt8(src + 3);
      const channel = ink === 0 ? 0 : alpha;
      out.writeUInt8(channel, dst);
      out.writeUInt8(channel, dst + 1);
      out.writeUInt8(channel, dst + 2);
      out.writeUInt8(alpha, dst + 3);
    }
  }

  const centerX = width + gap + diameter / 2;
  const centerY = height / 2;
  const radius = diameter / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = width; x < outWidth; x += 1) {
      const distance = Math.hypot(x + 0.5 - centerX, y + 0.5 - centerY);
      if (distance >= radius) continue;
      const coverage = distance <= radius - 1 ? 1 : Math.min(1, Math.max(0, radius - distance));
      const alpha = Math.round(coverage * 255);
      const dst = (y * outWidth + x) * 4;
      out.writeUInt8(Math.round(RECORDING_ORANGE.b * alpha / 255), dst);
      out.writeUInt8(Math.round(RECORDING_ORANGE.g * alpha / 255), dst + 1);
      out.writeUInt8(Math.round(RECORDING_ORANGE.r * alpha / 255), dst + 2);
      out.writeUInt8(alpha, dst + 3);
    }
  }
  return { bitmap: out, width: outWidth, height };
}
