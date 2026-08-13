/**
 * Demo dataset for the literature review agent workflow.
 *
 * The literature review page is a design-complete mock driven by this file:
 * requirement clarification -> keywords -> outline -> references -> auto
 * execution with a live to-do list and the file preview workspace.
 */

export const LITREV_PROMPT_STORAGE_KEY = "memmy.literatureReviewDemoPrompt";
export const LITREV_SOURCE_INPUT_STORAGE_KEY = "memmy.literatureReviewDemoSourceInput";
export const LITREV_CONTEXT_STORAGE_KEY = "memmy.literatureReviewDemoContexts";
export const LITREV_PROJECT_CONTEXT_STORAGE_KEY = "memmy.literatureReviewDemoProjectId";

export interface LitrevLaunchContext {
  kind: "path";
  id: string;
  label: string;
}

export const LITREV_DEFAULT_PROMPT = "帮我梳理近 5 年大模型长期记忆的研究进展，最后写成一篇中文综述。";

/* ---------------------------------- 需求澄清 ---------------------------------- */

export interface LitrevSetupQuestion {
  id: "topic" | "time";
  text: string;
  options: string[];
}

const ALL_SETUP_QUESTIONS: LitrevSetupQuestion[] = [
  { id: "topic", text: "这篇文献综述的主题 / 研究领域是什么？", options: ["沿用当前描述", "方法与系统", "应用与实践", "理论与发展脉络"] },
  { id: "time", text: "希望论文覆盖什么时间范围？", options: ["近 3 年", "近 5 年", "近 10 年", "不限"] }
];

/** Builds the two research-scope confirmations; other writing preferences stay agent-managed. */
export function buildLitrevSetupQuestions(prompt: string): LitrevSetupQuestion[] {
  return ALL_SETUP_QUESTIONS.map((question) => {
    if (question.id !== "time") return question;
    const matched = question.options.find((option) => prompt.replace(/\s/g, "").includes(option.replace(/\s/g, "")));
    return matched
      ? { ...question, options: [matched, ...question.options.filter((option) => option !== matched)] }
      : question;
  });
}

export const LITREV_TOPIC_QUESTION = "文献综述的研究主题/领域是什么？";

/* ---------------------------------- 会话台词 ---------------------------------- */

export const LITREV_ASSISTANT_INTRO = "我会先补齐缺失信息；你已经描述过的内容不会重复询问。";
export const LITREV_EXECUTION_INTRO = "研究方案已经确认。我先把任务列出来，然后整理资料、撰写正文并检查引用；有补充要求可以随时告诉我。";
export const LITREV_RESULT_LINE = "综述已经完成。我生成了 Markdown 大纲和正文，内容包含主要方法与系统对比、评测总结和参考文献。";
export const LITREV_SUPPLEMENT_ACK = "已记录这条补充，会在检索和写作时一并参考。";

export function litrevRunningLine(taskName: string): string {
  return `正在${taskName}，后续步骤将自动完成…`;
}

/* ---------------------------------- 向导数据 ---------------------------------- */

export interface LitrevKeyword {
  id: string;
  text: string;
  weight: number;
}

export function buildDemoKeywords(): LitrevKeyword[] {
  return [
    { id: "k1", text: "long-term memory", weight: 5 },
    { id: "k2", text: "LLM memory", weight: 5 },
    { id: "k3", text: "memory-augmented generation", weight: 4 },
    { id: "k4", text: "memory evaluation", weight: 3 }
  ];
}

export interface LitrevOutlineItem {
  id: string;
  text: string;
  level: 0 | 1;
}

export function buildDemoOutline(): LitrevOutlineItem[] {
  return [
    { id: "o1", text: "引言与研究范围", level: 0 },
    { id: "o2", text: "长期记忆的概念与分类", level: 1 },
    { id: "o3", text: "记忆表征与存储", level: 0 },
    { id: "o4", text: "写入、更新与遗忘机制", level: 0 },
    { id: "o5", text: "检索与上下文注入", level: 0 },
    { id: "o6", text: "评测方法与公开基准", level: 0 },
    { id: "o7", text: "开放问题与未来方向", level: 0 }
  ];
}

/**
 * Reorders an outline entry and applies its requested hierarchy level.
 * Top-level entries carry their existing level-two children when reordered.
 */
export function moveOutlineItem(
  items: LitrevOutlineItem[],
  fromIndex: number,
  targetIndex: number,
  requestedLevel: 0 | 1
): LitrevOutlineItem[] {
  if (!items[fromIndex] || !items[targetIndex]) return items;
  const source = items[fromIndex]!;
  let blockEnd = fromIndex + 1;
  if (source.level === 0) {
    while (blockEnd < items.length && items[blockEnd]?.level === 1) blockEnd += 1;
  }
  const block = items.slice(fromIndex, blockEnd);
  const targetInsideBlock = targetIndex >= fromIndex && targetIndex < blockEnd;
  const remaining = [
    ...items.slice(0, fromIndex),
    ...items.slice(blockEnd)
  ];
  const insertIndex = targetInsideBlock
    ? fromIndex
    : fromIndex < targetIndex
      ? targetIndex - block.length + 1
      : targetIndex;
  const safeInsertIndex = Math.max(0, Math.min(insertIndex, remaining.length));
  const hasParentBefore = remaining
    .slice(0, safeInsertIndex)
    .some((item) => item.level === 0);
  const level: 0 | 1 = requestedLevel === 1 && hasParentBefore ? 1 : 0;
  const movedBlock = [{ ...block[0]!, level }, ...block.slice(1)];
  return [
    ...remaining.slice(0, safeInsertIndex),
    ...movedBlock,
    ...remaining.slice(safeInsertIndex)
  ];
}

export interface LitrevReference {
  id: string;
  title: string;
  meta: string;
  /** Where the paper comes from: online search or user-provided local files. */
  source: "web" | "local";
  selected: boolean;
}

export function buildDemoReferences(): LitrevReference[] {
  return [
    { id: "r1", title: "MemGPT: Towards LLMs as Operating Systems", meta: "Packer et al. · 2023", source: "web", selected: true },
    { id: "r2", title: "MemoryBank: Enhancing Large Language Models with Long-Term Memory", meta: "Zhong et al. · 2024", source: "local", selected: true },
    { id: "r3", title: "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", meta: "Wu et al. · 2024", source: "web", selected: true },
    { id: "r4", title: "Generative Agents: Interactive Simulacra of Human Behavior", meta: "Park et al. · 2023", source: "local", selected: false },
    { id: "r5", title: "A Survey on the Memory Mechanism of LLM-based Agents", meta: "2024 · 仅摘要", source: "web", selected: true }
  ];
}

/* --------------------------------- 思考/执行阶段 --------------------------------- */

export interface LitrevThinkingPhase {
  title: string;
  stages: string[];
  /** Completion note shown once the matching stage finished (index-aligned, optional). */
  doneNotes?: string[];
}

export const LITREV_PLANNING_PHASE: LitrevThinkingPhase = {
  title: "正在根据研究要求生成检索策略",
  stages: ["解析研究范围与写作规范", "确定关键词维度", "生成同义词、缩写与排除词"]
};

export const LITREV_OUTLINE_PHASE: LitrevThinkingPhase = {
  title: "正在生成综述大纲",
  stages: ["分析关键词权重与排除词", "映射研究问题和章节关系", "生成分层大纲与章节目标"]
};

export const LITREV_SEARCH_PHASE: LitrevThinkingPhase = {
  title: "正在检索参考文献",
  stages: ["扩展 12 组中英文关键词", "检索 arXiv、Semantic Scholar 与 Crossref", "探测摘要、直链与访问状态", "去重并按相关性排序"],
  doneNotes: ["已生成关键词组合", "已获取 126 条结果", "31 篇全文 · 11 篇摘要", "去重后 42 篇"]
};

export const LITREV_EXECUTION_PHASE: LitrevThinkingPhase = {
  title: "正在生成执行计划",
  stages: ["确认最终纳入文献与全文状态", "准备任务文件", "生成自动执行 To-do"]
};

/** Tool-call history lines accumulated in the conversation while the wizard advances. */
export const LITREV_LOG_ANALYZED = "已分析研究要求并生成关键词策略";
export const LITREV_LOG_KEYWORDS_CONFIRMED = "已确认检索关键词";
export const LITREV_LOG_OUTLINE_GENERATED = "已根据关键词、研究范围和规范生成综述大纲";
export const LITREV_LOG_OUTLINE_CONFIRMED = "已确认综述大纲";
export const LITREV_LOG_SEARCH_DONE = "检索 12 组关键词，获得 126 条结果，去重后保留 42 篇候选文献";
export const LITREV_LOG_PLAN_READY = "已生成自动执行计划";

export function litrevReferencesConfirmedLog(count: number): string {
  return `已确认 ${count} 篇参考文献`;
}

/* ---------------------------------- To-do ---------------------------------- */

export const LITREV_TODO_ITEMS = ["下载并验证文献", "批量阅读", "撰写正文", "生成参考文献", "引用检查"];

/* ---------------------------------- 预览文件 ---------------------------------- */

export type LitrevPreviewFolder = "uploads" | "references" | "outputs";

export interface LitrevTaskFile {
  folder: LitrevPreviewFolder;
  path: string;
  name: string;
}

/** Primary artifacts produced by the mocked execution run. */
export const LITREV_OUTLINE_ARTIFACT = "outputs/大模型长期记忆-大纲.md";
export const LITREV_BODY_ARTIFACT = "outputs/大模型长期记忆-正文.md";

/** Default file selected when the workspace drawer opens. */
export const LITREV_DEFAULT_WORKSPACE_FILE = "uploads/研究要求.docx";

export function buildDemoTaskFiles(): LitrevTaskFile[] {
  return [
    { folder: "uploads", path: "uploads/研究要求.docx", name: "研究要求.docx" },
    { folder: "references", path: "references/MemGPT.pdf", name: "MemGPT.pdf" },
    { folder: "references", path: "references/MemoryBank.pdf", name: "MemoryBank.pdf" },
    { folder: "references", path: "references/LongMemEval.pdf", name: "LongMemEval.pdf" },
    { folder: "outputs", path: "outputs/大模型长期记忆-大纲.md", name: "大模型长期记忆-大纲.md" },
    { folder: "outputs", path: "outputs/大模型长期记忆-正文.md", name: "大模型长期记忆-正文.md" },
    { folder: "outputs", path: "outputs/大模型长期记忆-正文.docx", name: "大模型长期记忆-正文.docx" }
  ];
}

export interface LitrevPreviewSection {
  heading: string;
  body: string;
}

export interface LitrevPreviewContent {
  title: string;
  sections: LitrevPreviewSection[];
}

const OUTLINE_PREVIEW: LitrevPreviewContent = {
  title: "大模型长期记忆：文献综述大纲",
  sections: [
    { heading: "1. 引言与研究范围", body: "梳理大模型长期记忆的发展脉络、核心问题与研究边界；明确综述覆盖近 5 年方法与系统，不含纯参数编辑。" },
    { heading: "2. 记忆表征与存储", body: "比较向量记忆、结构化记忆和混合记忆方案，讨论记忆粒度与索引结构的取舍。" },
    { heading: "3. 写入、更新与遗忘机制", body: "分析记忆生命周期和冲突处理机制：写入门控、重要性评分、淘汰与压缩策略。" },
    { heading: "4. 检索与上下文注入", body: "总结查询构造、重排序与上下文注入方式对长程一致性的影响。" },
    { heading: "5. 评测方法与公开基准", body: "汇总 LongMemEval、MemBench 等基准的任务设定与指标，比较不同系统的可复现实验结果。" },
    { heading: "6. 开放问题与未来方向", body: "指出跨会话个性化、隐私与遗忘合规、多智能体共享记忆等开放问题。" }
  ]
};

const BODY_PREVIEW: LitrevPreviewContent = {
  title: "大模型长期记忆：方法、系统与评测",
  sections: [
    { heading: "1. 引言与研究范围", body: "长期记忆使大模型能够跨会话保留用户偏好、任务状态与领域知识。本文按表征、写入、检索与评测四个维度组织近 5 年代表性工作，重点比较方法与系统实现。" },
    { heading: "2. 记忆表征与存储", body: "MemGPT 将操作系统的分页思想引入上下文管理；MemoryBank 采用带遗忘曲线的向量记忆。结构化记忆以事件与属性图为主，混合方案则结合两者以平衡召回率与可解释性。" },
    { heading: "3. 写入、更新与遗忘机制", body: "写入门控决定哪些交互进入长期记忆；更新机制处理冲突与冗余；遗忘策略基于时间衰减或重要性评分。三者共同决定记忆库的信噪比。" },
    { heading: "4. 检索与上下文注入", body: "检索侧重查询重写、多路召回与重排序；注入侧重位置、格式与预算控制。LongMemEval 的消融实验表明检索质量是长程一致性的主要瓶颈。" },
    { heading: "5. 评测方法与公开基准", body: "现有基准从对话一致性、事实追溯与长程任务完成率三个角度评测记忆能力；公开结果显示混合记忆系统在多数任务上优于纯向量方案。" },
    { heading: "参考文献", body: "[1] Packer et al. MemGPT: Towards LLMs as Operating Systems. 2023.\n[2] Zhong et al. MemoryBank: Enhancing LLMs with Long-Term Memory. 2024.\n[3] Wu et al. LongMemEval. 2024.\n[4] A Survey on the Memory Mechanism of LLM-based Agents. 2024." }
  ]
};

const PDF_PREVIEW: LitrevPreviewContent = {
  title: "文献资料预览",
  sections: [
    { heading: "PDF 全文已获取", body: "该文献的 PDF 全文已下载到本机任务目录，可用于批量阅读、证据抽取和引用核对。" }
  ]
};

const DOCX_PREVIEW: LitrevPreviewContent = {
  title: "Office 文档预览",
  sections: [
    { heading: "文档已就绪", body: "该文件将使用 Office 预览打开；导出的 .docx 与 Markdown 正文内容保持一致。" }
  ]
};

/** Resolves the mocked preview content for a given file path. */
export function litrevPreviewContentFor(path: string): LitrevPreviewContent {
  if (path.endsWith(".pdf")) return PDF_PREVIEW;
  if (path.endsWith(".docx") && !path.includes("正文")) return DOCX_PREVIEW;
  if (path.endsWith(".docx")) return DOCX_PREVIEW;
  if (path.includes("大纲")) return OUTLINE_PREVIEW;
  if (path.includes("正文")) return BODY_PREVIEW;
  return {
    title: path.split("/").pop() ?? path,
    sections: [{ heading: "文件预览", body: "该文件的内容会在这里展示，可确认任务材料、项目文件或本机资料。" }]
  };
}

/* ------------------------------- 首页能力与引用 mock ------------------------------ */

export interface HomeCapabilityItem {
  command: string;
  name: string;
  hint: string;
  /** Visual accent used by the capability strip icon. */
  tone: "literature" | "slides" | "html" | "sheet" | "doc" | "more";
}

export function buildHomeCapabilities(): HomeCapabilityItem[] {
  return [
    { command: "/literature-review", name: "文献综述", hint: "检索、阅读、写作和引用检查", tone: "literature" },
    { command: "/pptx", name: "生成幻灯片", hint: "生成演示文稿", tone: "slides" },
    { command: "/html", name: "生成 HTML", hint: "生成可运行网页", tone: "html" },
    { command: "/spreadsheet", name: "表格分析", hint: "分析 Excel / CSV", tone: "sheet" },
    { command: "/document", name: "文档编辑", hint: "创建和修改文档", tone: "doc" }
  ];
}

export interface HomeReferenceItem {
  path: string;
  kind: "file" | "folder";
  meta: string;
}

export function buildHomeReferenceItems(): HomeReferenceItem[] {
  return [
    { path: "本地文献/", kind: "folder", meta: "12 个文件" },
    { path: "开题报告.docx", kind: "file", meta: "DOCX" },
    { path: "研究范围.md", kind: "file", meta: "Markdown" },
    { path: "文献对照表.xlsx", kind: "file", meta: "Excel" }
  ];
}
