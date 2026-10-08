import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { NativeAxDiffPresenter } from '../../../src/tools/computer-use/native-ax-diff.js';

const context = new RequestContext({ sessionKey: 'session', channel: 'websocket', chatId: 'chat', messageId: 'message' });
const tree = (changed = 0, count = 35) => Array.from({ length: count }, (_, index) =>
  `${'\t'.repeat(index ? 1 : 0)}${index} button Item ${index}${index === changed ? ' changed' : ''} Secondary Actions: Press`).join('\n');
const state = (body: string, app = 'com.example.Editor', pid = 321, title = 'Document') =>
  `App=${app} (pid ${pid})\nWindow: "${title}", App: Editor.\n${body}\n\nThe focused UI element is 2 button.`;
const result = (text: string, windowId = 77) => ({
  content: [{ type: 'text', text }, { type: 'image', data: 'image-bytes', mimeType: 'image/png' }],
  _meta: { memmyComputerUse: { targetWindowID: windowId, pid: 321 } },
});
const delivered = (text: string) => [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,test' } }];
const show = (value: any) => value[0].text as string;
const showRaw = (value: ReturnType<typeof result>) => value.content[0]!.text!;

describe('Mac native AX model output', () => {
  it('keeps get_app_state full and emits a shorter exact action patch without changing native content', () => {
    const presenter = new NativeAxDiffPresenter();
    const first = result(state(tree(-1)));
    const second = result(state(tree(8)));
    const firstOutput = delivered(state(tree(-1)));
    const secondOutput = delivered(state(tree(8)));
    expect(presenter.present('get_app_state', { app: 'Editor' }, first, firstOutput, context, 1, 1, 1)).toBe(firstOutput);
    const output = presenter.present('click', { app: 'Editor' }, second, secondOutput, context, 2, 2, 1);
    expect(show(output)).toContain('+ \t8 button Item 8 changed');
    expect(show(output)).toContain('- \t8 button Item 8 Secondary Actions: Press');
    expect(show(output)).not.toContain('button Item 30');
    expect(show(secondOutput)).toContain('button Item 30');
    expect(output[1]).toBe(secondOutput[1]);
    expect(second._meta.memmyComputerUse.targetWindowID).toBe(77);
    expect(presenter.present('get_app_state', { app: 'Editor' }, second, secondOutput, context, 3, 3, 1)).toBe(secondOutput);
  });

  it('falls back when indices shift enough to make the patch long', () => {
    const presenter = new NativeAxDiffPresenter();
    const before = result(state(tree(-1)));
    const after = result(state(Array.from({ length: 35 }, (_, index) =>
      `${index} button New item ${index} Secondary Actions: Press`).join('\n')));
    presenter.present('get_app_state', { app: 'Editor' }, before, delivered(showRaw(before)), context, 1, 1, 1);
    const afterOutput = delivered(showRaw(after));
    expect(presenter.present('click', { app: 'Editor' }, after, afterOutput, context, 2, 2, 1)).toBe(afterOutput);
  });

  it('keeps text-only, unindexed and reconnected results full', () => {
    const presenter = new NativeAxDiffPresenter();
    const before = result(state(tree(-1)));
    const after = result(state(tree(8)));
    presenter.present('get_app_state', { app: 'Editor' }, before, delivered(showRaw(before)), context, 1, 1, 1);
    const textOnly = showRaw(after);
    expect(presenter.present('click', { app: 'Editor' }, after, textOnly, context, 2, 2, 1)).toBe(textOnly);
    presenter.present('get_app_state', { app: 'Editor' }, before, delivered(showRaw(before)), context, 3, 3, 1);
    const reconnected = delivered(showRaw(after));
    expect(presenter.present('click', { app: 'Editor' }, after, reconnected, context, 4, 4, 2)).toBe(reconnected);
    const unindexed = result(state(`${tree(-1)}\nextra row summary`));
    const unindexedOutput = delivered(showRaw(unindexed));
    expect(presenter.present('get_app_state', { app: 'Editor' }, unindexed, unindexedOutput, context, 5, 5, 2)).toBe(unindexedOutput);
    const last = delivered(showRaw(after));
    expect(presenter.present('click', { app: 'Editor' }, after, last, context, 6, 6, 2)).toBe(last);
  });

  it('rejects hidden calls, app or window switches, errors, and untrusted identity', () => {
    const presenter = new NativeAxDiffPresenter();
    const before = result(state(tree(-1)));
    const after = result(state(tree(8)));
    presenter.present('get_app_state', { app: 'Editor' }, before, delivered(showRaw(before)), context, 1, 1, 1);
    const afterOutput = delivered(showRaw(after));
    expect(presenter.present('click', { app: 'Editor' }, after, afterOutput, context, 3, 3, 1)).toBe(afterOutput);
    const next = result(state(tree(9)));
    expect(show(presenter.present('click', { app: 'Editor' }, next, delivered(showRaw(next)), context, 4, 4, 1))).toContain('AX tree changes');
    expect(presenter.present('click', { app: 'Other' }, after, afterOutput, context, 5, 5, 1)).toBe(afterOutput);
    const newWindow = result(state(tree(9)), 78);
    const newWindowOutput = delivered(showRaw(newWindow));
    expect(presenter.present('click', { app: 'Other' }, newWindow, newWindowOutput, context, 6, 6, 1)).toBe(newWindowOutput);
    const error = { ...after, isError: true };
    expect(presenter.present('click', { app: 'Other' }, error, afterOutput, context, 7, 7, 1)).toBe(afterOutput);
    expect(presenter.present('click', { app: 'Other' }, after, afterOutput, context, 8, 8, 1)).toBe(afterOutput);
    expect(presenter.present('get_app_state', { app: 'Editor' }, before, delivered(showRaw(before)), null, 9, 9, 1)).toBeTruthy();
  });

  it('shares the model-visible baseline between tool wrappers and invalidates it after a surface call', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pXcAAAAASUVORK5CYII=';
    const imageResult = (text: string) => ({
      content: [{ type: 'text', text }, { type: 'image', data: png, mimeType: 'image/png' }],
      _meta: { memmyComputerUse: { targetWindowID: 77, pid: 321 } },
    });
    const states = [imageResult(state(tree(-1))), imageResult(state(tree(7))),
      imageResult(state(tree(8))), imageResult(state(tree(9)))];
    const session = {
      ping: vi.fn().mockResolvedValue({}),
      listTools: vi.fn().mockResolvedValue({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
      callTool: vi.fn(async () => states.shift()),
    };
    const owner = new ManagedOcuSession(async () => ({ session, close: async () => {} }),
      async () => ({ state: 'granted' }), undefined, undefined, { platform: 'darwin', appApprovals: null });
    await owner.initialize();
    const stateTool = new MCPToolWrapper(session, 'memmy_computer_use', { name: 'get_app_state' }, 30, undefined, owner);
    const clickTool = new MCPToolWrapper(session, 'memmy_computer_use', { name: 'click' }, 30, undefined, owner);
    stateTool.setContext(context);
    clickTool.setContext(context);
    expect(show(await stateTool.execute({ app: 'Editor' }))).toContain('button Item 30');
    const compact = await clickTool.execute({ app: 'Editor', element_index: '7' });
    expect(show(compact)).toContain('AX tree changes');
    expect(show(compact)).not.toContain('button Item 30');
    await owner.invoke('get_app_state', { app: 'Editor' }, 30, context); // Surface result is not shown to the model.
    const output = await clickTool.execute({ app: 'Editor', element_index: '9' });
    expect(show(output)).toContain('button Item 30');
    await owner.close();
  });
});
