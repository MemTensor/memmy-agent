/**
 * 写作命令注册（/新书 /编委会 /日更 /审稿 /会诊 /流水线）
 *
 * 设计依据：docs/novel-design.md §8（写作命令）+ §2.3 主编控制台
 * - 命令是用户入口；真实专家执行由注入的 ExpertRunner 承担（C 块接线 SubagentManager）
 * - 活跃书会话由模块级 map 管理（内存版，B 块 novel-project 持久化后替换）
 */
import { CommandRouter, CommandContext } from "../command/router.js";
import { OutboundMessage } from "../core/runtime-messages/events.js";
import { WorkflowEngine } from "./workflow-engine.js";
import { AguiBridge } from "./agui-bridge.js";
import { ChiefConsole, ExpertRunner } from "./chief-console.js";
import { ExpertRegistry } from "./expert-registry.js";
import { ExpertId } from "./types.js";

/** 默认专家执行器：未接线时明确报错，不假装执行（诚实失败原则） */
const UNWIRED_RUNNER: ExpertRunner = {
  run: async (bookId, node) => {
    throw new Error(
      `专家执行器未接线（${node.expertId} @ ${bookId}）：C 块接线 SubagentManager 后注入。` +
        `当前可通过加载 novel-orchestration 技能由主 Agent 召见专家完成作业。`,
    );
  },
};

export interface NovelCommandDeps {
  runner?: ExpertRunner;
  bridge?: AguiBridge;
}

/** 活跃书会话（sessionKey → 主编控制台） */
const activeBooks = new Map<string, ChiefConsole>();
const bookTitles = new Map<string, string>();

function reply(ctx: CommandContext, content: string): OutboundMessage {
  return new OutboundMessage({ channel: ctx.msg.channel, chatId: ctx.msg.chatId, content });
}

/** 主编控制台状态渲染（编委会视图文本版） */
function renderConsole(console_: ChiefConsole): string {
  const snap = console_.snapshot();
  const lines = [
    `## 编委会 · 流水线状态（书 ${snap.bookId}）`,
    "",
    "| 序号 | 专家 | 状态 | 产出 | 驳回 |",
    "|---|---|---|---|---|",
  ];
  for (const node of snap.nodes) {
    lines.push(
      `| ${node.order} | ${node.name} | ${node.status} | ${node.hasResult ? "✅" : "—"} | ${node.rejectCount} |`,
    );
  }
  lines.push("", `- 挂起决策数：${snap.pendingDecisions}`);
  lines.push(snap.complete ? "- 流水线：**已完成**" : snap.failed ? "- 流水线：**存在失败节点**" : `- 当前节点：${snap.currentExpertId ?? "无"}`);
  return lines.join("\n");
}

export function registerNovelCommands(router: CommandRouter, deps: NovelCommandDeps = {}): void {
  const registry = new ExpertRegistry();

  function getOrCreateConsole(ctx: CommandContext, title?: string): ChiefConsole {
    const key = ctx.key ?? `${ctx.msg.channel}:${ctx.msg.chatId}`;
    let console_ = activeBooks.get(key);
    if (!console_) {
      const bookId = `book_${Date.now().toString(36)}`;
      const bridge = deps.bridge ?? new AguiBridge({ publish: () => undefined });
      const workflow = new WorkflowEngine(bookId);
      console_ = new ChiefConsole({
        bookId,
        workflow,
        bridge,
        runner: deps.runner ?? UNWIRED_RUNNER,
      });
      activeBooks.set(key, console_);
      bookTitles.set(bookId, title ?? "未命名新书");
    }
    return console_;
  }

  /** /新书 <创意> —— 立项入口：启动流水线（灵思方案卡片） */
  router.prefix("/新书 ", async (ctx) => {
    const title = ctx.args.trim();
    if (!title) return reply(ctx, "用法：`/新书 <一句话创意>`，例如 `/新书 现代医生穿越到修仙界靠手术刀逆袭`");
    const console_ = getOrCreateConsole(ctx, title);
    console_.start();
    return reply(
      ctx,
      [
        `📖 新书立项已启动（创意：${title}）`,
        "",
        "灵思正在产出《方案卡片×3》……",
        "",
        "> 流水线节点：灵思 → 构世 → 塑像 → 谋篇 → 埋线 → 执笔 → 淬文 → 审校",
        "> 每个方向类节点会通过 AG-UI 卡片请你确认（半自动）。",
      ].join("\n"),
    );
  });

  /** /编委会 —— 展示 13 位专家与当前流水线 */
  router.exact("/编委会", (ctx) => {
    const lines = ["## 编委会阵容", ""];
    lines.push("**主编中枢**：负责任务下发/进度监控/采纳驳回/编排");
    lines.push("", "**创作八将**：");
    for (const p of registry.creationTeam()) lines.push(`- ${p.order}. ${p.name} —— ${p.duties[0]}`);
    lines.push("", "**支撑四翼**：");
    for (const p of registry.supportTeam()) lines.push(`- ${p.name} —— ${p.duties[0]}`);
    const console_ = activeBooks.get(ctx.key ?? "");
    if (console_) {
      lines.push("", "---", "", renderConsole(console_));
    } else {
      lines.push("", "> 当前会话还没有在写的新书，用 `/新书 <创意>` 开一本。");
    }
    return reply(ctx, lines.join("\n"));
  });

  /** /流水线 —— 查看当前流水线状态 */
  router.exact("/流水线", (ctx) => {
    const console_ = activeBooks.get(ctx.key ?? "");
    return reply(ctx, console_ ? renderConsole(console_) : "当前会话没有活跃新书，用 `/新书 <创意>` 启动。");
  });

  /** /日更 [章号] —— 日更流程入口 */
  router.prefix("/日更 ", async (ctx) => {
    const console_ = activeBooks.get(ctx.key ?? "");
    if (!console_) return reply(ctx, "还没有新书项目，先 `/新书 <创意>` 立项。");
    const chapterNo = ctx.args.trim() || "下一章";
    return reply(
      ctx,
      [
        `✍️ 日更请求：第 ${chapterNo} 章`,
        "",
        "主编将按流程执行：谋篇拆章纲 → 埋线伏笔插针 → 执笔写作（控字+钩子）→ 事中拦截 → 淬文洗稿 → 审校查重 → 回写档案 → 终审交付。",
        "> 章纲产出后会先请你确认（AG-UI confirm），确认后自动跑完全程。",
      ].join("\n"),
    );
  });

  /** /审稿 [章号] —— 审校入口（全专家会诊/单审校） */
  router.prefix("/审稿 ", (ctx) => {
    const console_ = activeBooks.get(ctx.key ?? "");
    if (!console_) return reply(ctx, "还没有新书项目，先 `/新书 <创意>` 立项。");
    const target = ctx.args.trim() || "当前章节";
    return reply(
      ctx,
      [
        `🔍 审稿请求：${target}`,
        "",
        "审校将对照双基准全量查重（世界库预设规则 + 本书作品档案），产出可定位的《审校报告》清单。",
        "> 输入 `/会诊` 可发起全专家会诊（八将+四翼全员意见）。",
      ].join("\n"),
    );
  });

  /** /会诊 —— 全专家会诊 */
  router.exact("/会诊", (ctx) => {
    const console_ = activeBooks.get(ctx.key ?? "");
    if (!console_) return reply(ctx, "还没有新书项目，先 `/新书 <创意>` 立项。");
    return reply(
      ctx,
      [
        "🩺 全专家会诊已请求",
        "",
        "编委会全员将对当前章节输出综合意见：",
        "- 创作八将：灵思（创意角度）/构世（设定角度）/塑像（人物角度）/谋篇（结构角度）/埋线（伏笔角度）/执笔（可写性）/淬文（语言角度）/审校（一致性角度）",
        "- 支撑四翼：布景（场景）/监工（数据）/装帧（交付）/试读（读者）",
        "",
        "会诊结论将由主编汇总后交你 AG-UI 确认处置。",
      ].join("\n"),
    );
  });

  /** /流水线 状态命令已注册在上方 exact；此处补充带参数形式 */
  router.prefix("/流水线 ", (ctx) => {
    const console_ = activeBooks.get(ctx.key ?? "");
    return reply(ctx, console_ ? renderConsole(console_) : "当前会话没有活跃新书。");
  });
}

export { activeBooks, bookTitles, UNWIRED_RUNNER };
export type { NovelCommandDeps };
export type { ExpertId };
