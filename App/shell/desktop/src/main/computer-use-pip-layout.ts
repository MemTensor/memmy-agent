import type { Rectangle } from 'electron';

export type PIPSize = { width: number; height: number };

/** Keep the source aspect ratio; a short edge is not a second minimum size. */
export function pipSize(width: number, height: number, edge = 200): PIPSize {
  const ratio = Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : 4 / 3;
  return ratio >= 1 ? { width: edge, height: Math.max(1, Math.round(edge / ratio)) }
    : { width: Math.max(1, Math.round(edge * ratio)), height: edge };
}

/** Ordered columns avoid reusing a position after four active presentations. */
export function layoutPIPStack(sizes: readonly PIPSize[], area: Rectangle): Rectangle[] {
  const margin = 16, gap = 36;
  // Native hover controls sit above the card in their own panel.
  const top = area.y + 48;
  const right = area.x + area.width - margin;
  const bottom = area.y + area.height - margin;
  let columnRight = right;
  let cursor = bottom;
  let columnWidth = 0;
  return sizes.map(size => {
    if (cursor - size.height < top && columnWidth > 0) {
      columnRight -= columnWidth + gap;
      cursor = bottom;
      columnWidth = 0;
    }
    const bounds = { x: Math.max(area.x + margin, columnRight - size.width),
      y: Math.min(bottom - size.height, Math.max(top, cursor - size.height)), ...size };
    columnWidth = Math.max(columnWidth, size.width);
    cursor = bounds.y - gap;
    return bounds;
  });
}
