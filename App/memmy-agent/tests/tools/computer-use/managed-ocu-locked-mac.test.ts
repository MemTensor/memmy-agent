import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { OcuUserIntervened } from '../../../src/tools/computer-use/mac-focus-guard.js';

vi.mock('../../../src/tools/computer-use/locked-mac-use.js', () => ({
  beginLockedMacAction: vi.fn().mockResolvedValue({ turnId: '["session","websocket","chat","message"]',
    leaseId: '12345678-1234-1234-1234-123456789abc' }),
  releaseLockedMacAction: vi.fn().mockRejectedValue(new OcuUserIntervened('user took over')),
}));

import { ManagedOcuSession, OCU_TOOLS, OcuBlocked } from '../../../src/tools/computer-use/managed-ocu-session.js';

describe('locked Mac user intervention in a managed Computer Use turn', () => {
  it('stops the current message after release reports physical takeover', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    const connection = { close: vi.fn().mockResolvedValue(undefined), session: {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
      callTool,
    } };
    const owner = new ManagedOcuSession(async () => connection,
      async () => ({ state: 'granted' }), undefined, undefined, { appApprovals: null });
    const context = new RequestContext({ sessionKey: 'session', channel: 'websocket',
      chatId: 'chat', messageId: 'message', metadata: { computerUseInteractive: true } });
    await owner.initialize();
    await expect(owner.invoke('click', { app: 'Calculator' }, 30, context)).rejects.toBeInstanceOf(OcuUserIntervened);
    await expect(owner.invoke('click', { app: 'Calculator' }, 30, context)).rejects.toBeInstanceOf(OcuBlocked);
    expect(callTool).toHaveBeenCalledTimes(1);
    await owner.close();
  });
});
