/**
 * novel 模块核心类型定义（编委会制小说写作系统）
 *
 * 设计依据：docs/novel-design.md
 * - §1 编委会名单（主编中枢 + 创作八将 + 支撑四翼）
 * - §2.1 AG-UI 人类决策层 / §2.6 十九线叙事矩阵
 * - §3.3 作品数据层 / §5 Plot Git / §6 一致性引擎
 */

/* ─────────────── 编委会 · 专家 ─────────────── */

/** 专家分类：主编中枢 / 创作八将 / 支撑四翼 */
export type ExpertCategory = "chief" | "creation" | "support";

/** 专家代号（唯一标识，英文 slug，两字中文名为 displayName） */
export type ExpertId =
  | "chief"          // 主编中枢
  | "ling-si"        // 灵思
  | "gou-shi"        // 构世
  | "su-xiang"       // 塑像
  | "mou-pian"       // 谋篇
  | "mai-xian"       // 埋线
  | "zhi-bi"         // 执笔
  | "cui-wen"        // 淬文
  | "shen-xiao"      // 审校
  | "bu-jing"        // 布景
  | "jian-gong"      // 监工
  | "zhuang-zhen"    // 装帧
  | "shi-du";        // 试读

/** 创作八将的 Pipeline 序号（支撑四翼为 null） */
export type PipelineOrder = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** 专家档案（对应附录 A 角色卡的结构化形式） */
export interface ExpertProfile {
  id: ExpertId;
  /** 两字中文名 */
  name: string;
  category: ExpertCategory;
  /** 创作八将 Pipeline 序号；主编/支撑四翼为 null */
  pipeline: PipelineOrder | null;
  /** 角色卡模板文件路径（templates/novel/experts/*.md） */
  roleCard: string;
  /** 核心职责 */
  duties: string[];
  /** 固定产出物 */
  outputs: string[];
  /** 触发时机 */
  trigger: string;
  /** 是否参与一致性引擎事中路由（作为知识中心） */
  asKnowledgeCenter?: boolean;
}

/* ─────────────── 任务卡片（创作指令单） ─────────────── */

/** 主编派单的任务卡片（对应附录 B schema） */
export interface TaskCard {
  task_id: string;
  expert: ExpertId;
  objective: string;
  constraints: string[];
  references: string[];
  acceptance: string[];
  deadline: string | null;
  /** 上级决策（如"用户大纲确认 dec_9c11"） */
  parent_decision: string | null;
  /** 任务产出（专家按 schema 回传） */
  result?: ExpertResult;
}

/** 专家统一回传结构（调度器自动聚合的前提） */
export interface ExpertResult {
  title: string;
  summary: string;
  detail: string;
  /** 引用（世界库/素材库/作品档案条目） */
  refs: string[];
  /** 结构化附加数据（如方案卡片字段、审校清单） */
  extra?: Record<string, unknown>;
}

/* ─────────────── 十九线叙事矩阵（§2.6） ─────────────── */

/** 19 线分类（5 类） */
export type LineCategory =
  | "主干演进"   // work / life / study / growth
  | "关系羁绊"   // family / romance / friendship / colleague / enemy
  | "策略局势"   // game / system / ability / cost
  | "剧情推动"   // foreshadow / layout / crisis / break
  | "叙事内核";  // motif / timeline

/** 19 线 line_type 枚举 */
export type LineType =
  // 主干演进
  | "work" | "life" | "study" | "growth"
  // 关系羁绊
  | "family" | "romance" | "friendship" | "colleague" | "enemy"
  // 策略局势
  | "game" | "system" | "ability" | "cost"
  // 剧情推动
  | "foreshadow" | "layout" | "crisis" | "break"
  // 叙事内核
  | "motif" | "timeline";

/** 线索状态机：活跃 / 蛰伏 / 回收 / 完结 */
export type LineStatus = "active" | "dormant" | "recovered" | "completed";

/** 一条叙事线索（19 条槽位之一） */
export interface PlotLine {
  line_type: LineType;
  name: string;
  category: LineCategory;
  status: LineStatus;
  /** 最近推进章节号 */
  last_advance_chapter: number;
  /** 下次计划推进点 */
  next_plan: string;
  /** 关联伏笔 ID 列表 */
  related_foreshadows: string[];
}

/* ─────────────── 伏笔状态机（§2.5） ─────────────── */

/** 伏笔状态：埋下 / 待回收 / 已回收 */
export type ForeshadowStatus = "planted" | "pending" | "recovered";

export interface Foreshadow {
  id: string;
  content: string;
  /** 埋设章节 */
  planted_chapter: number;
  /** 计划回收章节 */
  planned_recovery_chapter: number | null;
  /** 实际回收章节 */
  actual_recovery_chapter: number | null;
  /** 责任人（埋线/审校） */
  owner: ExpertId;
  status: ForeshadowStatus;
  /** 关联线索 */
  related_lines: LineType[];
}

/* ─────────────── 章节状态机（§2.4） ─────────────── */

/** 章节状态：规划中 / 写作中 / 待审 / 已采纳 / 已驳回 / 已发布 */
export type ChapterStatus = "planning" | "writing" | "reviewing" | "accepted" | "rejected" | "published";

/** 章节细纲任务单（3-4 子场景 + 控字预算 + 伏笔插针） */
export interface ChapterOutlineTask {
  chapter_no: number;
  title: string;
  scenes: string[];          // 3-4 个子场景
  word_budget: { min: number; max: number };
  /** 伏笔插针：本章要埋/要回收的伏笔 ID */
  foreshadow_inject: { plant: string[]; recover: string[] };
  /** 线索推进计划（line_type → 动作） */
  line_advance: Partial<Record<LineType, string>>;
  /** 章末钩子指向 */
  hook: string;
}

/* ─────────────── AG-UI 人类决策层（§2.1） ─────────────── */

/** AG-UI 交互消息类型 */
export type AguiMessageType = "form" | "confirm" | "question" | "multi-select";

/** AG-UI 决策卡片消息（Agent → 前端 → 用户 → 回传） */
export interface AguiMessage {
  id: string;
  type: AguiMessageType;
  /** 消息来源（如 chief 下发、consistency 拦截） */
  from: string;
  /** 标题（渲染为卡片标题） */
  title: string;
  /** 正文说明 */
  body: string;
  /** 卡片字段（form 的表单项 / question 的选项等） */
  fields?: AguiField[];
  /** 不可逆操作提示（如基线锁定） */
  irreversible?: boolean;
  /** 关联对象（task_id / foreshadow_id / 方案卡片 id…） */
  context_id?: string;
}

export interface AguiField {
  key: string;
  label: string;
  type: "text" | "number" | "select" | "textarea" | "boolean";
  options?: string[];
  required?: boolean;
  default?: unknown;
}

/** 用户对 AG-UI 消息的结构化响应 */
export interface AguiResponse {
  message_id: string;
  /** confirm: true/false；question: 选项值；form: 字段键值 */
  decision: boolean | string | Record<string, unknown>;
  /** 驳回原因 / 补充说明 */
  reason?: string;
}

/* ─────────────── Plot Git 版本管理（§5） ─────────────── */

/** 基线快照：立项环选定方案后生成，前置设定不可变 */
export interface BaselineSnapshot {
  id: string;
  book_id: string;
  created_at: string;
  /** 方案卡片内容（基础信息/梗概/金手指/角色卡/世界观） */
  premise: Record<string, unknown>;
  /** 节奏矩阵（模板 + 参数） */
  pacing: PacingConfig;
  /** 版本线标识（默认 master） */
  branch: string;
}

/** 连载节奏与控字矩阵（§3.4） */
export interface PacingConfig {
  template: "web-rapid" | "short-reversal" | "traditional" | "custom";
  /** 单章字数区间 */
  words_per_chapter: { min: number; max: number };
  /** 循环推进周期（章） */
  macro_loop: number;
  /** 卷高潮爆发节点（章） */
  volume_climax_chapter: number;
  custom?: Record<string, unknown>;
}

/** Plot Git 版本记录（可审计） */
export interface VersionRecord {
  id: string;
  book_id: string;
  branch: string;
  type: "baseline" | "commit" | "branch" | "merge" | "lock" | "restore";
  message: string;
  author: string;          // "chief" | "user" | 专家 id
  created_at: string;
  parent_id: string | null;
  /** 变更文件/对象清单 */
  changed: string[];
}

/* ─────────────── 一致性引擎（§6） ─────────────── */

/** 事中拦截路由：A 状态不符 / B 规则冲突 / C 人设偏离 / D 风格违规 / E 基座违规 */
export type ConsistencyRoute = "A_state" | "B_rule" | "C_character" | "D_style" | "E_baseline";

/** 一致性拦截结果 */
export interface ConsistencyViolation {
  id: string;
  route: ConsistencyRoute;
  /** 知识中心（塑像/构世/谋篇+布景/淬文/主编） */
  knowledge_center: ExpertId;
  severity: "light" | "medium" | "heavy";
  /** 违规描述 */
  detail: string;
  /** 修正指令（Patch Prompt 素材） */
  patch_prompt: string;
  /** 命中基准：世界库预设规则 or 本书作品档案 */
  basis: "world_library" | "book_archive" | "baseline";
}
