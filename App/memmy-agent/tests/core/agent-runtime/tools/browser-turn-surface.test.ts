import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSessionManager } from '../../../../src/core/agent-runtime/tools/browser.js';
import type { ExternalBrowserSessionRouter } from '../../../../src/core/agent-runtime/tools/external-browser-session-router.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('ends the projected browser PiP without destroying the shared page', async () => {
  const manager = new BrowserSessionManager({}, { desktopManaged: false });
  const scope = { sessionKey: 'session', channel: 'projected-session', chatId: 'session' };
  const session = { scope, closed: false };
  const key = JSON.stringify([scope.sessionKey, scope.channel, scope.chatId]);
  (manager as any).sessions.set(key, session);
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));

  await manager.closeSurfacesForTurn({ sessionKey: 'session', channel: 'websocket', chatId: 'chat' });

  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    type: 'memmy:computer-use-surface:close', surface: 'browser',
    presentationOnly: true, channel: 'projected-session', chatId: 'session',
  }), expect.any(Function));
  expect((manager as any).sessions.get(key)).toBe(session);
});

it('finishes a projected in-app tab only once', async () => {
  const finishTurn = vi.fn(async () => undefined);
  const router = { finishTurn, closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({}, { desktopManaged: false, embeddedRouter: router });
  const scope = { sessionKey: 'session', channel: 'projected-session', chatId: 'session' };
  await manager.closeSurfacesForTurn(scope);
  expect(finishTurn).toHaveBeenCalledOnce();
  expect(finishTurn).toHaveBeenCalledWith(scope);
  await manager.close();
});
