import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { parseSystemSettingsWindowFrame, permissionPanelBounds, trustedComputerUseWindowWatcher,
  watchSystemSettingsWindow } from '../src/main/computer-use-settings-window.js';

const helper = '/Applications/Memmy.app/Contents/Resources/Memmy Computer Use.app';
const binary = `${helper}/Contents/MacOS/MemmyComputerUse`;

it('only executes the helper at the host-owned packaged or development location', () => {
  expect(trustedComputerUseWindowWatcher(helper, false, '/unused', binary)).toBe(binary);
  expect(trustedComputerUseWindowWatcher(helper, false, '/unused')).toBe(binary);
  expect(trustedComputerUseWindowWatcher(helper, false, '/unused', '/Applications/Other.app/Contents/MacOS/MemmyComputerUse')).toBeNull();
  expect(trustedComputerUseWindowWatcher(helper, true, '/Applications/Memmy.app/Contents/Resources')).toBeNull();
  const packaged = '/Applications/Memmy.app/Contents/Resources/app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app';
  expect(trustedComputerUseWindowWatcher(packaged, true, '/Applications/Memmy.app/Contents/Resources'))
    .toBe(`${packaged}/Contents/MacOS/MemmyComputerUse`);
});

it('positions a responsive accessory inside the actual System Settings window and display', () => {
  const frame = { x: 614, y: 106, width: 723, height: 721 };
  expect(permissionPanelBounds(frame, { x: 0, y: 0, width: 1512, height: 982 }))
    .toEqual({ x: 786, y: 706, width: 545, height: 114 });
  expect(permissionPanelBounds({ x: -950, y: 20, width: 900, height: 760 },
    { x: -1024, y: 0, width: 1024, height: 768 }))
    .toEqual({ x: -601, y: 648, width: 545, height: 114 });
});

it('validates native frames and stops the window watcher on guide disposal', () => {
  const frame = { x: 614, y: 106, width: 723, height: 721 };
  expect(parseSystemSettingsWindowFrame(JSON.stringify(frame))).toEqual(frame);
  expect(parseSystemSettingsWindowFrame('{"x":0,"y":0,"width":100,"height":100}')).toBeNull();
  expect(parseSystemSettingsWindowFrame('{"x":0,"y":0,"width":1000,"height":800,"shell":"sh"}')).toBeNull();
  const process = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
  const start = vi.fn().mockReturnValue(process);
  const received: Array<typeof frame | null> = [];
  const stop = watchSystemSettingsWindow(binary, next => received.push(next), start);
  expect(start).toHaveBeenCalledWith(binary, ['settings-window', '--watch'], { stdio: ['ignore', 'pipe', 'ignore'] });
  process.stdout.emit('data', Buffer.from('{"x":614,"y":106,"width":723,'));
  process.stdout.emit('data', Buffer.from('"height":721}\nnull\n'));
  expect(received).toEqual([frame, null]);
  stop(); stop();
  expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  process.stdout.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`));
  expect(received).toHaveLength(2);
});
