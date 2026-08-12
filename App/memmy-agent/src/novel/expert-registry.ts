/**
 * 编委会专家注册表（主编中枢 + 创作八将 + 支撑四翼）
 *
 * 设计依据：docs/novel-design.md §1
 * 角色卡模板：templates/novel/experts/*.md（注册表与此保持同步）
 */
import { ExpertId, ExpertProfile } from "./types.js";

const ROLE_CARD_DIR = "templates/novel/experts";

/** 13 份专家档案（与 templates/novel/experts/*.md 一一对应） */
export const EXPERT_PROFILES: ExpertProfile[] = [
  /* ── 主编中枢 ── */
  {
    id: "chief",
    name: "主编",
    category: "chief",
    pipeline: null,
    roleCard: `${ROLE_CARD_DIR}/chief.md`,
    duties: [
      "需求理解与立项（多方案卡片呈报）",
      "任务拆解与派单（创作指令单）",
      "Pipeline 编排：中断/恢复/锁定/回退",
      "中间结果审阅、采纳/驳回决策（AG-UI 卡片）",
      "文风统一与全书质量终审",
    ],
    outputs: ["《创作方案卡片×3》", "《创作指令单》", "《终审意见》", "《基线快照》"],
    trigger: "贯穿全程",
  },

  /* ── 创作八将（Pipeline 顺序 1-8） ── */
  {
    id: "ling-si",
    name: "灵思",
    category: "creation",
    pipeline: 1,
    roleCard: `${ROLE_CARD_DIR}/ling-si.md`,
    duties: [
      "题材定位、脑洞创意、卖点组合",
      "爽点框架设计、开篇思路",
      "立项入口产出 3 个方案卡片（一句话/套用/对撞）",
    ],
    outputs: ["《方案卡片×3》", "《爽点框架》"],
    trigger: "立项",
  },
  {
    id: "gou-shi",
    name: "构世",
    category: "creation",
    pipeline: 2,
    roleCard: `${ROLE_CARD_DIR}/gou-shi.md`,
    duties: [
      "世界观、力量体系、地图疆域、底层规则自洽",
      "可取材世界库通用规则，产出本书专属设定",
    ],
    outputs: ["《作品设定集》→ 写入本书作品档案"],
    trigger: "立项/开新卷",
    asKnowledgeCenter: true, // 一致性路由 B：规则冲突
  },
  {
    id: "su-xiang",
    name: "塑像",
    category: "creation",
    pipeline: 3,
    roleCard: `${ROLE_CARD_DIR}/su-xiang.md`,
    duties: [
      "人物小传、性格言行一致性、成长弧光、关系网",
      "防「标签式纸片人」：行为心理逻辑校验",
    ],
    outputs: ["《人物档案集》→ 写入本书作品档案"],
    trigger: "立项/新人物",
    asKnowledgeCenter: true, // 一致性路由 A：状态不符
  },
  {
    id: "mou-pian",
    name: "谋篇",
    category: "creation",
    pipeline: 4,
    roleCard: `${ROLE_CARD_DIR}/mou-pian.md`,
    duties: [
      "主线支线、卷结构、卷纲章纲、节奏曲线",
      "19 线叙事矩阵的建立与维护（分卷蓝图）",
    ],
    outputs: ["《全书纲》", "《卷纲》", "《章纲》", "《分卷蓝图》"],
    trigger: "每卷/每章",
    asKnowledgeCenter: true, // 一致性路由 C：剧情与场景中心（与布景协作）
  },
  {
    id: "mai-xian",
    name: "埋线",
    category: "creation",
    pipeline: 5,
    roleCard: `${ROLE_CARD_DIR}/mai-xian.md`,
    duties: [
      "伏笔设计/埋设/回收规划",
      "伏笔状态机 + 19 线叙事矩阵主人（章节细纲插针）",
    ],
    outputs: ["《伏笔总账》", "《线索矩阵》"],
    trigger: "立项/每卷/每章",
  },
  {
    id: "zhi-bi",
    name: "执笔",
    category: "creation",
    pipeline: 6,
    roleCard: `${ROLE_CARD_DIR}/zhi-bi.md`,
    duties: [
      "正文写作（按节奏矩阵控字）",
      "黄金三章成稿、日更产出",
    ],
    outputs: ["《正文成稿》"],
    trigger: "大纲确认后",
  },
  {
    id: "cui-wen",
    name: "淬文",
    category: "creation",
    pipeline: 7,
    roleCard: `${ROLE_CARD_DIR}/cui-wen.md`,
    duties: [
      "文笔润色、对白打磨、语言风格统一",
      "去 AI 味引擎（De-AI Engine）主控：黑名单/感官化/后置洗稿",
    ],
    outputs: ["《润色稿》", "《文风手册》"],
    trigger: "成稿后/实时洗稿",
    asKnowledgeCenter: true, // 一致性路由 D：风格违规
  },
  {
    id: "shen-xiao",
    name: "审校",
    category: "creation",
    pipeline: 8,
    roleCard: `${ROLE_CARD_DIR}/shen-xiao.md`,
    duties: [
      "逻辑漏洞、设定查重（世界库预设规则 + 本书作品档案双基准）",
      "一致性校验、伏笔回收核验（对照线索矩阵）",
    ],
    outputs: ["《审校报告》"],
    trigger: "每章/每卷",
  },

  /* ── 支撑四翼（横向服务，不占 Pipeline） ── */
  {
    id: "bu-jing",
    name: "布景",
    category: "support",
    pipeline: null,
    roleCard: `${ROLE_CARD_DIR}/bu-jing.md`,
    duties: [
      "场景/环境/战斗场面描写素材",
      "配合执笔随时调用，产出场景卡入素材库",
    ],
    outputs: ["《场景卡》→ 写入素材库"],
    trigger: "随时（配合执笔）",
    asKnowledgeCenter: true, // 一致性路由 C：剧情与场景中心（与谋篇协作）
  },
  {
    id: "jian-gong",
    name: "监工",
    category: "support",
    pipeline: null,
    roleCard: `${ROLE_CARD_DIR}/jian-gong.md`,
    duties: [
      "字数/进度/更新节奏度量",
      "爽点密度与情绪曲线量化、伏笔逾期预警（19 线扫描）",
      "数据化复盘",
    ],
    outputs: ["《度量报告》", "《情绪曲线》"],
    trigger: "随时（主编/用户）",
  },
  {
    id: "zhuang-zhen",
    name: "装帧",
    category: "support",
    pipeline: null,
    roleCard: `${ROLE_CARD_DIR}/zhuang-zhen.md`,
    duties: [
      "交付导出（EPUB/DOCX/Markdown）",
      "排版、封面生成对接",
    ],
    outputs: ["《成品书》", "《导出包》"],
    trigger: "交付时",
  },
  {
    id: "shi-du",
    name: "试读",
    category: "support",
    pipeline: null,
    roleCard: `${ROLE_CARD_DIR}/shi-du.md`,
    duties: [
      "读者视角试读、弃书点排查、代入感反馈",
      "黄金三章检验",
    ],
    outputs: ["《试读报告》"],
    trigger: "开篇/卷末",
  },
];

/** 编委会注册表：13 专家的查找与分类 */
export class ExpertRegistry {
  private byId = new Map<ExpertId, ExpertProfile>(EXPERT_PROFILES.map((p) => [p.id, p]));

  get(id: ExpertId): ExpertProfile {
    const profile = this.byId.get(id);
    if (!profile) throw new Error(`unknown expert: ${id}`);
    return profile;
  }

  has(id: ExpertId): boolean {
    return this.byId.has(id);
  }

  /** 创作八将（按 Pipeline 顺序） */
  creationTeam(): ExpertProfile[] {
    return EXPERT_PROFILES
      .filter((p) => p.category === "creation")
      .sort((a, b) => (a.pipeline ?? 0) - (b.pipeline ?? 0));
  }

  /** 支撑四翼 */
  supportTeam(): ExpertProfile[] {
    return EXPERT_PROFILES.filter((p) => p.category === "support");
  }

  /** 一致性引擎知识中心（A/B/C/D 路由的目标专家） */
  knowledgeCenters(): ExpertProfile[] {
    return EXPERT_PROFILES.filter((p) => p.asKnowledgeCenter);
  }

  all(): ExpertProfile[] {
    return [...EXPERT_PROFILES];
  }
}
