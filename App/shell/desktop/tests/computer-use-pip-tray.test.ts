import { expect, it, vi } from 'vitest';
import { createPIPTrayRecovery } from '../src/main/computer-use-pip-tray.js';

function fixture(present = false) {
  const host = { hasTray: () => present,
    showTray: vi.fn(() => { present = true; }), removeTray: vi.fn(() => { present = false; }), updateMenu: vi.fn() };
  return { host, recovery: createPIPTrayRecovery(host) };
}
it('temporarily exposes recovery when the tray was off, then restores that preference after show or task close', () => {
  for (const completion of ['restore', 'last-hidden-entry-close']) {
    const { host, recovery } = fixture();
    expect(recovery.trayRequested(false, false)).toBe(false);
    recovery.visibilityChanged(true);
    expect(host.hasTray(), completion).toBe(true);
    recovery.visibilityChanged(true);
    expect(host.showTray).toHaveBeenCalledOnce();
    recovery.visibilityChanged(false);
    expect(host.hasTray(), completion).toBe(false);
    expect(host.removeTray).toHaveBeenCalledOnce();
  }
});
it('keeps an existing tray resident after recovery', () => {
  const { host, recovery } = fixture(true);
  recovery.visibilityChanged(true);
  recovery.visibilityChanged(false);
  expect(host.hasTray()).toBe(true);
  expect(host.removeTray).not.toHaveBeenCalled();
});
it('respects enabling the tray while a temporary recovery entry is visible', () => {
  const { host, recovery } = fixture();
  recovery.visibilityChanged(true);
  expect(recovery.trayRequested(true, true)).toBe(true);
  recovery.visibilityChanged(false);
  expect(host.hasTray()).toBe(true);
});
it('defers a tray-off request until hidden active presentations can be restored', () => {
  const { host, recovery } = fixture(true);
  expect(recovery.trayRequested(false, true)).toBe(true);
  recovery.visibilityChanged(false);
  expect(host.hasTray()).toBe(false);
});
