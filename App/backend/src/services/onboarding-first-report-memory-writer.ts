import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { OnboardingTaskContextSummary } from "./onboarding-task-context.js";

const FIRST_REPORT_SOURCE = "memmy-onboarding";
const FIRST_REPORT_PROCESSING_TIMEOUT_MS = 180_000;
const FIRST_REPORT_HANDOFF_QUERY_ZH = "请接着我刚才在 Memmy 里的初见报告继续聊天。先告诉我我们已经确定了什么，再给出一个最合适的下一步。";
const FIRST_REPORT_HANDOFF_QUERY_EN = "Please continue from the first report I just had in Memmy. First tell me what we already decided, then give me the single best next step.";
const FIRST_REPORT_TAGS = [
  "agent-source",
  "memmy",
  "first-encounter-report",
  "cross-agent-handoff"
] as const;

export interface OnboardingFirstReportMemoryInput {
  locale: "zh-CN" | "en-US";
  reportMarkdown: string;
  projects: readonly string[];
  keywords: readonly string[];
  taskContext: OnboardingTaskContextSummary;
  latestConversation: {
    agentSource: string;
    conversationId: string;
    workspacePath: string | null;
  };
}

export interface OnboardingFirstReportMemoryWriter {
  write(input: OnboardingFirstReportMemoryInput): Promise<void>;
}

export function createOnboardingFirstReportMemoryWriter(
  memoryClient: Pick<
    MemoryClient,
    "addMemory" | "enqueueImportSummaries" | "getMemoryProcessingStatus" | "runWorker" | "search"
  >,
  now: () => number = Date.now
): OnboardingFirstReportMemoryWriter {
  return {
    async write(input) {
      const stableId = shortHash(`${input.latestConversation.agentSource}:${input.latestConversation.conversationId}`);
      const memory = await memoryClient.addMemory({
        requestId: `first-report:${stableId}`,
        adapterId: `agent-source:${FIRST_REPORT_SOURCE}`,
        content: renderMemoryContent(input),
        layer: "L1",
        title: firstReportTitle(input),
        tags: uniqueStrings([
          ...FIRST_REPORT_TAGS,
          ...(input.locale === "zh-CN" ? ["初见报告", "首次登录"] : []),
          ...input.projects,
          ...input.keywords
        ]),
        source: FIRST_REPORT_SOURCE,
        turnId: `first-report:${stableId}`,
        deferProcessing: true
      });

      await memoryClient.enqueueImportSummaries([memory.id]);
      await processFirstReportMemory(memoryClient, memory.id, now);
      await memoryClient.search({
        requestId: `first-report-search-log:${shortHash(`${stableId}:${input.reportMarkdown}`)}`,
        adapterId: `agent-source:${FIRST_REPORT_SOURCE}`,
        source: FIRST_REPORT_SOURCE,
        query: firstReportHandoffQuery(input.locale, input.latestConversation.workspacePath),
        layers: ["L1"]
      });
    }
  };
}

function renderMemoryContent(input: OnboardingFirstReportMemoryInput): string {
  const isChinese = input.locale === "zh-CN";
  const unknown = isChinese ? "未知" : "unknown";
  const projects = input.projects.join(", ") || unknown;
  const keywords = input.keywords.join(", ") || unknown;
  const context = input.taskContext;
  const none = isChinese ? "无" : "None";

  if (isChinese) {
    return [
      "## user",
      "Memmy 初见报告：跨 Agent 任务接续记忆",
      "语言：中文",
      `来源 Agent：${input.latestConversation.agentSource}`,
      `项目路径：${input.latestConversation.workspacePath ?? unknown}`,
      `项目：${projects}`,
      `关键词：${keywords}`,
      "检索关键词：Memmy、初见报告、首次登录报告、最近项目、最近任务、接续任务",
      `接续触发词：${FIRST_REPORT_HANDOFF_QUERY_ZH}`,
      "任务上下文（由最近会话轨迹归纳，不含原始对话流水）",
      `主题：${context.topic || none}`,
      `用户目标：${context.userGoal || none}`,
      `最近请求：${context.latestRequest || none}`,
      `任务状态：${chineseTaskStatus(context.status)}`,
      `当前状态：${context.currentState || none}`,
      renderList("Agent 已执行", context.agentActions, none),
      renderList("已验证结果", context.verifiedResults, none),
      renderList("仍待处理", context.unresolvedItems, none),
      `接续位置：${context.continuationPoint || none}`,
      `轨迹总结：\n${context.trajectorySummary || none}`,
      "## assistant",
      "Memmy 初见报告",
      input.reportMarkdown
    ].join("\n\n");
  }

  return [
    "## user",
    "Memmy First Encounter Report: cross-Agent task handoff memory",
    "Language: English",
    `Source Agent: ${input.latestConversation.agentSource}`,
    `Workspace: ${input.latestConversation.workspacePath ?? unknown}`,
    `Projects: ${projects}`,
    `Keywords: ${keywords}`,
    "Retrieval aliases: Memmy, first encounter report, onboarding report, recent project, latest task, continue task",
    `Continuation trigger: ${FIRST_REPORT_HANDOFF_QUERY_EN}`,
    "Task context summarized from the latest conversation trajectory; raw transcript omitted",
    `Topic: ${context.topic || none}`,
    `User goal: ${context.userGoal || none}`,
    `Latest request: ${context.latestRequest || none}`,
    `Task status: ${context.status}`,
    `Current state: ${context.currentState || none}`,
    renderList("Agent actions", context.agentActions, none),
    renderList("Verified results", context.verifiedResults, none),
    renderList("Unresolved items", context.unresolvedItems, none),
    `Continuation point: ${context.continuationPoint || none}`,
    `Trajectory summary:\n${context.trajectorySummary || none}`,
    "## assistant",
    "Memmy First Encounter Report",
    input.reportMarkdown
  ].join("\n\n");
}

function chineseTaskStatus(status: OnboardingTaskContextSummary["status"]): string {
  return {
    pending: "待处理",
    active: "进行中",
    waiting: "等待确认",
    completed: "已完成",
    uncertain: "不确定"
  }[status];
}

function renderList(title: string, values: readonly string[], emptyLabel: string): string {
  const separator = /\p{Script=Han}/u.test(title) ? "：" : ":";
  return `${title}${separator}\n${values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : `- ${emptyLabel}`}`;
}

async function processFirstReportMemory(
  memoryClient: Pick<MemoryClient, "getMemoryProcessingStatus" | "runWorker">,
  memoryId: string,
  now: () => number
): Promise<void> {
  const deadline = now() + FIRST_REPORT_PROCESSING_TIMEOUT_MS;
  while (now() < deadline) {
    const processing = (await memoryClient.getMemoryProcessingStatus([memoryId])).items[0];
    if (!processing) {
      throw new Error(`First-report memory processing state is missing: ${memoryId}`);
    }
    if (processing.state === "ready") {
      return;
    }
    if (processing.state === "failed" || processing.state === "ready_text_only") {
      throw new Error(`First-report memory was not indexed: ${processing.state}`);
    }

    const run = await memoryClient.runWorker({
      limit: 4,
      targetMemoryIds: [memoryId],
      priorityCohortOnly: true,
      timeoutMs: FIRST_REPORT_PROCESSING_TIMEOUT_MS
    });
    if (run.leased === 0 && run.embeddingRetries.leased === 0) {
      await delay(100);
    }
  }
  throw new Error(`First-report memory indexing timed out: ${memoryId}`);
}

function firstReportTitle(input: OnboardingFirstReportMemoryInput): string {
  const topic = input.taskContext.topic || input.projects[0] || input.keywords[0];
  const base = input.locale === "zh-CN" ? "Memmy 初见报告" : "Memmy First Encounter Report";
  return topic ? `${base} — ${topic}` : base;
}

function firstReportHandoffQuery(locale: "zh-CN" | "en-US", workspacePath: string | null): string {
  const path = workspacePath?.trim();
  if (!path) {
    return locale === "zh-CN" ? FIRST_REPORT_HANDOFF_QUERY_ZH : FIRST_REPORT_HANDOFF_QUERY_EN;
  }
  return locale === "zh-CN"
    ? `请接着我刚才在 Memmy 里的初见报告继续聊天。最近任务的项目路径是：${path}。请先在这个路径下查看项目，再告诉我我们已经确定了什么，并给出一个最合适的下一步。`
    : `Please continue from the first report I just had in Memmy. The project path for the latest task is: ${path}. First inspect the project at that path, then tell me what we already decided and give me the single best next step.`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
