import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubagentManager } from '../../../src/core/agent-runtime/subagent.js';
import { delegateSubagentComputerUse } from '../../../src/core/agent-runtime/subagent-computer-use-context.js';
import { RequestContext, RequestContextStore } from '../../../src/core/agent-runtime/tools/context.js';
import { Tool, type ToolExecutionContext } from '../../../src/core/agent-runtime/tools/base.js';
import { SpawnTool } from '../../../src/core/agent-runtime/tools/spawn.js';
import { LLMResponse, ToolCallRequest } from '../../../src/providers/base.js';
import { activeComputerUseTurnId } from '../../../src/tools/computer-use/surface-preview.js';
import { AgentLoop } from '../../../src/core/agent-runtime/loop.js';
import { InboundMessage } from '../../../src/core/runtime-messages/index.js';

const roots: string[] = [];
const scope = { sessionKey: 'websocket:parallel-child', channel: 'websocket', chatId: 'parallel-child' };

type PendingCall = { request: RequestContext; signal: AbortSignal; release(result?: string): void };
class ControlledComputerUseTool extends Tool {
  calls = new Map<string, PendingCall>();
  private requests = new RequestContextStore();
  get name() { return 'mcp_memmy_computer_use_get_app_state'; }
  get description() { return 'Observe the assigned native window.'; }
  get parameters() { return { type: 'object', properties: { target: { type: 'string' } } }; }
  get supportsSubagentComputerUse() { return true; }
  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<string> {
    const request = this.requests.get()!;
    const signal = context!.abortSignal!;
    return new Promise(resolve => {
      this.calls.set(params.target, { request, signal, release: (result = 'observed') => resolve(result) });
      if (signal.aborted) resolve('cancelled');
      else signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
  }
}

function fixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-subagent-cu-isolation-'));
  roots.push(workspace);
  const tool = new ControlledComputerUseTool();
  const manager = new SubagentManager({ workspace, computerUseTools: () => [tool], provider: {
    generation: { maxTokens: 100 }, getDefaultModel: () => 'test-model',
    chat: vi.fn(async (args: any) => args.messages.at(-1)?.role === 'tool'
      ? new LLMResponse({ content: 'done' })
      : new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: 'observe', name: tool.name,
        arguments: { target: args.messages.find((message: any) => message.role === 'user').content } })] })),
  } });
  manager.announceResult = vi.fn(async () => undefined);
  const parent = new RequestContext({ ...scope, messageId: 'accepted-user-message',
    metadata: { turnId: 'parent-turn', message_id: 'accepted-user-message',
      computerUseInteractive: true, computerUseInteractiveReason: 'interactive-user-message' } });
  const spawn = new SpawnTool({ manager });
  spawn.setContext(parent);
  return { manager, tool, parent, spawn };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('independent Computer Use subtasks', () => {
  it('preserves independent subtasks when their parent turn stops and supports explicit session-wide cancellation', async () => {
    const f = fixture();
    const loop = new AgentLoop({ workspace: f.manager.workspace, provider: f.manager.provider });
    loop.subagents = f.manager;
    let finishParent!: () => void;
    const parentTask = new Promise<void>(resolve => { finishParent = resolve; }) as any;
    parentTask.done = () => false;
    parentTask.cancel = vi.fn(() => { finishParent(); return true; });
    loop.turnSlots.set(scope.sessionKey, [{ turnId: 'parent-turn', state: 'running', dispatchTask: parentTask,
      root: new InboundMessage({ ...scope, content: 'operate both windows', turnSource: { kind: 'gui', channel: 'websocket' } }),
    }] as any);
    await Promise.all([f.spawn.execute({ task: 'parent-child-one' }), f.spawn.execute({ task: 'parent-child-two' })]);
    await vi.waitFor(() => expect(f.tool.calls.size).toBe(2));
    await expect(loop.stopExpectedTurn(scope.sessionKey, 'parent-turn', 'gui')).resolves.toBe('stopped');
    expect(f.manager.getRunningCountBySession(scope.sessionKey)).toBe(2);
    expect([...f.tool.calls.values()].every(call => !call.signal.aborted)).toBe(true);
    await expect(loop.cancelActiveTasks(scope.sessionKey)).resolves.toBe(2);
    expect([...f.tool.calls.values()].every(call => call.signal.aborted)).toBe(true);
    expect(f.manager.getRunningCount()).toBe(0);
  });

  it('keeps two same-chat windows authorized by one user message while stopping only one task', async () => {
    const f = fixture();
    await Promise.all([f.spawn.execute({ task: 'window-one' }), f.spawn.execute({ task: 'window-two' })]);
    await vi.waitFor(() => expect(f.tool.calls.size).toBe(2));
    const first = f.tool.calls.get('window-one')!;
    const second = f.tool.calls.get('window-two')!;
    expect(first.request.messageId).toBe('accepted-user-message');
    expect(second.request.messageId).toBe(first.request.messageId);
    expect(first.request.metadata.turnId).not.toBe(second.request.metadata.turnId);
    expect(first.request.metadata.turnId).not.toBe('parent-turn');
    expect(first.request.metadata.computerUseInteractive).toBe(true);
    expect(second.request.metadata.computerUseInteractive).toBe(true);
    expect(first.signal).not.toBe(second.signal);
    const [firstID] = [...f.manager.taskStatuses].find(([, status]) => status.taskDescription === 'window-one')!;
    await expect(f.manager.cancelTask(firstID, scope.sessionKey)).resolves.toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(f.manager.getRunningCountBySession(scope.sessionKey)).toBe(1);
    expect(activeComputerUseTurnId({ ...scope, turnId: first.request.metadata.turnId })).toBeUndefined();
    expect(activeComputerUseTurnId({ ...scope, turnId: second.request.metadata.turnId })).toBe(second.request.metadata.turnId);
    second.release();
    await Promise.all([...f.manager.runningTasks.values()]);
    expect(f.manager.announceResult).toHaveBeenCalledOnce();
    expect(activeComputerUseTurnId({ ...scope, turnId: second.request.metadata.turnId })).toBeUndefined();
  });

  it('reports one task failure without aborting its running sibling', async () => {
    const f = fixture();
    await Promise.all([f.spawn.execute({ task: 'failed-window' }), f.spawn.execute({ task: 'healthy-window' })]);
    await vi.waitFor(() => expect(f.tool.calls.size).toBe(2));
    const healthy = f.tool.calls.get('healthy-window')!;
    f.tool.calls.get('failed-window')!.release('Error: selected window disappeared');
    await vi.waitFor(() => expect(f.manager.getRunningCount()).toBe(1));
    expect(healthy.signal.aborted).toBe(false);
    expect(activeComputerUseTurnId({ ...scope, turnId: healthy.request.metadata.turnId })).toBe(healthy.request.metadata.turnId);
    expect(f.manager.announceResult).toHaveBeenCalledOnce();
    expect((f.manager.announceResult as any).mock.calls[0][5]).toBe('error');
    healthy.release();
    await Promise.all([...f.manager.runningTasks.values()]);
    expect(f.manager.announceResult).toHaveBeenCalledTimes(2);
  });

  it.each(['background', 'forged-grant', 'wrong-chat'] as const)('does not delegate native authorization from %s', async kind => {
    const f = fixture();
    if (kind === 'background') {
      f.spawn.setContext(new RequestContext({ ...f.parent,
        metadata: { ...f.parent.metadata, computerUseInteractive: false, computerUseInteractiveReason: 'background-source' } }));
      await f.spawn.execute({ task: kind });
    } else {
      await f.manager.spawn({ task: kind, originChannel: scope.channel,
        originChatId: kind === 'wrong-chat' ? 'other-chat' : scope.chatId, sessionKey: scope.sessionKey,
        originMessageId: f.parent.messageId,
        computerUseAuthorization: kind === 'forged-grant' ? { computerUseInteractive: true }
          : delegateSubagentComputerUse(f.parent) });
    }
    await vi.waitFor(() => expect(f.tool.calls.size).toBe(1));
    const call = f.tool.calls.get(kind)!;
    expect(call.request.messageId).toBeNull();
    expect(call.request.metadata.computerUseInteractive).toBe(false);
    expect(activeComputerUseTurnId({ sessionKey: call.request.sessionKey!, channel: call.request.channel!,
      chatId: call.request.chatId!, turnId: call.request.metadata.turnId })).toBeUndefined();
    call.release();
    await Promise.all([...f.manager.runningTasks.values()]);
  });

  it('loads only managed Computer Use wrappers from the main registry for a spawned task', async () => {
    const f = fixture();
    const loop = new AgentLoop({ workspace: f.manager.workspace, provider: f.manager.provider });
    loop.tools.register(f.tool);
    const extra = new ControlledComputerUseTool();
    Object.defineProperties(extra, { name: { value: 'mcp_unrelated_service' }, supportsSubagentComputerUse: { value: false } });
    loop.tools.register(extra);
    const captured: any[] = [];
    loop.subagents.runner.run = vi.fn(async spec => {
      captured.push(spec);
      return { stopReason: 'completed', finalContent: 'done', toolEvents: [] } as any;
    });
    await loop.subagents.spawn({ task: 'child', ...scope });
    await Promise.all([...loop.subagents.runningTasks.values()]);
    expect(captured[0].tools.get(f.tool.name)).toBe(f.tool);
    expect(captured[0].tools.has(extra.name)).toBe(false);
    expect(captured[0].tools.has('browser_click')).toBe(false);
    expect(captured[0].tools.has('spawn')).toBe(false);
  });
});
