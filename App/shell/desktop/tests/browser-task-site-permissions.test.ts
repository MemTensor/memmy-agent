import { afterEach, expect, it, vi } from 'vitest';
import { BrowserTaskSitePermissions } from '../src/main/browser-task-site-permissions.js';

afterEach(() => { vi.useRealTimers(); });
const origin = 'https://meeting.example';

it('keeps an Agent choice to its tab and origin until the tab leaves that origin or ends', () => {
  const tasks = new BrowserTaskSitePermissions();
  tasks.set(7, origin, 'camera', true, () => true);
  expect(tasks.decision(7, origin, 'camera')).toBe(true);
  expect(tasks.decision(7, origin, 'microphone')).toBeUndefined();
  expect(tasks.decision(8, origin, 'camera')).toBeUndefined();
  expect(tasks.decision(7, 'https://other.example', 'camera')).toBeUndefined();
  tasks.end(7, `${origin}/next-room`);
  expect(tasks.decision(7, origin, 'camera')).toBe(true);
  tasks.end(7, 'https://other.example/');
  expect(tasks.decision(7, origin, 'camera')).toBeUndefined();
  for (const url of ['about:blank', 'not a url', undefined]) {
    tasks.set(7, origin, 'microphone', false, () => true);
    expect(tasks.decision(7, origin, 'microphone')).toBe(false);
    tasks.end(7, url);
    expect(tasks.decision(7, origin, 'microphone')).toBeUndefined();
  }
  tasks.set(7, origin, 'camera', true, () => true);
  tasks.set(7, 'https://other.example', 'microphone', true, () => true);
  expect(tasks.decision(7, origin, 'camera')).toBeUndefined();
  expect(tasks.decision(7, 'https://other.example', 'microphone')).toBe(true);
});

it('ends an Agent choice after 30 minutes or once its Agent process is no longer current', () => {
  vi.useFakeTimers({ now: 1_000_000 });
  const tasks = new BrowserTaskSitePermissions();
  let current = true;
  tasks.set(7, origin, 'camera', true, () => true);
  tasks.set(8, origin, 'microphone', true, () => current);
  vi.advanceTimersByTime(30 * 60_000 - 1);
  expect(tasks.decision(7, origin, 'camera')).toBe(true);
  expect(tasks.decision(8, origin, 'microphone')).toBe(true);
  current = false;
  expect(tasks.decision(8, origin, 'microphone')).toBeUndefined();
  current = true;
  expect(tasks.decision(8, origin, 'microphone')).toBeUndefined();
  vi.advanceTimersByTime(1);
  expect(tasks.decision(7, origin, 'camera')).toBeUndefined();
});
