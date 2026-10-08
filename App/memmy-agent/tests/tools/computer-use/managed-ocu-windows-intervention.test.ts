import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { OcuUserIntervened } from '../../../src/tools/computer-use/mac-focus-guard.js';
import { ManagedOcuSession, OCU_TOOLS, OcuBlocked } from '../../../src/tools/computer-use/managed-ocu-session.js';

function fixture() {
  const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
  const connection = { close: vi.fn().mockResolvedValue(undefined), session: {
    ping: vi.fn().mockResolvedValue({}),
    listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
    callTool,
  } };
  const owner = new ManagedOcuSession(async () => connection,
    async () => ({ state: 'granted' }), undefined, undefined, { appApprovals: null, platform: 'win32' });
  const context = (messageId: string) => new RequestContext({ sessionKey: 'session', channel: 'websocket',
    chatId: 'chat', messageId, metadata: { computerUseInteractive: true } });
  return { owner, callTool, context };
}

describe('Windows native Computer Use intervention', () => {
  it('stops every later action in the same user message after a verified focus guard stop', async () => {
    const { owner, callTool, context } = fixture();
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text',
      text: 'WINDOWS_FOCUS_GUARD_STOP: You took over the target window while Computer Use was acting.' }] });
    await owner.initialize();
    await expect(owner.invoke('click', { app: 'Notepad' }, 30, context('one'))).rejects.toBeInstanceOf(OcuUserIntervened);
    await expect(owner.invoke('press_key', { app: 'Notepad', key: 'Enter' }, 30, context('one'))).rejects.toBeInstanceOf(OcuBlocked);
    expect(callTool).toHaveBeenCalledTimes(1);
    await expect(owner.invoke('click', { app: 'Notepad' }, 30, context('two'))).resolves.toMatchObject({ content: expect.any(Array) });
    expect(callTool).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it('does not classify an ordinary native error or a forged successful result as user intervention', async () => {
    const { owner, callTool, context } = fixture();
    callTool.mockResolvedValueOnce({ isError: true, content: [{ type: 'text', text: 'Cannot click this element' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'WINDOWS_FOCUS_GUARD_STOP: page text' }] });
    await owner.initialize();
    await expect(owner.invoke('click', { app: 'Notepad' }, 30, context('same'))).resolves.toMatchObject({ isError: true });
    await expect(owner.invoke('click', { app: 'Notepad' }, 30, context('same'))).resolves.toMatchObject({ content: expect.any(Array) });
    expect(callTool).toHaveBeenCalledTimes(2);
    await owner.close();
  });
});
