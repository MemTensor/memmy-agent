/** Demo skill data for screenshot workflows. */
import type { GetMemoryOutput, PanelItemsOutput } from "@memmy/local-api-contracts";

export interface DemoSkillTimelineEntry {
  ts: string;
  kind: string;
  phase?: string;
  durationMs: number;
  success: boolean;
  summary?: string;
}

const demoServerTime = "2026-07-07T10:00:00.000+08:00";

const demoSkillItems: PanelItemsOutput["items"] = [
  {
    id: "skill_8f3c6b2d91a74e0c5b38",
    kind: "skill",
    memoryLayer: "Skill",
    status: "activated",
    title: "发布前回归风险扫描",
    summary: "合并或发布前按 diff、测试、打包和签名路径扫描高概率回归点。",
    tags: ["release", "risk", "codex"],
    createdAt: "2026-06-27T09:18:00.000+08:00",
    updatedAt: "2026-07-06T14:42:00.000+08:00",
    version: 6
  },
  {
    id: "skill-demo-gui-screenshot-qa",
    kind: "skill",
    memoryLayer: "Skill",
    status: "activated",
    title: "前端截图验收编排",
    summary: "为桌面 GUI 变更生成可截图状态，覆盖列表、抽屉、空态和窄屏视口。",
    tags: ["gui", "qa", "playwright"],
    createdAt: "2026-06-24T16:05:00.000+08:00",
    updatedAt: "2026-07-05T17:36:00.000+08:00",
    version: 5
  },
  {
    id: "skill-demo-retrieval-noise",
    kind: "skill",
    memoryLayer: "Skill",
    status: "resolving",
    title: "记忆召回噪声压缩",
    summary: "当召回结果过宽时，先按任务意图裁剪，再保留能直接影响下一步动作的证据。",
    tags: ["memory", "retrieval", "ranking"],
    createdAt: "2026-06-30T11:45:00.000+08:00",
    updatedAt: "2026-07-04T20:14:00.000+08:00",
    version: 4
  },
  {
    id: "skill-demo-agent-distribution",
    kind: "skill",
    memoryLayer: "Skill",
    status: "archived",
    title: "多端 Agent Skill 分发",
    summary: "向 Cursor、Codex、Claude Code 等目标写入统一记忆 Skill，并记录权限差异。",
    tags: ["agent", "skill", "distribution"],
    createdAt: "2026-06-18T13:20:00.000+08:00",
    updatedAt: "2026-07-01T09:50:00.000+08:00",
    version: 3
  }
];

const demoSkillDetails: Record<string, GetMemoryOutput> = Object.fromEntries(
  demoSkillItems.map((item) => [item.id, createDemoSkillDetail(item)])
);

const demoSkillTimelines: Record<string, DemoSkillTimelineEntry[]> = {
  "skill_8f3c6b2d91a74e0c5b38": [
    {
      ts: "2026-07-06T14:42:00.000+08:00",
      kind: "skill.eta.updated",
      durationMs: 18,
      success: true,
      summary: "v6: 根据 Electron 打包失败样本提高签名、dmg window bounds、auto-update 三类检查权重。"
    },
    {
      ts: "2026-07-04T18:25:00.000+08:00",
      kind: "skill.rebuilt",
      durationMs: 64,
      success: true,
      summary: "v5: 把 smoke test 和本地 runtime health check 合并为发布前门禁。"
    },
    {
      ts: "2026-07-02T11:10:00.000+08:00",
      kind: "skill.rebuilt",
      durationMs: 57,
      success: true,
      summary: "v4: 新增变更面扫描，按 backend、frontend、shell 归类回归风险。"
    },
    {
      ts: "2026-06-29T20:35:00.000+08:00",
      kind: "skill.verification.failed",
      durationMs: 31,
      success: false,
      summary: "v3: 尝试加入全量 e2e 阻塞策略，因耗时过长被回滚。"
    },
    {
      ts: "2026-06-27T09:18:00.000+08:00",
      kind: "skill.crystallized",
      durationMs: 44,
      success: true,
      summary: "v1: 从两次发布漏检复盘中结晶初版 checklist。"
    }
  ],
  "skill-demo-gui-screenshot-qa": [
    {
      ts: "2026-07-05T17:36:00.000+08:00",
      kind: "skill.rebuilt",
      durationMs: 49,
      success: true,
      summary: "v5: 固定 1440x960 和 390x844 两个截图视口，减少布局漂移。"
    },
    {
      ts: "2026-07-03T12:22:00.000+08:00",
      kind: "skill.eta.updated",
      durationMs: 13,
      success: true,
      summary: "v4: 将抽屉详情、timeline 和列表选中态列为必拍区域。"
    },
    {
      ts: "2026-06-30T15:04:00.000+08:00",
      kind: "skill.rebuilt",
      durationMs: 52,
      success: true,
      summary: "v3: 加入 canvas pixel check，避免空白页被误判为通过。"
    },
    {
      ts: "2026-06-24T16:05:00.000+08:00",
      kind: "skill.crystallized",
      durationMs: 36,
      success: true,
      summary: "v1: 从记忆面板截图任务沉淀出首版验收流程。"
    }
  ],
  "skill-demo-retrieval-noise": [
    {
      ts: "2026-07-04T20:14:00.000+08:00",
      kind: "skill.status.changed",
      durationMs: 9,
      success: true,
      summary: "v4: 仍处候选态，等待更多真实召回失败样本验证。"
    },
    {
      ts: "2026-07-02T19:48:00.000+08:00",
      kind: "skill.rebuilt",
      durationMs: 41,
      success: true,
      summary: "v3: 加入任务动词过滤，优先保留能改变下一步动作的记忆。"
    },
    {
      ts: "2026-06-30T11:45:00.000+08:00",
      kind: "skill.crystallized",
      durationMs: 33,
      success: true,
      summary: "v1: 从一次过宽召回复盘中提炼初版压缩策略。"
    }
  ],
  "skill-demo-agent-distribution": [
    {
      ts: "2026-07-01T09:50:00.000+08:00",
      kind: "skill.archived",
      durationMs: 7,
      success: true,
      summary: "v3: 被新的插件分发流程替代，归档保留历史。"
    },
    {
      ts: "2026-06-23T10:30:00.000+08:00",
      kind: "skill.rebuilt",
      durationMs: 55,
      success: true,
      summary: "v2: 区分 scan_only 与 scan_and_write_skill 权限。"
    },
    {
      ts: "2026-06-18T13:20:00.000+08:00",
      kind: "skill.crystallized",
      durationMs: 39,
      success: true,
      summary: "v1: 首次支持多端 Agent 写入统一记忆 Skill。"
    }
  ]
};

export function isSkillsDemoEnabled(search = typeof window === "undefined" ? "" : window.location?.search ?? ""): boolean {
  const value = new URLSearchParams(search).get("demoSkills");
  return value === "1" || value === "true";
}

export function demoSkillPanelItems(query = "", page = 1): PanelItemsOutput {
  const q = query.trim().toLowerCase();
  const pageSize = 20;
  const currentPage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const filtered = demoSkillItems.filter((item) => {
    if (!q) return true;
    return [item.id, item.title, item.summary, ...item.tags].some((value) => value.toLowerCase().includes(q));
  });
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    items: filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    page: currentPage,
    pageSize,
    total,
    totalPages,
    hasNext: currentPage < totalPages,
    hasPrev: currentPage > 1,
    serverTime: demoServerTime
  };
}

export function demoSkillDetail(skillId: string): GetMemoryOutput | undefined {
  return demoSkillDetails[skillId];
}

export function demoSkillTimeline(skillId: string): DemoSkillTimelineEntry[] {
  return demoSkillTimelines[skillId] ?? [];
}

function createDemoSkillDetail(item: PanelItemsOutput["items"][number]): GetMemoryOutput {
  const skill = demoSkillMetadata(item.id);

  return {
    item: {
      ...item,
      body: demoSkillBody(item.title, skill.invocationGuide, skill.procedure),
      sourceMemoryIds: skill.sourcePolicyIds,
      metadata: {
        source: skill.source,
        properties: {
          internal_info: {
            skill
          }
        }
      },
      skill: {
        invocationGuide: skill.invocationGuide,
        procedure: skill.procedure,
        sourcePolicyIds: skill.sourcePolicyIds,
        sourceWorldModelIds: skill.sourceWorldModelIds,
        reliabilityScore: skill.eta,
        utilityScore: skill.gain,
        evidenceCount: skill.evidenceAnchors.length
      }
    },
    refs: {},
    version: item.version,
    etag: `demo-${item.id}-v${item.version}`
  };
}

function demoSkillMetadata(id: string) {
  const common = {
    source: "codex",
    status: "activated",
    evidenceAnchors: ["trace-release-rollback", "trace-gui-polish", "trace-runtime-health"],
    sourcePolicyIds: ["policy-test-before-ship", "policy-keep-change-scoped"],
    sourceWorldModelIds: ["world-desktop-local-runtime"],
    support: 18,
    usageCount: 26,
    trialsAttempted: 12,
    trialsPassed: 10,
    lastUsedAt: "2026-07-06T16:10:00.000+08:00"
  };

  switch (id) {
    case "skill-demo-gui-screenshot-qa":
      return {
        ...common,
        eta: 0.887,
        gain: 0.341,
        support: 14,
        usageCount: 19,
        invocationGuide: "当用户需要 GUI 截图、视觉验收或页面状态造数时调用。",
        procedure: [
          "锁定目标路由和可复现参数。",
          "准备能同时暴露列表、详情和状态变化的数据。",
          "用桌面与移动视口分别检查文本截断、抽屉遮挡和空白渲染。"
        ],
        decisionGuidance: {
          preference: ["优先构造一屏能说明变化的数据。", "截图前确认抽屉、选中态和长文本都已出现。"],
          antiPattern: ["不要用只展示空态的数据作为最终截图。", "不要依赖真实账号里的随机历史。"]
        }
      };
    case "skill-demo-retrieval-noise":
      return {
        ...common,
        status: "resolving",
        eta: 0.713,
        gain: 0.196,
        support: 8,
        usageCount: 7,
        trialsAttempted: 7,
        trialsPassed: 4,
        invocationGuide: "当记忆召回结果过多、重复或与当前任务弱相关时调用。",
        procedure: [
          "先保留与当前动词、文件、实体直接相关的记忆。",
          "删除只重复背景信息、不能改变下一步操作的片段。",
          "将剩余记忆按执行顺序重排。"
        ],
        decisionGuidance: {
          preference: ["保留能改变实现方案或验证方式的证据。"],
          antiPattern: ["不要把所有相似记忆都塞进上下文。"]
        }
      };
    case "skill-demo-agent-distribution":
      return {
        ...common,
        status: "archived",
        eta: 0.622,
        gain: 0.128,
        support: 11,
        usageCount: 12,
        invocationGuide: "当需要向多个外部 Agent 写入记忆 Skill 时参考历史流程。",
        procedure: [
          "识别目标 Agent 的 skill 目录与权限策略。",
          "写入统一 manifest 和 SKILL.md。",
          "记录安装、卸载和权限冲突结果。"
        ],
        decisionGuidance: {
          preference: ["仅作为历史参考，新任务优先走插件分发路径。"],
          antiPattern: ["不要在无写入权限时静默创建半成品 skill。"]
        }
      };
    default:
      return {
        ...common,
        eta: 0.934,
        gain: 0.418,
        invocationGuide: "当变更涉及发布、打包、签名、自动更新或跨模块合并前检查时调用。",
        procedure: [
          "先按 diff 归类 backend、frontend、shell、packaging 影响面。",
          "列出每个影响面的最小验证命令。",
          "对缺失验证、签名配置、迁移和 runtime health check 标红。",
          "把无法本地验证的风险写进最终交付说明。"
        ],
        decisionGuidance: {
          preference: ["优先检查近期失败过的发布路径。", "把验证命令和未验证风险一起交付。"],
          antiPattern: ["不要把单元测试通过等同于可发布。", "不要忽略打包脚本和运行时配置变化。"]
        }
      };
  }
}

function demoSkillBody(title: string, invocationGuide: string, procedure: string[]): string {
  return [
    `# ${title}`,
    "",
    "## Invocation",
    invocationGuide,
    "",
    "## Procedure",
    ...procedure.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Version Notes",
    "这个 skill 的 timeline 保留了每次结晶、重建、验证失败、归档或评分更新。"
  ].join("\n");
}
