import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../../../src/config/schema.js';
import { AgentLoop } from '../../../src/core/agent-runtime/loop.js';
import { MCPToolWrapper } from '../../../src/core/agent-runtime/tools/mcp.js';
import { InboundMessage, MessageBus } from '../../../src/core/runtime-messages/index.js';
import { SessionManager } from '../../../src/core/session/manager.js';
import { GOAL_TURN_INBOX_KEY } from '../../../src/core/session/goal-state.js';
import { WebSocketChannel } from '../../../src/integrations/channels/websocket.js';
import { LLMResponse, ToolCallRequest } from '../../../src/providers/base.js';
import { ManagedOcuSession, OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { NativeAppApprovalGate, NativeAppApprovalStore } from '../../../src/tools/computer-use/native-app-approvals.js';

const roots: string[] = [];
const owners: ManagedOcuSession[] = [];
const requestID = '11111111-1111-4111-8111-111111111111';

function fixture(platform: 'darwin' | 'win32' = 'darwin') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memmy-cu-request-context-'));
  roots.push(root);
  vi.stubEnv('MEMMY_AGENT_DATA_DIR', path.join(root, 'data'));
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '0');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const bus = new MessageBus();
  const sessions = new SessionManager(path.join(root, 'sessions'));
  const channel = new WebSocketChannel({ enabled: true, allowFrom: ['*'], websocketRequiresToken: false }, bus,
    { sessionManager: sessions, workspacePath: workspace });
  channel.hydrateAfterSubscribe = vi.fn(async () => undefined) as any;
  const responses: LLMResponse[] = [];
  const provider = {
    generation: { maxTokens: 100 }, getDefaultModel: () => 'test-model',
    chat: vi.fn(async () => responses.shift() ?? new LLMResponse({ content: 'done' })),
  };
  const loop = new AgentLoop({ bus, sessionManager: sessions, sessionDir: sessions.root,
    workspace, provider, model: 'test-model', config: new Config({ tools: { mcpServers: {} }, memmyMemory: { enabled: false } }) });
  vi.spyOn(loop, 'initializeRuntimeTools').mockResolvedValue(undefined);
  const native = {
    ping: vi.fn(async () => ({})),
    notifyTurnEnded: vi.fn(async () => undefined),
    listTools: vi.fn(async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) })),
    callTool: vi.fn(async (name: string, _args: Record<string, any>, _timeout: number, _signal?: AbortSignal) =>
      ({ content: [{ type: 'text', text: name === 'list_apps'
        ? platform === 'win32' ? 'WPS Office -- wps [running, pid=4812, window=Presentation]'
          : 'WPS Office — com.kingsoft.wpsoffice.mac [running]' : 'observed WPS' }] })),
  };
  const ask = vi.fn(async () => 'allow-once' as const);
  const gate = new NativeAppApprovalGate(new NativeAppApprovalStore(path.join(root, 'approvals.json')), ask);
  const owner = new ManagedOcuSession(async () => ({ session: native, close: async () => undefined }),
    async () => ({ state: 'granted' }), undefined, undefined, { platform, appApprovals: gate });
  owners.push(owner);
  const invoke = vi.spyOn(owner, 'invoke');
  const tool = new MCPToolWrapper(null, 'memmy_computer_use', { name: 'get_app_state', inputSchema:
    { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } }, 30, undefined, owner);
  loop.tools.register(tool);
  async function inbound(id = requestID, extra: Record<string, any> = {}) {
    await channel.dispatchEnvelope({ send: vi.fn(async () => undefined), remoteAddress: ['127.0.0.1'] }, 'real-user', {
      type: 'message', chat_id: 'cu-context', content: 'open WPS', webui: true,
      client_request_id: id, target: { kind: 'standalone' }, ...extra,
    });
    expect(bus.inboundSize).toBe(1);
    return bus.consumeInbound();
  }
  async function dispatch(message: InboundMessage) {
    responses.push(new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: 'observe', name: tool.name,
      arguments: { app: 'WPS Office' } })] }), new LLMResponse({ content: 'done' }));
    await loop.dispatchMessage(message);
  }
  return { root, loop, bus, native, owner, invoke, ask, tool, responses, inbound, dispatch };
}

afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('real WebSocket user → asynchronous progress hook → managed Computer Use', () => {
  it('closes its native PiP before awaiting unrelated browser cleanup at task completion', async () => {
    const f = fixture();
    vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
    const send = vi.fn();
    vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
    const originalCall = f.native.callTool.getMockImplementation()!;
    f.native.callTool.mockImplementation(async (name, args, timeout, signal) => name === 'list_apps'
      ? originalCall(name, args, timeout, signal)
      : { content: [{ type: 'text', text: 'observed WPS' }],
        _meta: { memmyComputerUse: { targetWindowID: 52, pid: 4812 } } });
    let finishBrowser!: () => void;
    const browserCleanup = new Promise<void>(resolve => { finishBrowser = resolve; });
    const browser = vi.spyOn((f.loop as any).browserSessionManager, 'closeSurfacesForTurn')
      .mockImplementation(() => browserCleanup);
    const pending = f.dispatch(await f.inbound());
    try {
      await vi.waitFor(() => expect(browser).toHaveBeenCalledOnce(), { timeout: 10_000 });
      const surfaces = send.mock.calls.map(call => call[0]).filter(message => message.surface === 'computer');
      expect(surfaces.map(message => message.type)).toEqual([
        'memmy:computer-use-surface:update', 'memmy:computer-use-surface:close',
      ]);
      expect(surfaces[1]).toMatchObject({ turnId: surfaces[0].turnId, targetId: surfaces[0].targetId });
      expect(surfaces[0].turnId).toEqual(expect.any(String));
      expect(f.native.notifyTurnEnded).toHaveBeenCalledOnce();
    } finally { finishBrowser(); await pending; }
  });

  it.each(['user', 'background'])('enforces the Windows approval and dispatch boundary for a %s request', async kind => {
    const f = fixture('win32');
    const user = await f.inbound();
    const message = kind === 'user' ? user : new InboundMessage({ channel: user.channel,
      chatId: user.chatId, senderId: 'goal-runtime', content: 'continue automatically',
      metadata: { ...user.metadata, computerUseInteractive: true }, sessionKey: user.sessionKey,
      turnSource: user.turnSource });
    await f.dispatch(message);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls[0][3]).toMatchObject({ messageId: requestID,
      metadata: { computerUseInteractive: kind === 'user' } });
    if (kind === 'background') {
      expect(f.native.callTool).not.toHaveBeenCalled();
      expect(f.ask).not.toHaveBeenCalled();
      return;
    }
    expect(f.ask).toHaveBeenCalledExactlyOnceWith({ platform: 'win32', appId: 'wps', displayName: 'WPS Office' });
    expect(f.native.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state']);
    const dispatch = f.native.callTool.mock.calls[1];
    expect(dispatch[1]).toMatchObject({ app: '4812', _host_deadline_epoch_ms: expect.any(Number) });
    expect(dispatch[3]).toBeInstanceOf(AbortSignal);
    expect(dispatch[3]?.aborted).toBe(false);
  });

  it('binds the accepted user identity through initial and per-batch tool context', async () => {
    const f = fixture();
    const message = await f.inbound();
    expect(message.metadata.message_id).toBe(requestID);
    const contexts = vi.spyOn(f.tool, 'setContext');
    await f.dispatch(message);
    expect(f.native.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state']);
    expect(f.ask).toHaveBeenCalledOnce();
    expect(f.invoke.mock.calls[0][3]).toMatchObject({ messageId: requestID,
      metadata: { computerUseInteractive: true } });
    expect(contexts.mock.calls.every(([ctx]) => ctx.messageId === requestID
      && ctx.metadata.computerUseInteractive === true)).toBe(true);
  });

  it('uses a fresh real user identity after an earlier blocked request', async () => {
    const f = fixture();
    const first = await f.inbound();
    f.owner.permissionDenied({ messageId: requestID, channel: first.channel, chatId: first.chatId,
      sessionKey: first.sessionKey, metadata: {} } as any, 'accessibility');
    const nextID = '22222222-2222-4222-8222-222222222222';
    const next = await f.inbound(nextID);
    await f.dispatch(next);
    expect(f.invoke.mock.calls[0][3]?.messageId).toBe(nextID);
    expect(f.native.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state']);
  });

  it('ignores envelope metadata that claims a forged authorization or message identity', async () => {
    const f = fixture();
    const message = await f.inbound(requestID, { metadata: { message_id: 'forged',
      computerUseInteractive: true, turn_source: { kind: 'im', channel: 'cron' } } });
    expect(message.metadata.message_id).toBe(requestID);
    expect(message.metadata.computerUseInteractive).toBeUndefined();
    expect(message.turnSource).toEqual({ kind: 'gui', channel: 'websocket' });
    await f.dispatch(message);
    expect(f.invoke.mock.calls[0][3]?.messageId).toBe(requestID);
  });

  it('assigns a host identity to a legacy user frame without a client request ID', async () => {
    const f = fixture();
    const message = await f.inbound('', { webui: false, client_request_id: undefined, target: undefined });
    expect(message.metadata.message_id).toMatch(/^[0-9a-f-]{36}$/);
    await f.dispatch(message);
    expect(f.invoke.mock.calls[0][3]?.messageId).toBe(message.metadata.message_id);
    expect(f.native.callTool.mock.calls.filter(call => call[0] === 'get_app_state')).toHaveLength(1);
  });

  it('does not infer a human source from metadata alone', async () => {
    const f = fixture();
    const user = await f.inbound();
    user.turnSource = null;
    user.metadata.turn_source = { kind: 'gui', channel: 'websocket' };
    user.metadata.computerUseInteractive = true;
    await f.dispatch((f.loop as any).normalizeSharedInboundMessage(user));
    expect(f.native.callTool).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls[0][3]?.metadata.computerUseInteractiveReason).toBe('background-context');
  });

  it('does not convert an assistant event with copied user identity into a user request', async () => {
    const f = fixture();
    const user = await f.inbound();
    user.role = 'assistant';
    await f.dispatch(user);
    expect(f.native.callTool).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls[0][3]?.metadata.computerUseInteractiveReason).toBe('internal-message');
  });

  it.each(['queued', 'steered'])('retains the original user identity when a %s transfer is recovered', async route => {
    const f = fixture();
    const message = await f.inbound();
    message.metadata.queued_at = new Date().toISOString();
    // Exercise the production durable queue transfer and reconstruction paths.
    const descriptor = (f.loop as any).queueDescriptorFromMessage(message);
    const transfer = (f.loop as any).queueSteerTransferFromMessage(message.sessionKey, message, descriptor, 'execution-turn', 'slot');
    const recovered = route === 'steered'
      ? (f.loop as any).messageFromQueueSteerTransfer(transfer, 'execution-turn')
      : (f.loop as any).recoveredQueueMessage(transfer, descriptor.queuedAt);
    await f.dispatch(recovered);
    expect(f.invoke.mock.calls[0][3]).toMatchObject({ messageId: requestID,
      metadata: { computerUseInteractive: true } });
    expect(f.native.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state']);
  });

  it('retains an accepted GUI user identity without borrowing its generated execution turn ID', async () => {
    const f = fixture();
    const message = await f.inbound();
    delete message.metadata.message_id;
    message.metadata.turnId = 'generated-execution-turn';
    await f.dispatch(message);
    expect(f.invoke.mock.calls[0][3]?.messageId).toBe(requestID);
    expect(f.invoke.mock.calls[0][3]?.metadata.computerUseInteractive).toBe(true);
  });

  it.each(['metadata-only', 'assistant', 'valid-user', 'old-unproven'])('keeps native permission policy through the actual goal inbox roundtrip: %s', async kind => {
    const f = fixture();
    // Materialize the real host workspace/session binding before durable enqueue.
    await f.loop.dispatchMessage(await f.inbound('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
    const message = await f.inbound(requestID, { target: undefined });
    message.metadata.computerUseInteractive = true;
    message.metadata.computerUseMessageRole = 'user';
    if (kind === 'metadata-only') {
      message.turnSource = null;
      message.metadata.turn_source = { kind: 'gui', channel: 'websocket' };
    }
    if (kind === 'assistant') message.role = 'assistant';
    const entry = await f.loop.goalRuntime.enqueueUserMessage(message.sessionKey, message);
    if (kind === 'metadata-only' || kind === 'assistant') expect(entry.metadata.computerUseInteractive).toBe(false);
    if (kind === 'valid-user') expect(entry.metadata.computerUseInteractive).toBeUndefined();
    if (kind === 'old-unproven') {
      const session = f.loop.sessions.getOrCreate(message.sessionKey);
      const stored = (session.metadata[GOAL_TURN_INBOX_KEY] as any[])[0];
      delete stored.metadata.computerUseMessageRole;
      delete stored.metadata.computerUseInteractive;
      f.loop.sessions.save(session, { fsync: true });
    }
    expect(f.loop.goalRuntime.inbox(message.sessionKey)).toHaveLength(1);
    expect({ active: (f.loop as any).activeTasks.get(message.sessionKey)?.length ?? 0,
      lease: f.loop.goalRuntime.hasGoalLease(message.sessionKey), reservation: f.loop.goalRuntime.hasWorkReservation(message.sessionKey) })
      .toEqual({ active: 0, lease: false, reservation: false });
    await (f.loop as any).dispatchNextGoalWork(message.sessionKey);
    expect(f.bus.inboundSize).toBe(1);
    const recovered = await f.bus.consumeInbound();
    expect(recovered.metadata.message_id).toBe(requestID);
    if (kind === 'assistant') expect(recovered.role).toBe('assistant');
    await f.dispatch(recovered);
    if (kind === 'valid-user') {
      expect(f.native.callTool.mock.calls.map(call => call[0])).toEqual(['list_apps', 'get_app_state']);
      expect(f.invoke.mock.calls[0][3]?.metadata.computerUseInteractive).toBe(true);
    } else {
      expect(f.native.callTool).not.toHaveBeenCalled();
      expect(f.ask).not.toHaveBeenCalled();
      expect(f.invoke.mock.calls[0][3]?.metadata.computerUseInteractive).toBe(false);
    }
  });

  it.each(['queued', 'steered'])('refuses native access from an older unproven %s transfer', async route => {
    const f = fixture();
    const message = await f.inbound();
    message.metadata.queued_at = new Date().toISOString();
    const descriptor = (f.loop as any).queueDescriptorFromMessage(message);
    const transfer = (f.loop as any).queueSteerTransferFromMessage(message.sessionKey, message, descriptor, 'execution-turn', 'slot');
    delete transfer.messageFields.metadata.computerUseMessageRole;
    delete transfer.messageFields.metadata.computerUseInteractive;
    const recovered = route === 'steered' ? (f.loop as any).messageFromQueueSteerTransfer(transfer, 'execution-turn')
      : (f.loop as any).recoveredQueueMessage(transfer, descriptor.queuedAt);
    await f.dispatch(recovered);
    expect(f.native.callTool).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls[0][3]?.metadata.computerUseInteractive).toBe(false);
  });

  it('refuses a generated turn ID when there is no accepted user message identity', async () => {
    const f = fixture();
    const message = await f.inbound();
    delete message.metadata.message_id;
    delete message.metadata.client_request_id;
    message.metadata.turnId = 'generated-execution-turn';
    message.metadata.computerUseInteractive = true;
    await f.dispatch(message);
    expect(f.native.callTool).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls[0][3]).toMatchObject({ messageId: null,
      metadata: { computerUseInteractive: false, computerUseInteractiveReason: 'user-message-id-missing' } });
  });

  it('switches the next tool batch to a real user steer even after the original message becomes blocked', async () => {
    const f = fixture();
    const first = await f.inbound();
    const nextID = '22222222-2222-4222-8222-222222222222';
    const steer = await f.inbound(nextID);
    steer.turnAdmission = 'steer';
    let observations = 0;
    f.native.callTool.mockImplementation(async (name: string) => {
      if (name === 'get_app_state' && ++observations === 1) {
        f.owner.permissionDenied(f.invoke.mock.calls[0][3]!, 'accessibility');
        (f.loop as any).pendingQueues.get(first.sessionKey).put(steer);
      }
      return { content: [{ type: 'text', text: name === 'list_apps'
        ? 'WPS Office — com.kingsoft.wpsoffice.mac [running]' : 'observed WPS' }] };
    });
    f.responses.push(...[1, 2].map(n => new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: `observe-${n}`,
      name: f.tool.name, arguments: { app: 'WPS Office' } })] })), new LLMResponse({ content: 'done' }));
    await f.loop.dispatchMessage(first);
    expect(f.invoke.mock.calls.map(call => call[3]?.messageId)).toEqual([requestID, nextID]);
    expect(observations).toBe(2);
    expect(f.ask).toHaveBeenCalledTimes(2);
  });

  it('keeps parallel chats isolated while they share the MCP wrapper and await progress callbacks', async () => {
    const f = fixture();
    const first = await f.inbound();
    const nextID = '22222222-2222-4222-8222-222222222222';
    const second = await f.inbound(nextID, { chat_id: 'other-cu-context' });
    (f.loop.provider as any).chat.mockImplementation(async (args: any) => {
      await Promise.resolve();
      return args.messages.at(-1)?.role === 'tool' ? new LLMResponse({ content: 'done' })
        : new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: 'observe', name: f.tool.name,
          arguments: { app: 'WPS Office' } })] });
    });
    await Promise.all([f.loop.dispatchMessage(first), f.loop.dispatchMessage(second)]);
    expect(f.invoke.mock.calls.map(call => [call[3]?.chatId, call[3]?.messageId]).sort()).toEqual([
      ['cu-context', requestID], ['other-cu-context', nextID],
    ]);
    expect(f.native.callTool.mock.calls.filter(call => call[0] === 'get_app_state')).toHaveLength(2);
  });

  it('does not treat an automatic pending notice as a fresh user retry of a blocked message', async () => {
    const f = fixture();
    const first = await f.inbound();
    const copied = await f.inbound('22222222-2222-4222-8222-222222222222');
    copied.senderId = 'goal-runtime';
    copied.metadata.computerUseInteractive = true;
    let observations = 0;
    f.native.callTool.mockImplementation(async (name: string) => {
      if (name === 'get_app_state' && ++observations === 1) {
        f.owner.permissionDenied(f.invoke.mock.calls[0][3]!, 'accessibility');
        (f.loop as any).pendingQueues.get(first.sessionKey).put(copied);
      }
      return { content: [{ type: 'text', text: name === 'list_apps'
        ? 'WPS Office — com.kingsoft.wpsoffice.mac [running]' : 'observed WPS' }] };
    });
    f.responses.push(...[1, 2].map(n => new LLMResponse({ content: null, toolCalls: [new ToolCallRequest({ id: `observe-${n}`,
      name: f.tool.name, arguments: { app: 'WPS Office' } })] })), new LLMResponse({ content: 'done' }));
    await f.loop.dispatchMessage(first);
    expect(f.invoke.mock.calls.map(call => call[3]?.messageId)).toEqual([requestID, requestID]);
    expect(observations).toBe(1);
    expect(f.ask).toHaveBeenCalledOnce();
  });

  it.each(['internal', 'system', 'subagent', 'cron'])('does not grant app access to %s despite copied user metadata', async kind => {
    const f = fixture();
    const user = await f.inbound();
    const background = new InboundMessage({ channel: kind === 'cron' ? 'cron' : user.channel,
      chatId: user.chatId, senderId: kind === 'internal' ? 'real-user' : kind,
      content: 'continue automatically', metadata: { ...user.metadata, computerUseInteractive: true },
      sessionKey: user.sessionKey, turnSource: user.turnSource,
      ...(kind === 'internal' ? { internal: { kind: 'goal_continuation' as const, goalId: 'g', goalUpdatedAt: new Date().toISOString() } } : {}) });
    await f.dispatch(background);
    expect(f.native.callTool).not.toHaveBeenCalled();
    expect(f.ask).not.toHaveBeenCalled();
    expect(f.invoke.mock.calls.every(call => call[3]?.metadata.computerUseInteractive === false)).toBe(true);
  });
});
