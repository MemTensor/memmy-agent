import { afterEach, expect, it, vi } from 'vitest';
import { connectMcpServers, MCPToolWrapper, setMcpRuntimeForTest } from '../../../src/core/agent-runtime/tools/mcp.js';
import { RequestContext } from '../../../src/core/agent-runtime/tools/context.js';
import { ToolRegistry } from '../../../src/core/agent-runtime/tools/registry.js';
import { OCU_TOOLS } from '../../../src/tools/computer-use/managed-ocu-session.js';
import { closeNativeSurfacesForTurn } from '../../../src/tools/computer-use/surface-preview.js';
import { stopOwnedNativeAgent } from '../../../src/tools/computer-use/native-agent-lifecycle.js';

vi.mock('../../../src/tools/computer-use/open-computer-use-binary.js', async original => ({
  ...await original<typeof import('../../../src/tools/computer-use/open-computer-use-binary.js')>(),
  resolveOpenComputerUseCommand: () => '/fixture/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse',
  managedOcuEnvironment: () => ({ OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE: 'memmy:/fixture/Memmy Computer Use.app',
    MEMMY_LOCKED_MAC_USE_ENABLED: '0' }),
}));
vi.mock('../../../src/tools/computer-use/native-agent-lifecycle.js', () => ({ stopOwnedNativeAgent: vi.fn(async () => undefined) }));
vi.mock('../../../src/tools/computer-use/native-app-approvals.js', async original => ({
  ...await original<typeof import('../../../src/tools/computer-use/native-app-approvals.js')>(), nativeAppApprovalGate: null,
}));
vi.mock('../../../src/tools/computer-use/mac-focus-guard.js', async original => ({
  ...await original<typeof import('../../../src/tools/computer-use/mac-focus-guard.js')>(),
  withMacFocusGuard: async (_app: string, _name: string, run: () => Promise<any>) => run(),
}));

afterEach(() => {
  setMcpRuntimeForTest(null); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

function nativeRuntime(launched: any[], sessions: Array<{ callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>) {
  return {
    StdioServerParameters: class { constructor(init: any) { Object.assign(this, init); } },
    stdioClient: async (params: any) => { launched.push(params); return [launched.length - 1, null]; },
    ClientSession: class {
      constructor(index: any) {
        let revision = 0;
        const session = {
          enter: async () => session, initialize: async () => undefined, ping: async () => ({}),
          listTools: async () => ({ tools: [...OCU_TOOLS].map(name => ({ name, inputSchema: {} })) }),
          callTool: vi.fn(async (_name: string, args: any) => ({ content: [{ type: 'text', text: 'state' }],
            _meta: { memmyComputerUse: { pid: 20, targetWindowID: args.window_id ?? 52,
              observationID: `worker-${index}-${++revision}` } } })),
          close: vi.fn(async () => undefined),
        };
        sessions.push(session);
        return session;
      }
    },
    sseClient: async () => { throw new Error('unused'); },
    streamableHttpClient: async () => { throw new Error('unused'); },
  };
}

it.each(['darwin', 'win32'] as const)('the actual %s MCP factory gives same-chat tasks distinct native connections and cleanup', async platform => {
  const child = Object.create(process);
  Object.defineProperty(child, 'platform', { value: platform });
  vi.stubGlobal('process', child);
  vi.stubEnv('MEMMY_DESKTOP_MANAGED_GATEWAY', '1');
  const launched: any[] = [];
  const sessions: Array<{ callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
  setMcpRuntimeForTest(nativeRuntime(launched, sessions));
  const registry = new ToolRegistry();
  const stacks = await connectMcpServers({ memmy_computer_use: { command: 'open-computer-use', args: ['mcp'] } }, registry);
  expect(registry.size).toBe(OCU_TOOLS.size);
  const read = registry.get('mcp_memmy_computer_use_get_app_state') as MCPToolWrapper;
  const scope = { sessionKey: `factory-session-${platform}`, channel: 'websocket', chatId: 'factory-chat' };
  const first = { ...scope, turnId: 'one' }, second = { ...scope, turnId: 'two' };
  const context = (turnId: string) => new RequestContext({ ...scope, messageId: 'shared-user', metadata: {
    turnId, computerUseInteractive: true,
  } });
  try {
    read.setContext(context('one')); await read.execute({ app: 'WPS', window_id: 52 });
    let release!: (result: any) => void;
    sessions[1].callTool.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const waiting = read.execute({ app: 'WPS', window_id: 52 });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    read.setContext(context('two')); await read.execute({ app: 'WPS', window_id: 53 });
    expect(launched).toHaveLength(3);
    if (platform === 'darwin') expect(new Set(launched.map(params => params.env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE)).size).toBe(3);
    await closeNativeSurfacesForTurn(first);
    expect(sessions[1].close).toHaveBeenCalledOnce();
    expect(sessions[2].close).not.toHaveBeenCalled();
    if (platform === 'darwin') expect(stopOwnedNativeAgent).toHaveBeenCalledWith(launched[1].command,
      launched[1].env.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE);
    await read.execute({ app: 'WPS', window_id: 53 });
    expect(sessions[2].callTool).toHaveBeenCalledTimes(2);
    release({ content: [] }); await waiting;
  } finally { await closeNativeSurfacesForTurn(second); await stacks.memmy_computer_use.aclose(); }
});
