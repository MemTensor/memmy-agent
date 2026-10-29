// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ComputerUseSurfaceMessage } from '@memmy/local-api-contracts';
import { AgentBrowserSurface } from '../agent-browser-surface.js';
import { I18nProvider } from '../../i18n/i18n-provider.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows and controls the Agent browser for the current session only', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let publish: (message: ComputerUseSurfaceMessage) => void = () => undefined;
  const send = vi.fn(async () => true);
  Object.defineProperty(window, 'memmy', { configurable: true, value: {
    onBrowserSidebarSurface: (callback: typeof publish) => { publish = callback; return () => undefined; },
    getBrowserSidebarSurface: vi.fn(async () => null),
    sendBrowserSidebarAction: send,
  } });
  await act(async () => root.render(<I18nProvider language="zh-CN"><AgentBrowserSurface sessionKey="session-a" /></I18nProvider>));
  const message = { type: 'memmy:computer-use-surface:update', surface: 'browser',
    sessionKey: 'session-a', channel: 'projected-session', chatId: 'session-a',
    targetId: 'active-tab', title: 'Example', imageDataUrl: 'data:image/jpeg;base64,YWJj' } as const;
  act(() => publish({ ...message, sessionKey: 'session-b' }));
  expect(container.querySelector('img')).toBeNull();
  act(() => publish(message));
  const image = container.querySelector('img')!;
  Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 100 } });
  vi.spyOn(image, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 200, height: 200 } as DOMRect);
  await act(async () => image.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 50 })));
  expect(send).toHaveBeenCalledWith('session-a', { action: 'click', x: 0.5, y: 0.25 });
  await act(async () => (container.querySelector('button') as HTMLButtonElement).click());
  expect(send).toHaveBeenCalledWith('session-a', { action: 'open' });
  act(() => publish({ ...message, type: 'memmy:computer-use-surface:close' }));
  expect(container.querySelector('img')).toBeNull();
  act(() => root.unmount());
  Reflect.deleteProperty(window, 'memmy');
  container.remove();
});
