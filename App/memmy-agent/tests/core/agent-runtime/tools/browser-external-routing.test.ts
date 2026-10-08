import { expect, it, vi } from "vitest";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserSessionManager } from "../../../../src/core/agent-runtime/tools/browser.js";
import type { ExternalBrowserSessionRouter } from "../../../../src/core/agent-runtime/tools/external-browser-session-router.js";

it("routes Agent tools and sidebar actions to the claimed external tab without launching Playwright", async () => {
  const scope = { sessionKey: "chat", channel: "projected-session", chatId: "chat" };
  const claim = { connectionId: "browser", tabId: 5, browser: "chrome" as const,
    title: "Test", url: "https://example.test/", claimedAt: 1 };
  const router = {
    select: vi.fn(() => claim),
    call: vi.fn(async () => [{ type: "text", text: "[ax-1] button" }]),
    handleSurfaceAction: vi.fn(async () => true),
    closeSession: vi.fn(), closeChat: vi.fn(), closeSurfacesForTurn: vi.fn(), closeAll: vi.fn(),
  } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router,
    runtimeLoader: vi.fn(async () => { throw new Error("Playwright should not start"); }),
  });
  expect(await manager.callTool(scope, "browser_snapshot", {})).toEqual([
    { type: "text", text: "[ax-1] button" },
  ]);
  expect(router.select).toHaveBeenCalledWith(scope, false);
  expect(router.call).toHaveBeenCalledWith(scope, claim, "browser_snapshot", {}, null);
  const action = { type: "memmy:computer-use-surface:action" as const,
    surface: "browser" as const, ...scope, targetId: "external:browser:5",
    action: "click" as const, x: 0.2, y: 0.3 };
  await (manager as any).handleSurfaceAction(action);
  expect(router.handleSurfaceAction).toHaveBeenCalledWith(action);
  await manager.closeSurfacesForTurn(scope);
  expect(router.closeSurfacesForTurn).toHaveBeenCalled();
  await manager.closeSession(scope);
  expect(router.closeSession).toHaveBeenCalledWith(scope);
  await manager.close();
  expect(router.closeAll).toHaveBeenCalledOnce();
});

it('routes external uploads through workspace validation and the approval path', async () => {
  const scope = { sessionKey: 'upload', channel: 'projected-session', chatId: 'upload' };
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-external-upload-'));
  const source = path.join(workspace, 'document.txt');
  fs.writeFileSync(source, 'test');
  const claim = { connectionId: 'browser', tabId: 5, browser: 'chrome' as const,
    title: 'Form', url: 'https://example.test/form', claimedAt: 1 };
  const upload = vi.fn(async () => [{ type: 'text', text: '{"uploaded":1}' }]);
  const router = { select: () => claim, upload, closeAll: vi.fn() } as unknown as ExternalBrowserSessionRouter;
  const manager = new BrowserSessionManager({ enabled: true }, {
    desktopManaged: false, externalRouter: router, embeddedBridge: null,
    runtimeLoader: vi.fn(async () => { throw new Error('Playwright should not start'); }),
  });
  try {
    await expect(manager.callTool(scope, 'browser_file_upload', { target: 'ax-1', paths: ['/etc/passwd'] },
      null, { workspace, readonlyRoots: [] })).rejects.toThrow(/outside the trusted workspace/);
    expect(upload).not.toHaveBeenCalled();
    await manager.callTool(scope, 'browser_file_upload', { target: 'ax-1', paths: [source] },
      null, { workspace, readonlyRoots: [] });
    expect(upload).toHaveBeenCalledWith(scope, claim, { target: 'ax-1', paths: [source] },
      expect.any(Function), null);
  } finally { await manager.close(); fs.rmSync(workspace, { recursive: true, force: true }); }
});
