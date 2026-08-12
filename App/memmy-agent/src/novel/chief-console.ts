/**
 * 主编控制台（Chief Console）
 *
 * 设计依据：docs/novel-design.md §2.3
 * - 任务下发（带创作指令单）→ 专家执行器 → 结果回传 → 用户 AG-UI 决策 → 放行/驳回
 * - 进度监控：节点状态、pending 决策数、专家调用记录
 * - 中断/恢复/锁定/解锁/回退 操作面
 */
import { WorkflowEngine, PipelineNode, PipelineNodeStatus } from "./workflow-engine.js";
import { AguiBridge } from "./agui-bridge.js";
import { AguiResponse, ExpertId, ExpertResult, TaskCard } from "./types.js";
import { ExpertRegistry } from "./expert-registry.js";

/** 专家执行器：把任务卡交给专家（真实环境 = 经 SubagentManager 派发的 subagent） */
export interface ExpertRunner {
  run(bookId: string, node: PipelineNode, taskCard: TaskCard): Promise<ExpertResult>;
}

export interface NodeView {
  expertId: ExpertId;
  name: string;
  order: number;
  status: PipelineNodeStatus;
  hasResult: boolean;
  rejectCount: number;
  decision: AguiResponse | null;
}

export interface ConsoleSnapshot {
  bookId: string;
  nodes: NodeView[];
  pendingDecisions: number;
  complete: boolean;
  failed: boolean;
  currentExpertId: ExpertId | null;
}

export class ChiefConsole {
  private registry = new ExpertRegistry();
  private workflow: WorkflowEngine;
  private bridge: AguiBridge;
  private runner: ExpertRunner;
  private bookId: string;
  private callLog: { expertId: ExpertId; ts: number; taskId: string }[] = [];

  constructor(init: {
    bookId: string;
    workflow: WorkflowEngine;
    bridge: AguiBridge;
    runner: ExpertRunner;
  }) {
    this.bookId = init.bookId;
    this.workflow = init.workflow;
    this.bridge = init.bridge;
    this.runner = init.runner;
  }

  /** 启动流水线：主编自动把当前节点派单给专家执行 */
  start(): void {
    this.workflow.start();
    void this.pump();
  }

  /** 主编派单 + 执行循环：running 节点 → 构造 TaskCard → runner 执行 → 结果入 waiting */
  private async pump(): Promise<void> {
    const node = this.workflow.current();
    if (!node || this.workflow.isComplete()) return;
    if (node.status !== "running") return;

    const taskCard: TaskCard = this.buildTaskCard(node);
    this.callLog.push({ expertId: node.expertId, ts: Date.now(), taskId: taskCard.task_id });
    try {
      const result = await this.runner.run(this.bookId, node, taskCard);
      this.workflow.submitResult(node.expertId, result, taskCard);
      // submitResult 触发 onNodeWaiting —— 外部在此时发 AG-UI 确认卡片
    } catch (error) {
      this.workflow.fail(node.expertId, (error as Error).message);
    }
  }

  /** 按专家档案与上游产出构造任务卡（references 注入已确认的上游结果） */
  private buildTaskCard(node: PipelineNode): TaskCard {
    const profile = this.registry.get(node.expertId);
    const upstream = this.workflow
      .getNodes()
      .filter((n) => n.order < node.order && n.result)
      .map((n) => `上游 ${n.expertId}: ${n.result?.summary ?? ""}`);
    return {
      task_id: `tsk_${Date.now().toString(36)}_${node.order}`,
      expert: node.expertId,
      objective: `${profile.name}：${profile.outputs.join("、")}`,
      constraints: [
        "不得改变已锁定设定（基线快照）",
        "按产出物 schema 回传 {title, summary, detail, refs, extra}",
        ...profile.asKnowledgeCenter ? [] : [],
      ],
      references: [
        ...upstream,
        `角色卡:${profile.roleCard}`,
        `技能:${profile.category === "creation" ? "novel-orchestration" : "novel-flow"}`,
      ],
      acceptance: [
        "满足角色卡质量标准",
        ...(node.expertId === "zhi-bi" ? ["控字达标", "章末钩子生效"] : []),
        ...(node.expertId === "shen-xiao" ? ["双基准查重完成", "审校清单可定位"] : []),
      ],
      deadline: null,
      parent_decision: this.workflow.getNodes()[node.order - 2]?.decision?.reason ?? null,
    };
  }

  /** 用户采纳 → 放行下一节点并继续派单 */
  async accept(expertId: ExpertId, decision: AguiResponse): Promise<void> {
    this.workflow.accept(expertId, decision);
    await this.pump();
  }

  /** 用户驳回 → 打回（默认上一节点；可指定回退目标） */
  async reject(expertId: ExpertId, decision: AguiResponse, rollbackTo?: ExpertId): Promise<void> {
    this.workflow.reject(expertId, decision, rollbackTo);
    await this.pump();
  }

  /** 主编控制台操作面：中断/恢复/锁定/解锁 */
  pause(): void {
    this.workflow.pause();
  }

  resume(): void {
    this.workflow.resume();
    void this.pump();
  }

  freeze(expertId: ExpertId): void {
    this.workflow.freeze(expertId);
  }

  unfreeze(expertId: ExpertId): void {
    this.workflow.unfreeze(expertId);
  }

  /** 进度监控快照（主编控制台/前端编委会视图的数据源） */
  snapshot(): ConsoleSnapshot {
    const nodes = this.workflow.getNodes();
    return {
      bookId: this.bookId,
      nodes: nodes.map((n) => ({
        expertId: n.expertId,
        name: this.registry.get(n.expertId).name,
        order: n.order,
        status: n.status,
        hasResult: n.result !== null,
        rejectCount: n.rejectCount,
        decision: n.decision,
      })),
      pendingDecisions: this.bridge.pendingCount(),
      complete: this.workflow.isComplete(),
      failed: nodes.some((n) => n.status === "failed"),
      currentExpertId: this.workflow.current()?.expertId ?? null,
    };
  }

  callHistory(): { expertId: ExpertId; ts: number; taskId: string }[] {
    return [...this.callLog];
  }

  /** 挂起中的 AG-UI 决策（供前端渲染卡片） */
  pendingDecisions(): number {
    return this.bridge.pendingCount();
  }
}
