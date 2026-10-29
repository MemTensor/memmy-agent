import { describe, expect, it } from 'vitest';
import { layoutPIPStack, pipSize } from '../src/main/computer-use-pip-layout.js';

const area = { x: 0, y: 0, width: 1200, height: 800 };
const overlaps = (a: typeof area, b: typeof area) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;
function assertDistinct(bounds: typeof area[]) {
  bounds.forEach((a, index) => {
    expect(a.x).toBeGreaterThanOrEqual(area.x);
    expect(a.y).toBeGreaterThanOrEqual(area.y);
    expect(a.x + a.width).toBeLessThanOrEqual(area.width);
    expect(a.y + a.height).toBeLessThanOrEqual(area.height);
    bounds.slice(index + 1).forEach(b => expect(overlaps(a, b)).toBe(false));
  });
}
describe('Computer Use presentation layout', () => {
  it('preserves wide and tall sources while clamping only the long edge', () => {
    expect(pipSize(2400, 400)).toEqual({ width: 200, height: 33 });
    expect(pipSize(400, 2400, 400)).toEqual({ width: 67, height: 400 });
    expect(pipSize(0, 0)).toEqual({ width: 200, height: 150 });
  });
  it('keeps more than four presentations distinct, including mixed aspect ratios', () => {
    const bounds = layoutPIPStack([pipSize(4, 3), pipSize(3, 4), pipSize(6, 1),
      pipSize(1, 6), pipSize(4, 3), pipSize(4, 3)], area);
    assertDistinct(bounds);
  });
  it('respects an external display with a negative desktop origin', () => {
    const display = { x: -1400, y: -300, width: 1400, height: 900 };
    const bounds = layoutPIPStack([pipSize(4, 3), pipSize(3, 4)], display);
    bounds.forEach(card => {
      expect(card.x).toBeGreaterThanOrEqual(display.x);
      expect(card.x + card.width).toBeLessThanOrEqual(0);
      expect(card.y).toBeGreaterThanOrEqual(display.y);
      expect(card.y + card.height).toBeLessThanOrEqual(600);
    });
  });
});
