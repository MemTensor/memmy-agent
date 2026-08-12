/**
 * AG-UI 人类决策层 · Agent 端桥接（agui-bridge）
 *
 * 设计依据：docs/novel-design.md §2.1
 * - 决策点发出 AG-UI 消息 → 经现有 OutboundMessage 的 metadata.agentUi 送达前端
 * - 用户结构化响应沿 InboundMessage 回传 → resolve 挂起的 Promise → Agent 恢复执行
 * - 与 session-dag 打通：等待决策 = 节点 blocked，收到响应 = 恢复 active
 */
import {
  OutboundMessage,
  INBOUND_META_RUNTIME_CONTROL,
  OUTBOUND_META_AGENT_UI,
} from "../core/runtime-messages/events.js";
import { AguiMessage, AguiMessageType, AguiResponse, AguiField } from "./types.js";

/** 传输适配：默认走 MessageBus，测试可注入假实现 */
export interface AguiTransport {
  publish(message: OutboundMessage): Promise<void> | void;
}

export interface AguiDecisionRequest {
  type: AguiMessageType;
  title: string;
  body: string;
  fields?: AguiField[];
  irreversible?: boolean;
  context_id?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 决策等待默认 10 分钟

interface PendingDecision {
  resolve: (response: AguiResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AguiBridge {
  private pending = new Map<string, PendingDecision>();
  private seq = 0;

  constructor(
    private transport: AguiTransport,
    private opts: { timeoutMs?: number; channel?: string; chatId?: string } = {},
  ) {}

  /** 发出决策卡片并挂起等待用户响应（半自动确认节点的核心原语） */
  requestDecision(request: AguiDecisionRequest): Promise<AguiResponse> {
    const message: AguiMessage = {
      id: this.nextId(),
      type: request.type,
      from: "chief",
      title: request.title,
      body: request.body,
      fields: request.fields,
      irreversible: request.irreversible ?? false,
      context_id: request.context_id,
    };

    const outbound = new OutboundMessage({
      channel: this.opts.channel ?? "novel",
      chatId: this.opts.chatId ?? "editorial",
      content: `[AG-UI] ${request.type}: ${request.title}`,
      metadata: { [OUTBOUND_META_AGENT_UI]: message },
    });

    return new Promise<AguiResponse>((resolve, reject) => {
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`AG-UI 决策超时（${message.id}：${request.title}）`));
      }, timeoutMs);
      this.pending.set(message.id, { resolve, reject, timer });

      try {
        void this.transport.publish(outbound);
      } catch (error) {
        this.cancel(message.id);
        reject(error as Error);
      }
    });
  }

  /** confirm 快捷方法：请用户批准/驳回 */
  confirm(title: string, body: string, contextId?: string, irreversible = false): Promise<AguiResponse> {
    return this.requestDecision({ type: "confirm", title, body, context_id: contextId, irreversible });
  }

  /** 确认采纳（带采纳理由） */
  async accept(title: string, body: string, contextId?: string): Promise<boolean> {
    const response = await this.confirm(title, body, contextId);
    return response.decision === true;
  }

  /**
   * 收到用户响应时由 Agent loop 调用（挂载于 InboundMessage 处理链）
   * 响应消息携带 metadata.aguiResponse = { message_id, decision, reason }
   */
  resolveResponse(payload: AguiResponse): boolean {
    const pending = this.pending.get(payload.message_id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(payload.message_id);
    pending.resolve(payload);
    return true;
  }

  /** 取消挂起的决策（超时/主编撤回） */
  cancel(messageId: string): boolean {
    const pending = this.pending.get(messageId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(messageId);
    pending.reject(new Error(`AG-UI 决策已取消（${messageId}）`));
    return true;
  }

  /** 挂起中的决策数量（主编控制台进度监控用） */
  pendingCount(): number {
    return this.pending.size;
  }

  private nextId(): string {
    this.seq += 1;
    return `agui_${Date.now().toString(36)}_${this.seq.toString(36)}`;
  }
}

// 供 agent loop 识别用户 AG-UI 响应的元数据键（与 events.ts 的 runtimeControl 平行）
export const INBOUND_META_AGUI_RESPONSE = "aguiResponse";
export { INBOUND_META_RUNTIME_CONTROL };
