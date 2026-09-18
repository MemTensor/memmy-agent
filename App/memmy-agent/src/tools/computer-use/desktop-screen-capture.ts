import { randomUUID } from 'node:crypto';
import { SCREEN_CAPTURE_PREFIX as PREFIX, SCREEN_CAPTURE_PROTOCOL, SCREEN_CAPTURE_MAX_BYTES, isScreenCaptureMessage, isScreenCaptureResult, type ScreenCaptureResult } from '@memmy/local-api-contracts';
import { Tool, type ToolExecutionContext } from '../../core/agent-runtime/tools/base.js';
import { convertMcpToolContent } from '../../core/agent-runtime/tools/mcp.js';
import { isManagedOcuConfig } from './open-computer-use-binary.js';

type IpcProcess = Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'removeListener'>;
export class DesktopScreenClient {
  available = false;
  private listening = false;
  private readonly pending = new Map<string, { resolve(value: any): void; finish(): void }>();
  private handshake: Promise<void> | null = null;
  constructor(private readonly ipc: IpcProcess = process) {}
  private onMessage = (raw: unknown) => {
    if (!isScreenCaptureMessage(raw)) return;
    const pending = this.pending.get(raw.requestId);
    if (pending) { pending.finish(); pending.resolve(raw); }
  };
  private onDisconnect = () => {
    this.available = false;
    for (const pending of [...this.pending.values()]) { pending.finish(); pending.resolve(null); }
    this.ipc.removeListener('message', this.onMessage);
    this.ipc.removeListener('disconnect', this.onDisconnect);
    this.listening = false;
  };
  private request(type: string, data: object, timeout: number, signal?: AbortSignal | null): Promise<any> {
    if (!this.ipc.send || !this.ipc.connected || signal?.aborted) return Promise.resolve(null);
    if (!this.listening) { this.ipc.on('message', this.onMessage); this.ipc.on('disconnect', this.onDisconnect); this.listening = true; }
    const requestId = randomUUID();
    return new Promise(resolve => {
      const cancel = () => {
        try { this.ipc.send?.({ type: `${PREFIX}cancel`, requestId }, () => undefined); } catch { /* Disconnected. */ }
        finish(); resolve(null);
      };
      const timer = setTimeout(cancel, timeout);
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(requestId); };
      this.pending.set(requestId, { resolve, finish });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.ipc.send!({ type, requestId, ...data }, error => { if (error) { finish(); resolve(null); } }); }
      catch { finish(); resolve(null); }
    });
  }
  async initialize(): Promise<void> {
    if (this.available && this.ipc.connected) return;
    if (!this.handshake) this.handshake = this.request(`${PREFIX}capabilities`, { version: SCREEN_CAPTURE_PROTOCOL }, 2000)
      .then(reply => { this.available = reply?.type === `${PREFIX}capabilities` && reply.version === SCREEN_CAPTURE_PROTOCOL && reply.available === true; })
      .finally(() => { this.handshake = null; });
    return this.handshake;
  }
  async capture(displayId?: string, signal?: AbortSignal | null): Promise<ScreenCaptureResult> {
    const unavailable = { ok: false as const, code: 'unavailable' as const, message: 'Memmy 桌面截图服务不可用，本次未截图。' };
    if (!this.available || !this.ipc.connected) return unavailable;
    const response = await this.request(`${PREFIX}request`, displayId ? { displayId } : {}, 10_000, signal);
    if (signal?.aborted || response?.type !== `${PREFIX}response` || !isScreenCaptureResult(response.result)) return unavailable;
    const result = response.result;
    if (result.ok) {
      const png = Buffer.from(result.pngBase64, 'base64');
      if (png.length < 33 || png.length > SCREEN_CAPTURE_MAX_BYTES || png.toString('base64') !== result.pngBase64
        || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || png.toString('ascii', 12, 16) !== 'IHDR'
        || png.readUInt32BE(16) !== result.width || png.readUInt32BE(20) !== result.height) {
        return { ok: false, code: 'capture_failed', message: 'Memmy 返回的屏幕图片无效，本次未读取屏幕内容。' };
      }
    }
    return result;
  }
}
export const desktopScreenClient = new DesktopScreenClient();
export async function initializeDesktopScreenCapture(): Promise<void> {
  if (process.platform === 'darwin' && process.env.MEMMY_DESKTOP_MANAGED_GATEWAY === '1') await desktopScreenClient.initialize();
}
export function screenCaptureEnabled(config: any, platform = process.platform, available = desktopScreenClient.available): boolean {
  const cfg = config?.mcpServers?.open_computer_use ?? config?.tools?.mcpServers?.open_computer_use ?? config?.tools?.mcp_servers?.open_computer_use;
  if (!cfg || cfg.enabled === false || !available || !isManagedOcuConfig('open_computer_use', cfg, platform)) return false;
  const enabled = cfg.enabledTools ?? cfg.enabled_tools ?? ['*'];
  return enabled.some((name: string) => ['*', 'get_screen_state', 'mcp_open_computer_use_get_screen_state'].includes(name));
}
export class DesktopScreenCaptureTool extends Tool {
  static pluginDiscoverable = false;
  static enabled(ctx: any): boolean { return screenCaptureEnabled(ctx.runtimeState ? { mcpServers: ctx.runtimeState.mcpServers } : ctx.config); }
  static create(ctx: any): DesktopScreenCaptureTool { return new DesktopScreenCaptureTool(() => screenCaptureEnabled(ctx.runtimeState ? { mcpServers: ctx.runtimeState.mcpServers } : ctx.config)); }
  constructor(private readonly enabledNow: () => boolean = () => false, private readonly client = desktopScreenClient) { super(); }
  get name(): string { return 'get_screen_state'; }
  get description(): string { return 'Observe the currently visible main screen, or a specified display_id, without opening, focusing or restoring any application. Provided by Memmy Desktop; requires Memmy screen recording permission, not Open Computer Use accessibility. Never use Finder/get_app_state as a substitute.'; }
  get parameters() { return { type: 'object', properties: { display_id: { type: 'integer', minimum: 1 } }, additionalProperties: false }; }
  get exclusive(): boolean { return true; }
  async execute(params: { display_id?: number } = {}, context?: ToolExecutionContext): Promise<any> {
    if (context?.abortSignal?.aborted) return 'Screen request cancelled';
    if (!this.enabledNow()) { const message = 'Memmy 桌面截图工具已禁用或不可用。'; context?.stopTurn?.(message); return message; }
    const result = await this.client.capture(params.display_id === undefined ? undefined : String(params.display_id), context?.abortSignal);
    if (context?.abortSignal?.aborted) return 'Screen request cancelled';
    if (!result.ok) { context?.stopTurn?.(result.message); return result.message; }
    const { pngBase64, ...metadata } = result;
    return convertMcpToolContent({ content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data: pngBase64, mimeType: 'image/png' }] }, 'auto');
  }
}
