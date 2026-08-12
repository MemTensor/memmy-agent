/**
 * Pipeline 编排引擎（创作八将顺序协作）
 *
 * 设计依据：docs/novel-design.md §2.2
 * - 顺序协作：灵思→构世→塑像→谋篇→埋线→执笔→淬文→审校
 * - 主编在每个节点后审阅中间结果：采纳（放行）/ 驳回（打回）
 * - 节点可中断/恢复/锁定/回退
 */
import { ExpertId, ExpertResult, AguiResponse, TaskCard } from "./types.js";
import { ExpertRegistry } from "./expert-registry.js";

/** Pipeline 节点状态机 */
export type PipelineNodeStatus =
  | "pending"   // 未开始
  | "running"   // 执行中（专家工作中）
  | "waiting"   // 等待用户 AG-UI 决策（半自动确认节点）
  | "blocked"   // 被中断/上游未就绪
  | "done"      // 已完成且用户采纳
  | "failed"    // 执行失败
  | "frozen";   // 已锁定（即使上游变更也不重跑）

export interface PipelineNode {
  expertId: ExpertId;
  /** Pipeline 序号 1-8 */
  order: number;
  status: PipelineNodeStatus;
  taskCard: TaskCard | null;
  result: ExpertResult | null;
  /** 用户决策（采纳 true / 驳回 false + reason） */
  decision: AguiResponse | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** 打回次数（防死循环：超限转主编介入） */
  rejectCount: number;
}

export interface WorkflowCallbacks {
  onNodeStart?: (node: PipelineNode, bookId: string) => void;
  /** 节点产出待用户决策（AG-UI 确认卡片应在此刻发出） */
  onNodeWaiting?: (node: PipelineNode, bookId: string) => void;
  onNodeAccepted?: (node: PipelineNode, bookId: string) => void;
  onNodeRejected?: (node: PipelineNode, bookId: string, reason: string) => void;
  onPipelineComplete?: (bookId: string) => void;
  onPipelineFailed?: (bookId: string, error: string) => void;
}

const MAX_REJECT_PER_NODE = 3;

export class WorkflowEngine {
  private registry = new ExpertRegistry();
  private bookId: string;
  private nodes: PipelineNode[] = [];
  private cursor = 0; // 当前节点索引
  private callbacks: WorkflowCallbacks = {};

  constructor(bookId: string, callbacks: WorkflowCallbacks = {}) {
    this.bookId = bookId;
    this.callbacks = callbacks;
    this.buildPipeline();
  }

  /** 按创作八将 Pipeline 顺序建节点 */
  private buildPipeline(): void {
    this.nodes = this.registry.creationTeam().map((profile, i) => ({
      expertId: profile.id,
      order: i + 1,
      status: "pending",
      taskCard: null,
      result: null,
      decision: null,
      startedAt: null,
      finishedAt: null,
      rejectCount: 0,
    }));
  }

  getNodes(): PipelineNode[] {
    return this.nodes;
  }

  current(): PipelineNode | null {
    return this.nodes[this.cursor] ?? null;
  }

  isComplete(): boolean {
    return this.cursor >= this.nodes.length;
  }

  /** 启动流水线：从第一个 pending 节点开始 */
  start(): void {
    this.runCurrent();
  }

  /** 派发当前节点：赋任务卡 → running → 通知执行者 */
  private runCurrent(): void {
    const node = this.current();
    if (!node) {
      this.callbacks.onPipelineComplete?.(this.bookId);
      return;
    }
    node.status = "running";
    node.startedAt = Date.now();
    this.callbacks.onNodeStart?.(node, this.bookId);
  }

  /** 专家回传结果 → 节点进入 waiting（等用户 AG-UI 确认） */
  submitResult(expertId: ExpertId, result: ExpertResult, taskCard: TaskCard | null = null): void {
    const node = this.findNode(expertId);
    if (node.status !== "running") throw new Error(`node ${expertId} 不在 running 状态`);
    node.result = result;
    node.taskCard = taskCard;
    node.status = "waiting";
    this.callbacks.onNodeWaiting?.(node, this.bookId);
  }

  /** 用户采纳 → 放行下一节点 */
  accept(expertId: ExpertId, decision: AguiResponse): void {
    const node = this.findNode(expertId);
    if (node.status !== "waiting") throw new Error(`node ${expertId} 不在 waiting 状态`);
    node.decision = decision;
    node.status = "done";
    node.finishedAt = Date.now();
    this.callbacks.onNodeAccepted?.(node, this.bookId);
    this.cursor += 1;
    this.runCurrent();
  }

  /** 用户驳回 → 打回指定节点（默认上一节点；可选打回灵思整体重想） */
  reject(expertId: ExpertId, decision: AguiResponse, rollbackTo?: ExpertId): void {
    const node = this.findNode(expertId);
    if (node.status !== "waiting") throw new Error(`node ${expertId} 不在 waiting 状态`);
    node.decision = decision;
    node.rejectCount += 1;
    this.callbacks.onNodeRejected?.(node, this.bookId, decision.reason ?? "");

    if (node.rejectCount > MAX_REJECT_PER_NODE) {
      // 防死循环：超限标记 failed，转主编人工介入
      node.status = "failed";
      this.callbacks.onPipelineFailed?.(this.bookId, `${expertId} 连续驳回 ${MAX_REJECT_PER_NODE} 次，需主编介入`);
      return;
    }

    // 定位回退目标：默认打回上一节点；可指定任意节点（如灵思=整体重想）
    const targetIndex = rollbackTo
      ? this.nodes.findIndex((n) => n.expertId === rollbackTo)
      : this.nodes.findIndex((n) => n.expertId === expertId) - 1;
    if (targetIndex < 0) {
      node.status = "failed";
      this.callbacks.onPipelineFailed?.(this.bookId, `无法回退：无上一节点（${expertId}）`);
      return;
    }
    // 从回退目标到当前节点全部重置为 pending，回退目标节点清空结果
    for (let i = targetIndex; i < this.nodes.length; i += 1) {
      const n = this.nodes[i];
      n.status = "pending";
      n.result = null;
      n.decision = null;
      n.finishedAt = null;
      if (i === targetIndex) n.rejectCount = node.rejectCount;
    }
    this.cursor = targetIndex;
    this.runCurrent();
  }

  /** 中断（暂停当前运行节点 → blocked） */
  pause(): void {
    const node = this.current();
    if (node?.status === "running") node.status = "blocked";
  }

  /** 恢复（从当前节点继续） */
  resume(): void {
    const node = this.current();
    if (node?.status === "blocked") this.runCurrent();
  }

  /** 锁定节点（frozen：即使上游变更也不重跑） */
  freeze(expertId: ExpertId): void {
    const node = this.findNode(expertId);
    if (node.status !== "done") throw new Error(`仅 done 节点可锁定：${expertId}`);
    node.status = "frozen";
  }

  /** 解锁节点 */
  unfreeze(expertId: ExpertId): void {
    const node = this.findNode(expertId);
    if (node.status !== "frozen") throw new Error(`仅 frozen 节点可解锁：${expertId}`);
    node.status = "done";
  }

  /** 标记失败（专家执行异常） */
  fail(expertId: ExpertId, error: string): void {
    const node = this.findNode(expertId);
    node.status = "failed";
    this.callbacks.onPipelineFailed?.(this.bookId, `${expertId}: ${error}`);
  }

  private findNode(expertId: ExpertId): PipelineNode {
    const node = this.nodes.find((n) => n.expertId === expertId);
    if (!node) throw new Error(`unknown pipeline node: ${expertId}`);
    return node;
  }
}
