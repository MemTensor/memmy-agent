import { describe, expect, it } from 'vitest';
import { isComputerUseSurfaceAction, isComputerUseSurfaceMessage } from './computer-use-surface.js';

const update = {
  type: 'memmy:computer-use-surface:update', surface: 'browser', sessionKey: 's',
  channel: 'gui', chatId: 'chat', targetId: 'tab', title: 'Example',
  imageDataUrl: 'data:image/jpeg;base64,YWJj',
};

describe('computer use surface child IPC', () => {
  it('accepts a bounded browser image update', () => {
    expect(isComputerUseSurfaceMessage(update)).toBe(true);
    expect(isComputerUseSurfaceMessage({ ...update, url: 'https://example.com/',
      canGoBack: true, canGoForward: false })).toBe(true);
    expect(isComputerUseSurfaceMessage({ ...update, canGoBack: 'yes' })).toBe(false);
    expect(isComputerUseSurfaceMessage({ ...update, surface: 'computer', url: 'https://example.com/' })).toBe(false);
    expect(isComputerUseSurfaceMessage({ ...update, surface: 'computer', targetWindowId: 42 })).toBe(true);
    expect(isComputerUseSurfaceMessage({ ...update, targetWindowId: 42 })).toBe(false);
    expect(isComputerUseSurfaceMessage({ ...update, surface: 'computer', targetWindowId: 0 })).toBe(false);
  });

  it('rejects active content and oversized frames', () => {
    expect(isComputerUseSurfaceMessage({ ...update, imageDataUrl: 'data:text/html;base64,YWJj' })).toBe(false);
    expect(isComputerUseSurfaceMessage({ ...update, imageDataUrl: `data:image/png;base64,${'A'.repeat(3_000_001)}` })).toBe(false);
  });

  it('rejects unexpected fields', () => {
    expect(isComputerUseSurfaceMessage({ ...update, action: 'execute' })).toBe(false);
  });

  it('accepts a bounded native turn identity only on computer surfaces', () => {
    expect(isComputerUseSurfaceMessage({ ...update, surface: 'computer', turnId: 'turn-1' })).toBe(true);
    expect(isComputerUseSurfaceMessage({ ...update, turnId: 'turn-1' })).toBe(false);
    expect(isComputerUseSurfaceMessage({ ...update, surface: 'computer', turnId: '' })).toBe(false);
  });

  it('distinguishes closing the PiP from closing the browser session', () => {
    const close = { ...update, type: 'memmy:computer-use-surface:close' };
    expect(isComputerUseSurfaceMessage({ ...close, presentationOnly: true })).toBe(true);
    expect(isComputerUseSurfaceMessage({ ...update, presentationOnly: true })).toBe(false);
    expect(isComputerUseSurfaceMessage({ ...close, surface: 'computer', presentationOnly: true })).toBe(false);
  });
});

it('accepts only bounded interactions with the bound surface', () => {
  const action = { type: 'memmy:computer-use-surface:action', surface: 'browser',
    sessionKey: 's', channel: 'gui', chatId: 'chat', targetId: 'tab',
    action: 'click', x: 0.25, y: 0.75 };
  expect(isComputerUseSurfaceAction(action)).toBe(true);
  expect(isComputerUseSurfaceAction({ ...action, x: 1.5 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, command: 'execute' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', frameMode: 'live', frameWidth: 1920, frameHeight: 1080 })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', targetWindowId: 42,
    frameMode: 'live', frameWidth: 1920, frameHeight: 1080 })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...action, targetWindowId: 42 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', targetWindowId: -1 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', frameMode: 'live' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', frameMode: 'live', frameWidth: 0, frameHeight: 1080 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', frameMode: 'live', frameWidth: 1.5, frameHeight: 1080 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, frameMode: 'live' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, action: 'open', x: undefined, y: undefined })).toBe(false);
  const { x: _x, y: _y, ...withoutCoordinates } = action;
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'open' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'open' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'interrupt', turnId: 'turn-1' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'interrupt' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'browser', action: 'interrupt', turnId: 'turn-1' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'interrupt', turnId: 'turn-1', key: 'Escape' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'interrupt', turnId: 'turn-1', targetWindowId: -1 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'key', key: 'Enter' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'key', key: 'Enter', frameMode: 'live' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'key', key: 'Enter', frameMode: 'live' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'back' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'forward' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'reload' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'navigate', url: 'https://example.com/' })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'navigate', url: 'javascript:alert(1)' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'navigate', url: 'https://example.com/' })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', action: 'scroll', deltaY: 120 })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...action, surface: 'computer', action: 'scroll', deltaY: 120,
    frameMode: 'live', frameWidth: 1920, frameHeight: 1080 })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, surface: 'computer', action: 'scroll', deltaY: 120 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...action, action: 'scroll', deltaY: 120 })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...action, action: 'scroll', y: undefined, deltaY: 120 })).toBe(false);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'scroll', deltaY: 120 })).toBe(true);
  expect(isComputerUseSurfaceAction({ ...withoutCoordinates, action: 'scroll', deltaY: 120, frameMode: 'live' })).toBe(false);
});
