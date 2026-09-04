import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OnboardingInsightSampler,
  OnboardingSampleResult
} from "../../adapters/outbound/agent-source/insight-sampler-types.js";
import {
  createAgentTaskModelOnboardingInsightReportGenerator,
  createOnboardingInsightService,
  createOpenAiCompatibleOnboardingInsightReportGenerator,
  type OnboardingInsightGenerationInput
} from "../onboarding-insight-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("onboarding insight service", () => {
  it("uses all sources for preferences but bases the project report on only the latest conversation", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("cursor", "Cursor", [
          query("cursor", "1", "我的名字是 Grace，继续 Memmy 的 TypeScript React Tauri 扫描方案"),
          query("cursor", "2", "先讨论完整 plan，不修改代码，pnpm monorepo 里 onboarding report 怎么接")
        ]),
        sampler("claude_code", "Claude Code", [
          query("claude_code", "1", "Memmy memory scan 方案里增量水位线怎么设计，必须轻量，不能榨干 token")
        ])
      ],
      reportGenerator: null,
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.status).toBe("ready");
    expect(report.reportMarkdown).toContain("Hi");
    expect(report.reportMarkdown).toContain("先把方案");
    expect(report.reportMarkdown).not.toContain("轻量样本");
    expect(report.reportMarkdown).not.toContain("用户 query");
    expect(report.reportMarkdown).not.toContain("本机账号显示");
    expect(report.reportMarkdown).not.toContain("本机用户名/路径名显示");
    expect(report.reportMarkdown).toContain("Claude Code");
    expect(report.diagnostics).toMatchObject({
      discoveredAgentCount: 2,
      sampledQueryCount: 3,
      usedLlm: false
    });
  });

  it("does not mix Chinese and English name candidates", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("cursor", "Cursor", [
          query("cursor", "1", "我的名字是 Grace江，帮我看 Tauri build")
        ])
      ],
      reportGenerator: null,
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown.split("\n")[0]).not.toContain("Grace江");
    expect(report.reportMarkdown).toContain("Hi");
  });

  it("does not treat ordinary Chinese task phrases after 我是 as a name", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("cursor", "Cursor", [
          query("cursor", "1", "我是部署在云服务器上使用的，帮我检查 Agent 记忆配置")
        ])
      ],
      reportGenerator: null,
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown.split("\n")[0]).not.toContain("部署在云服务器上使用的");
    expect(report.reportMarkdown).toContain("Hi");
  });

  it("acknowledges detected agents when they have no sampled memory", async () => {
    const generateReport = vi.fn(async () => "should not be used");
    const write = vi.fn(async () => undefined);
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [])
      ],
      reportGenerator: { generateReport },
      memoryWriter: { write },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.status).toBe("ready");
    expect(report.reportMarkdown).toBe([
      "Memmy 已识别到这台设备上的 Codex，但首次轻量扫描暂时没有读到可用的对话历史。",
      "之后用 Memmy 处理真实任务时，它会记住有用的背景、决策和下一步，方便新对话或其他 Agent 继续。"
    ].join("\n\n"));
    expect(report.reportMarkdown).not.toContain("not enough recent user messages");
    expect(report.diagnostics).toMatchObject({
      discoveredAgentCount: 1,
      sampledQueryCount: 0,
      usedLlm: false
    });
    expect(generateReport).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("localizes the fixed empty-history report for English UI", async () => {
    const streamReport = vi.fn(async function* () {
      yield "should not be used";
    });
    const service = createOnboardingInsightService({
      samplers: [],
      reportGenerator: {
        async generateReport() {
          return "should not be used";
        },
        streamReport
      },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "en-US" });
    const events = await collectStreamEvents(service.streamReport({ locale: "en-US" }));

    expect(report.status).toBe("ready");
    expect(report.reportMarkdown).toBe([
      "There is no readable Agent history on this device yet, so there is nothing useful to pretend I already know.",
      "Tell Memmy about one real task. It will preserve the useful background, decisions, and next step so a new conversation—or another Agent such as Cursor or Codex—can continue without making you explain it again."
    ].join("\n\n"));
    expect(report.reportMarkdown).not.toContain("我没有在本机扫描到");
    expect(events).toEqual([
      {
        type: "sampled",
        diagnostics: {
          discoveredAgentCount: 0,
          sampledQueryCount: 0,
          usedLlm: false,
          elapsedMs: 0,
          reportLanguage: "en-US",
          latestWorkspacePath: null,
          agents: []
        }
      },
      {
        type: "done",
        response: expect.objectContaining({
          status: "ready",
          reportMarkdown: expect.stringContaining("There is no readable Agent history on this device yet"),
          diagnostics: expect.objectContaining({
            discoveredAgentCount: 0,
            sampledQueryCount: 0,
            usedLlm: false
          })
        })
      }
    ]);
    expect(streamReport).not.toHaveBeenCalled();
  });

  it("uses the configured LLM generator and strips action copy from the report body", async () => {
    const generateReport = vi.fn(async () => "我已经根据你的任务和偏好生成了首登报告。\n\n主按钮：好，帮我整合");
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "首次登录轻量扫描必须很快，先总结用户偏好，再整合任务")
        ])
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown).toBe("我已经根据你的任务和偏好生成了首登报告。");
    expect(report.diagnostics.usedLlm).toBe(true);
    expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({
      locale: "zh-CN",
      profile: expect.objectContaining({
        nameHints: expect.objectContaining({
          selfDeclaredNames: [],
          homePathName: expect.any(String)
        })
      }),
      sample: expect.objectContaining({
        sampledQueryCount: 1
      })
    }));
  });

  it("stores the model-summarized task trajectory instead of the raw conversation", async () => {
    const write = vi.fn(async () => undefined);
    const taskContext = {
      topic: "Memmy onboarding handoff",
      userGoal: "让新 Agent 准确接续最近任务。",
      latestRequest: "改用归纳后的任务轨迹作为接续上下文。",
      status: "active",
      currentState: "双区块输出方案已确定，等待实现验证。",
      agentActions: ["梳理了报告与任务上下文的边界。"],
      verifiedResults: [],
      unresolvedItems: ["尚未验证跨 Agent 召回。"],
      continuationPoint: "实现双区块解析并运行测试。",
      trajectorySummary: "用户先发现原始对话导致接续混乱，随后确定改为通用任务轨迹摘要；当前进入实现阶段。"
    };
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [query("codex", "1", "不要保存原始对话，改成任务轨迹摘要")])
      ],
      reportGenerator: {
        async generateReport() {
          return `<memmy_report>## 最近项目记忆\n已改用任务轨迹摘要。</memmy_report>\n<memmy_task_context>${JSON.stringify(taskContext)}</memmy_task_context>`;
        }
      },
      memoryWriter: { write },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown).toBe("## 最近项目记忆\n已改用任务轨迹摘要。");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      reportMarkdown: "## 最近项目记忆\n已改用任务轨迹摘要。",
      taskContext
    }));
  });

  it("returns only the model-generated report without action protocol fields", async () => {
    const generateReport = vi.fn(async (input) => {
      expect(input).not.toHaveProperty("primaryAction");
      expect(input).not.toHaveProperty("secondaryActions");
      return "Hi jiang，我已经把最近分散在不同 Agent 里的任务线索整理好了。";
    });
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [query("codex", "1", "跨 Agent 整合 Memory 项目中 dev-jiang 和 dev 的合并任务并继续修复首登按钮")]),
        sampler("cursor", "Cursor", [query("cursor", "1", "跨 Agent 的 Memory 首次登录报告按钮应该结合最近任务由模型生成")])
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown).toBe("Hi jiang，我已经把最近分散在不同 Agent 里的任务线索整理好了。");
    expect(report).not.toHaveProperty("primaryAction");
    expect(report).not.toHaveProperty("secondaryActions");
  });

  it("strips a legacy action payload from model output", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [query("codex", "1", "继续实现首次登录报告按钮")])
      ],
      reportGenerator: {
        async generateReport() {
          return "这是一段有效的模型报告。\n[MEMMY_ACTIONS_JSON]\n{invalid json";
        }
      },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown).toBe("这是一段有效的模型报告。");
    expect(report.diagnostics.usedLlm).toBe(true);
  });

  it("keeps task-continuation paragraphs while stripping standalone action labels", async () => {
    const generateReport = vi.fn(async () => [
      "你最近的主线是把首登扫描和初见报告继续这个任务打磨完整，这一段是正文，不应该被删。",
      "",
      "继续这个任务",
      "",
      "另一条线索是整理技术决策，让 Memmy 把跨 Agent 上下文合成可以执行的下一步，这也属于正文。"
    ].join("\n"));
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "继续这个任务，把跨 Agent 任务接续报告写完整")
        ])
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown).toContain("继续这个任务打磨完整");
    expect(report.reportMarkdown).toContain("整理技术决策，让 Memmy");
    expect(report.reportMarkdown).not.toContain("\n\n继续这个任务\n\n");
  });

  it("clips very long sampled user queries before sending them to the report model", async () => {
    const longQuery = `帮我根据这张图生成初见报告 ${"x".repeat(2_000)} image-tail-should-not-be-sent`;
    const generateReport = vi.fn(async () => "这是一段正常生成的初见报告。");
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", longQuery)
        ])
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    await service.generateReport({ locale: "zh-CN" });

    const generationInput = generateReport.mock.calls[0]?.[0];
    const payloadText = generationInput?.sample.queries[0]?.text ?? "";
    expect(payloadText.length).toBe(603);
    expect(payloadText.endsWith("...")).toBe(true);
    expect(payloadText).not.toContain("image-tail-should-not-be-sent");
  });

  it("uses compact first-login sampling limits before reading local agent data", async () => {
    const sampleRecentUserQueries = vi.fn(async () => ({
      sourceId: "codex",
      displayName: "Codex",
      recentSessionCount: 1,
      latestActivityAt: "2026-06-01T10:00:00.000Z",
      queries: [query("codex", "1", "首登报告只需要轻量采样最近用户 query")],
      errors: []
    }));
    const service = createOnboardingInsightService({
      samplers: [{
        sourceId: "codex",
        displayName: "Codex",
        async detect() {
          return true;
        },
        sampleRecentUserQueries
      }],
      reportGenerator: null,
      now: () => 100
    });

    await service.generateReport({ locale: "zh-CN" });

    expect(sampleRecentUserQueries).toHaveBeenCalledWith(expect.objectContaining({
      maxSessionFiles: 6,
      maxQueries: 12,
      maxQueryChars: 600,
      deadlineMs: 3_000
    }));
  });

  it("keeps the first-login model context compact even when sources contain many queries", async () => {
    const generateReport = vi.fn(async () => "这是一段正常生成的初见报告。");
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", manyQueries("codex", 80)),
        sampler("cursor", "Cursor", manyQueries("cursor", 80)),
        sampler("claude_code", "Claude Code", manyQueries("claude_code", 80))
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    await service.generateReport({ locale: "zh-CN" });

    const generationInput = generateReport.mock.calls[0]?.[0];
    expect(generationInput?.sample.sampledQueryCount).toBe(84);
    expect(generationInput?.sample.queries).toHaveLength(24);
    expect(new Set(generationInput?.sample.queries.map((item) => item.agentSource))).toEqual(new Set(["Codex", "Cursor", "Claude Code"]));
  });

  it("keeps the preference model context balanced across sources", async () => {
    const generateReport = vi.fn(async () => "这是一段正常生成的初见报告。");
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", timedQueries("codex", 20, "2026-06-03T10:00:00.000Z")),
        sampler("cursor", "Cursor", timedQueries("cursor", 80, "2026-06-01T10:00:00.000Z")),
        sampler("claude_code", "Claude Code", timedQueries("claude_code", 80, "2026-06-01T10:00:00.000Z"))
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    await service.generateReport({ locale: "zh-CN" });

    const queries = generateReport.mock.calls[0]?.[0].sample.queries ?? [];
    expect(queries).toHaveLength(24);
    expect(queries.slice(0, 3).map((item) => item.agentSource)).toEqual(["Codex", "Cursor", "Claude Code"]);
    expect(new Set(queries.map((item) => item.agentSource))).toEqual(new Set(["Codex", "Cursor", "Claude Code"]));
  });

  it("strips inline image base64 before sending sampled user queries to the report model", async () => {
    const imagePayload = `data:image/png;base64,iVBORw0KGgo${"A".repeat(2_000)}`;
    const generateReport = vi.fn(async () => "这是一段正常生成的初见报告。");
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", `请根据这张截图判断 ${imagePayload} 截图后面的文字要保留`)
        ])
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    await service.generateReport({ locale: "zh-CN" });

    const generationInput = generateReport.mock.calls[0]?.[0];
    const payloadText = generationInput?.sample.queries[0]?.text ?? "";
    expect(payloadText).toContain("[inline media omitted]");
    expect(payloadText).toContain("截图后面的文字要保留");
    expect(payloadText).not.toContain("data:image/png;base64");
    expect(payloadText).not.toContain("iVBORw0KGgo");
  });

  it("selects the globally latest visible conversation and sends assistant and compact tool context to the report model", async () => {
    const generateReport = vi.fn(async () => "这是一段正常生成的初见报告。");
    const readConversation = vi.fn(async (reference) => ({
      ...reference,
      messages: [
        { ...query("cursor", "latest-user", "修复最新构建错误"), role: "user" as const },
        { ...query("cursor", "latest-assistant", "Agent 表示已经完成修改"), role: "assistant" as const },
        { ...query("cursor", "latest-tool", "pnpm test: success"), role: "tool" as const }
      ]
    }));
    const service = createOnboardingInsightService({
      samplers: [
        samplerWithRecentMessages("codex", "Codex", "2026-06-01T10:00:00.000Z"),
        samplerWithRecentMessages("cursor", "Cursor", "2026-06-02T10:00:00.000Z")
      ],
      conversationWindowReader: { readConversation },
      reportGenerator: { generateReport },
      now: () => 100
    });

    await service.generateReport({ locale: "zh-CN" });

    expect(readConversation).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: "cursor",
      displayName: "Cursor",
      conversationId: "cursor-conversation"
    }), expect.objectContaining({ deadlineMs: 3_000 }));
    const sample = generateReport.mock.calls[0]?.[0].sample;
    expect(sample?.latestConversation).toMatchObject({
      agentSource: "Cursor",
      conversationId: "cursor-conversation"
    });
    expect(sample?.latestConversation?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(sample?.latestConversation?.messages[2]?.text).toBe("pnpm test: success");
  });

  it("streams only report text and persists the first-report memory before done", async () => {
    const write = vi.fn(async () => undefined);
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "首次登录报告需要收到首个 token 就开始输出")
        ])
      ],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<memmy_report>Hi，";
          yield "我已经开始读你的最近任务。\r\n";
          yield "## 接下来可以做\n1. 先验证记忆已完成摘要和索引。</memmy_report>";
        }
      },
      memoryWriter: { write },
      now: () => 100
    });

    const events = [];
    for await (const event of service.streamReport({ locale: "zh-CN" })) {
      events.push(event);
      if (event.type === "done") {
        expect(write).toHaveBeenCalledTimes(1);
      }
    }

    expect(events[0]).toMatchObject({
      type: "sampled",
      diagnostics: {
        discoveredAgentCount: 1,
        sampledQueryCount: 1,
        usedLlm: false
      }
    });
    expect(events
      .filter((event): event is { type: "chunk"; delta: string } => event.type === "chunk")
      .map((event) => event.delta)
      .join("")).toBe("Hi，我已经开始读你的最近任务。\r\n## 接下来可以做\n1. 先验证记忆已完成摘要和索引。");
    expect(events[4]).toMatchObject({
      type: "done",
      response: {
        status: "ready",
        reportMarkdown: "Hi，我已经开始读你的最近任务。\n## 接下来可以做\n1. 先验证记忆已完成摘要和索引。",
        diagnostics: expect.objectContaining({
          usedLlm: true
        })
      }
    });
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      reportMarkdown: expect.stringContaining("先验证记忆已完成摘要和索引"),
      latestConversation: expect.objectContaining({ agentSource: "Codex" })
    }));
  });

  it("drops model planning text before the report envelope from the stream and final report", async () => {
    const reportText = "Hi Jiang，\n\n## 你的偏好\n- 使用中文。";
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "生成初见报告")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "好的，我会严格按照你的要求，不暴露 homePathName。\n";
          yield `<memmy_report>${reportText}`;
          yield "</memmy_report>";
        }
      },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe(reportText);
    expect(visibleText).not.toContain("严格按照你的要求");
    expect(visibleText).not.toContain("homePathName");
    expect(done?.response.reportMarkdown).toBe(reportText);
  });

  it("removes raw HTML split across streamed report chunks while preserving its text", async () => {
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "生成初见报告")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<memmy_report>Hi Jiang，\n\n<span sty";
          yield "le=\"color:grey\"><span style=\"color:#888\">以上内容依据现有证据整理";
          yield "</";
          yield "span></span>\n\n## 接下来可以做\n暂时没有明确待办。</memmy_report>";
        }
      },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toContain("以上内容依据现有证据整理");
    expect(visibleText).not.toContain("<span");
    expect(done?.response.reportMarkdown).toBe(visibleText);
  });

  it("does not wait for the Memory service before completing the first-login report", async () => {
    let finishWrite = () => undefined;
    const write = vi.fn(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "直接读取最近任务并快速生成初见报告")
        ])
      ],
      reportGenerator: null,
      memoryWriter: { write },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.status).toBe("ready");
    expect(write).toHaveBeenCalledTimes(1);
    finishWrite();
  });

  it("keeps task context hidden even when the model omits the report closing tag", async () => {
    const write = vi.fn(async () => undefined);
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [query("codex", "1", "把最近任务归纳后用于跨 Agent 接续")])
      ],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<memmy_";
          yield "report>## 最近项目记忆\n";
          yield "任务轨迹已归纳。<memmy_task_";
          yield "context>{\"topic\":\"Memmy 初见报告\",\"userGoal\":\"跨 Agent 接续任务\",\"latestRequest\":\"保存归纳后的轨迹\",\"status\":\"active\",\"currentState\":\"等待验证\",\"agentActions\":[\"已完成摘要设计\"],\"verifiedResults\":[],\"unresolvedItems\":[\"召回尚未验证\"],\"continuationPoint\":\"运行接续测试\",\"trajectorySummary\":\"方案已经确定，当前等待验证。\"}</memmy_task_context>";
        }
      },
      memoryWriter: { write },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe("## 最近项目记忆\n任务轨迹已归纳。");
    expect(visibleText).not.toContain("memmy_task_context");
    expect(visibleText).not.toContain("trajectorySummary");
    expect(done?.response.reportMarkdown).toBe("## 最近项目记忆\n任务轨迹已归纳。");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      taskContext: expect.objectContaining({
        topic: "Memmy 初见报告",
        status: "active",
        continuationPoint: "运行接续测试"
      })
    }));
  });

  it("accepts simplified report tags without exposing markup or task context", async () => {
    const write = vi.fn(async () => undefined);
    const taskContext = {
      topic: "Memmy 初见报告",
      userGoal: "生成不含内部协议标签的初见报告。",
      latestRequest: "兼容模型输出的简化标签。",
      status: "completed",
      currentState: "报告正文已经生成。",
      agentActions: ["生成了初见报告。"],
      verifiedResults: ["报告正文可正常展示。"],
      unresolvedItems: [],
      continuationPoint: "",
      trajectorySummary: "模型使用了简化包装标签，报告正文仍应正常展示，内部任务上下文不得泄漏。"
    };
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "生成我的初见报告")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<rep";
          yield "ort>Hi jiacz，\n\n## 你的偏好\n偏好简洁、可执行的结论。";
          yield "</rep";
          yield "ort>\n<task";
          yield `Context>${JSON.stringify(taskContext)}</taskContext>`;
        }
      },
      memoryWriter: { write },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe("Hi jiacz，\n\n## 你的偏好\n偏好简洁、可执行的结论。");
    expect(visibleText).not.toContain("<report>");
    expect(visibleText).not.toContain("<taskContext>");
    expect(visibleText).not.toContain("trajectorySummary");
    expect(done?.response.reportMarkdown).toBe("Hi jiacz，\n\n## 你的偏好\n偏好简洁、可执行的结论。");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      reportMarkdown: "Hi jiacz，\n\n## 你的偏好\n偏好简洁、可执行的结论。",
      taskContext
    }));
  });

  it("keeps simplified task context hidden when the report closing tag is missing", async () => {
    const write = vi.fn(async () => undefined);
    const taskContext = {
      topic: "Memmy 初见报告",
      userGoal: "隐藏内部任务上下文。",
      latestRequest: "兼容缺失的简化报告闭合标签。",
      status: "active",
      currentState: "报告正文已经生成。",
      agentActions: ["生成了初见报告。"],
      verifiedResults: [],
      unresolvedItems: ["报告闭合标签缺失。"],
      continuationPoint: "继续修复解析器。",
      trajectorySummary: "简化报告标签未闭合，内部任务上下文仍不能显示给用户。"
    };
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "生成我的初见报告")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<report>Hi，报告正文。<task";
          yield `Context>${JSON.stringify(taskContext)}</taskContext>`;
        }
      },
      memoryWriter: { write },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe("Hi，报告正文。");
    expect(visibleText).not.toContain("taskContext");
    expect(visibleText).not.toContain("trajectorySummary");
    expect(done?.response.reportMarkdown).toBe("Hi，报告正文。");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      reportMarkdown: "Hi，报告正文。",
      taskContext
    }));
  });

  it.each(["</memmy_report>", "</report>"])(
    "removes an orphan report closing marker: %s",
    async (closingMarker) => {
      const reportText = "Hi，报告正文。";
      const rawOutput = `${reportText}${closingMarker}`;
      const service = createOnboardingInsightService({
        samplers: [sampler("codex", "Codex", [query("codex", "1", "生成我的初见报告")])],
        reportGenerator: {
          async generateReport() {
            return rawOutput;
          },
          async *streamReport() {
            yield reportText;
            yield closingMarker.slice(0, 5);
            yield closingMarker.slice(5);
          }
        },
        now: () => 100
      });

      const report = await service.generateReport({ locale: "zh-CN" });
      const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
      const visibleText = events
        .filter((event): event is { type: "chunk"; delta: string } =>
          Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
        .map((event) => event.delta)
        .join("");
      const done = events.find((event) =>
        event && typeof event === "object" && (event as { type?: unknown }).type === "done"
      ) as { response: { reportMarkdown: string } } | undefined;

      expect(report.reportMarkdown).toBe(reportText);
      expect(visibleText).toBe("");
      expect(done?.response.reportMarkdown).toBe(reportText);
    }
  );

  it("preserves simplified tag names when they are part of ordinary report text", async () => {
    const reportText = "Hi。最近修复了 `<report>` 与 `<taskContext>` 标签泄漏。";
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "总结标签清理任务")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "Hi。最近修复了 `<rep";
          yield "ort>` 与 `<task";
          yield "Context>` 标签泄漏。";
        }
      },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe("");
    expect(done?.response.reportMarkdown).toBe(reportText);
  });

  it("preserves simplified tag names inside a wrapped report body", async () => {
    const reportText = "Hi。正文会说明 `<taskContext>` 标签的兼容处理。";
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "总结标签兼容方案")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<report>Hi。正文会说明 `<task";
          yield "Context>` 标签的兼容处理。</rep";
          yield "ort>";
        }
      },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe(reportText);
    expect(done?.response.reportMarkdown).toBe(reportText);
  });

  it("keeps a naked task-context JSON out of the streamed and final report", async () => {
    const write = vi.fn(async () => undefined);
    const taskContext = {
      topic: "Memmy onboarding",
      userGoal: "缩短初见报告等待时间。",
      latestRequest: "不要把内部 JSON 显示给用户。",
      status: "active",
      currentState: "正文已经生成，等待记忆索引。",
      agentActions: ["已开始流式输出正文。"],
      verifiedResults: [],
      unresolvedItems: [],
      continuationPoint: "等待索引完成。",
      trajectorySummary: "报告正文已经可见，内部任务摘要继续在后台生成。"
    };
    const service = createOnboardingInsightService({
      samplers: [sampler("codex", "Codex", [query("codex", "1", "隐藏初见报告后的 JSON")])],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<memmy_report>## 最近项目记忆\n正文先展示。";
          yield "\n{";
          yield `${JSON.stringify(taskContext).slice(1)}`;
        }
      },
      memoryWriter: { write },
      now: () => 100
    });

    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    const visibleText = events
      .filter((event): event is { type: "chunk"; delta: string } =>
        Boolean(event && typeof event === "object" && (event as { type?: unknown }).type === "chunk"))
      .map((event) => event.delta)
      .join("");
    const done = events.find((event) =>
      event && typeof event === "object" && (event as { type?: unknown }).type === "done"
    ) as { response: { reportMarkdown: string } } | undefined;

    expect(visibleText).toBe("## 最近项目记忆\n正文先展示。");
    expect(visibleText).not.toContain("trajectorySummary");
    expect(done?.response.reportMarkdown).toBe("## 最近项目记忆\n正文先展示。");
    expect(write).toHaveBeenCalledWith(expect.objectContaining({ taskContext }));
  });

  it("releases a buffered opening bracket when it is ordinary report text", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "首次登录报告正文可能包含方括号")
        ])
      ],
      reportGenerator: {
        async generateReport() {
          throw new Error("generateReport not used");
        },
        async *streamReport() {
          yield "<memmy_report>报告包含[";
          yield "普通说明]，";
          yield "仍然应该正常显示。</memmy_report>";
        }
      },
      now: () => 100
    });

    const chunks: string[] = [];
    let finalReport = "";
    for await (const event of service.streamReport({ locale: "zh-CN" })) {
      if (event.type === "chunk") {
        chunks.push(event.delta);
      } else if (event.type === "done") {
        finalReport = event.response.reportMarkdown;
      }
    }

    expect(chunks.join("")).toBe("报告包含[普通说明]，仍然应该正常显示。");
    expect(finalReport).toBe("报告包含[普通说明]，仍然应该正常显示。");
  });

  it("continues first-login report generation when a sampler exceeds the scan deadline", async () => {
    vi.useFakeTimers();
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "首次登录扫描不能被慢 Agent 阻塞")
        ]),
        {
          sourceId: "slow_agent",
          displayName: "Slow Agent",
          async detect() {
            return true;
          },
          async sampleRecentUserQueries() {
            return new Promise<OnboardingSampleResult>(() => undefined);
          }
        }
      ],
      reportGenerator: null,
      now: () => Date.now()
    });

    const eventsPromise = collectStreamEvents(service.streamReport({
      locale: "zh-CN",
      detectedAgents: [{ sourceId: "slow_agent", displayName: "Slow Agent", recentSessionCount: 7 }]
    }));
    await vi.advanceTimersByTimeAsync(3_000);
    const events = await eventsPromise;

    expect(events[0]).toMatchObject({
      type: "sampled",
      diagnostics: {
        discoveredAgentCount: 2,
        sampledQueryCount: 1,
        agents: expect.arrayContaining([
          expect.objectContaining({ sourceId: "slow_agent", recentSessionCount: 7 })
        ])
      }
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: {
        status: "ready",
        diagnostics: {
          discoveredAgentCount: 2,
          sampledQueryCount: 1,
          agents: expect.arrayContaining([
            expect.objectContaining({ sourceId: "slow_agent", recentSessionCount: 7 })
          ])
        }
      }
    });
  });

  it("requests OpenAI-compatible report generation with stream enabled and parses deltas", async () => {
    const encoder = new TextEncoder();
    const fetchImpl = vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" there"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }),
      { status: 200 }
    ));
    const generator = createOpenAiCompatibleOnboardingInsightReportGenerator({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-test",
      model: "gpt-test",
      fetch: fetchImpl
    });

    const chunks = [];
    for await (const chunk of generator.streamReport!(generationInput())) {
      chunks.push(chunk);
    }

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.stream).toBe(true);
    expect(body.messages[0].content).toContain("最近项目记忆");
    expect(body.messages[0].content).toContain("接下来可以做");
    expect(body.messages[1].content).toContain('"role": "tool"');
    expect(body.messages[1].content).toContain("npm test: success");
    expect(chunks).toEqual(["Hi", " there"]);
  });

  it("uses the resolved agent task model for first-login report generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "这是来自 Agent 任务模型的报告。" } }]
    }), { status: 200 }));
    const generator = createAgentTaskModelOnboardingInsightReportGenerator({
      resolver: {
        getAgentTaskModel: () => ({
          providerName: "memmy_account",
          model: "agent_chat",
          apiBase: "https://cloud.example/api/agentExternal/v1",
          apiKey: "cloud-login-uuid"
        })
      },
      fetch: fetchImpl
    });

    const input = generationInput();
    input.locale = "zh-CN";
    input.profile.nameHints = {
      selfDeclaredNames: ["Grace"],
      homePathName: "jiang",
      computerUserName: "jiang",
      homeAndComputerMatch: true,
      genericAccountNames: ["admin", "administrator", "root", "ubuntu", "user", "test", "guest", "default", "runner", "ec2-user"]
    };
    const internalQuerySignal = {
      sourceId: "codex",
      conversationId: "internal-conversation-id",
      messageId: "internal-message-id",
      createdAt: "2026-06-01T10:00:00.000Z",
      text: "Continue the first report.",
      workspacePath: "/Users/test/Memmy"
    };
    input.profile.taskCandidates = [{
      title: "first report",
      summary: "Continue the first report.",
      project: "Memmy",
      relatedAgents: ["Codex"],
      latestQuery: internalQuerySignal,
      score: 10
    }];
    input.profile.highSignalQueries = [internalQuerySignal];
    input.profile.taskLikeQuery = internalQuerySignal;
    const report = await generator.generateReport(input);

    expect(report).toBe("这是来自 Agent 任务模型的报告。");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://cloud.example/api/agentExternal/v1/chat/completions");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer cloud-login-uuid"
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.model).toBe("agent_chat");
    expect(body.max_tokens).toBe(2000);
    expect(body.enable_thinking).toBe(false);
    expect(body).not.toHaveProperty("thinking_budget");
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.messages[0].content).not.toContain("保持 4-6 个短段落");
    expect(body.messages[0].content).toContain("latestConversation 是所有已扫描 Agent 中时间最新的一个会话");
    expect(body.messages[0].content).toContain("『你的偏好』");
    expect(body.messages[0].content).toContain("偏好结论的唯一原始证据是 preferenceEvidence 中由用户本人发送的消息");
    expect(body.messages[0].content).toContain("严禁使用 assistant、tool 或 latestConversation 推断偏好");
    expect(body.messages[0].content).not.toContain("我对你的工作偏好");
    expect(body.messages[0].content).toContain("根据 profile.nameHints 综合判断");
    expect(body.messages[0].content).toContain("默认优先使用 homePathName");
    expect(body.messages[0].content).toContain("admin、administrator、root、ubuntu");
    expect(body.messages[0].content).toContain("不得把名字替换成“这个线索”");
    expect(body.messages[0].content).toContain("有值时要自然说明用户最近更常用中文还是英文");
    expect(body.messages[0].content).toContain("不要生成按钮、行动卡片、CTA");
    expect(body.messages[0].content).toContain("不得包含任何原始 HTML 标签或样式");
    expect(body.messages[0].content).toContain("不要输出思考过程、执行计划、要求确认、Prompt 复述或起草说明");
    expect(body.messages[0].content).not.toContain("[MEMMY_ACTIONS_JSON]");
    const userPayload = JSON.parse(String(body.messages[1].content));
    expect(userPayload.reportGoal.primary).toBe("user_preferences_latest_project_memory_and_actionable_todos");
    expect(userPayload.reportGoal.lengthConstraint).toContain("300-500 Chinese characters");
    expect(userPayload.reportGoal.requiredSections).toContain("latest_project_memory");
    expect(userPayload.reportGoal.requiredSections).toContain("user_preferences");
    expect(userPayload.reportGoal.outputEnvelope.taskContextFields).toContain("trajectorySummary");
    expect(userPayload.profile.nameHints).toMatchObject({
      selfDeclaredNames: ["Grace"],
      homePathName: "jiang",
      computerUserName: "jiang",
      homeAndComputerMatch: true
    });
    expect(JSON.stringify(userPayload.profile)).not.toContain("conversationId");
    expect(JSON.stringify(userPayload.profile)).not.toContain("messageId");
    expect(JSON.stringify(userPayload.profile)).not.toContain("internal-conversation-id");
    expect(JSON.stringify(userPayload.profile)).not.toContain("internal-message-id");
    expect(userPayload.nameDecisionRequirement).toMatchObject({
      mustInferDisplayName: true,
      mustIncludeDisplayNameInFirstSentence: true,
      defaultPriority: "homePathName"
    });
    expect(userPayload.preferenceEvidence).toEqual([expect.objectContaining({
      agentSource: "Codex",
      text: "Continue the first report."
    })]);
    expect(userPayload.latestConversation.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", text: "The report prompt is updated." }),
      expect.objectContaining({ role: "tool", text: "npm test: success" })
    ]));
    expect(userPayload).not.toHaveProperty("actionCandidates");
    expect(userPayload).not.toHaveProperty("actions");
  });

  it("matches model-config test endpoint rules for OpenAI-compatible root base URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "root base url works" } }]
    }), { status: 200 }));
    const generator = createOpenAiCompatibleOnboardingInsightReportGenerator({
      baseUrl: "https://api.openai.example",
      apiKey: "sk-root",
      model: "gpt-4.1-mini",
      fetch: fetchImpl
    });

    await expect(generator.generateReport(generationInput())).resolves.toBe("root base url works");

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.openai.example/v1/chat/completions");
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("enable_thinking");
    expect(body).not.toHaveProperty("thinking_budget");
    expect(body).not.toHaveProperty("thinking");
  });

  it("turns off thinking for Qwen-compatible first-login report generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "qwen no thinking" } }]
    }), { status: 200 }));
    const generator = createOpenAiCompatibleOnboardingInsightReportGenerator({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "dashscope-key",
      model: "qwen3-plus",
      fetch: fetchImpl
    });

    await expect(generator.generateReport(generationInput())).resolves.toBe("qwen no thinking");

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.enable_thinking).toBe(false);
    expect(body).not.toHaveProperty("thinking_budget");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("turns off thinking for thinking-type compatible first-login report generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "deepseek no thinking" } }]
    }), { status: 200 }));
    const generator = createOpenAiCompatibleOnboardingInsightReportGenerator({
      baseUrl: "https://api.deepseek.example/v1",
      apiKey: "deepseek-key",
      model: "deepseek-v4-pro",
      fetch: fetchImpl
    });

    await expect(generator.generateReport(generationInput())).resolves.toBe("deepseek no thinking");

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("thinking_budget");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("omits immutable temperature for Moonshot Kimi K2 first-login report generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "kimi report" } }]
    }), { status: 200 }));
    const generator = createOpenAiCompatibleOnboardingInsightReportGenerator({
      providerName: "moonshot",
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "moonshot-key",
      model: "kimi-k2.5",
      fetch: fetchImpl
    });

    await expect(generator.generateReport(generationInput())).resolves.toBe("kimi report");

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).not.toHaveProperty("temperature");
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("uses Anthropic messages API when the resolved agent task model is Anthropic", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "这是 Claude 生成的报告。" }]
    }), { status: 200 }));
    const generator = createAgentTaskModelOnboardingInsightReportGenerator({
      resolver: {
        getAgentTaskModel: () => ({
          providerName: "anthropic",
          model: "claude-sonnet-4",
          apiBase: "https://api.anthropic.com",
          apiKey: "anthropic-key"
        })
      },
      fetch: fetchImpl
    });

    const report = await generator.generateReport(generationInput());

    expect(report).toBe("这是 Claude 生成的报告。");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://api.anthropic.com/v1/messages");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-api-key": "anthropic-key",
      "anthropic-version": "2023-06-01"
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "claude-sonnet-4",
      max_tokens: 2000
    });
  });

  it("uses Gemini generateContent API when the resolved agent task model is Gemini", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: "这是 Gemini 生成的报告。" }] } }]
    }), { status: 200 }));
    const generator = createAgentTaskModelOnboardingInsightReportGenerator({
      resolver: {
        getAgentTaskModel: () => ({
          providerName: "gemini",
          model: "gemini-2.5-pro",
          apiBase: "https://generativelanguage.googleapis.com/v1beta",
          apiKey: "gemini-key"
        })
      },
      fetch: fetchImpl
    });

    const report = await generator.generateReport(generationInput());

    expect(report).toBe("这是 Gemini 生成的报告。");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent");
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-goog-api-key": "gemini-key"
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.generationConfig.maxOutputTokens).toBe(2000);
    expect(body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 0
    });
  });

  it("localizes the report and includes the inferred response language preference", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "Please continue the mindock-agent onboarding report work and verify the React UI."),
          query("codex", "2", "Fix the first report actions so the buttons render separately from the markdown body."),
          query("codex", "3", "Keep the implementation lightweight and make sure the final prompt asks for English.")
        ]),
        sampler("cursor", "Cursor", [
          query("cursor", "1", "The onboarding scan needs a compact report card with scrollable content.")
        ])
      ],
      reportGenerator: null,
      now: () => 100
    });

    const report = await service.generateReport({ locale: "en-US" });

    expect(report.reportMarkdown).toContain("Hi");
    expect(report.reportMarkdown).toContain("Language preference: recent conversations lean English");
    expect(report.reportMarkdown).toContain("## Your preferences");
    expect(report).not.toHaveProperty("primaryAction");
    expect(report).not.toHaveProperty("secondaryActions");
  });

  it("infers Chinese response preference from Chinese-majority queries with English technical terms", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "first report 页面太宽了，需要给整个 GUI 两侧留一点距离"),
          query("codex", "2", "根据用户历史 query 总结用户偏好喜欢中文回答还是英文回答"),
          query("codex", "3", "跨 Agent 接入页面提示 codex Maximum call stack size exceeded，帮我检查")
        ])
      ],
      reportGenerator: null,
      now: () => 100
    });

    const report = await service.generateReport({ locale: "en-US" });

    expect(report.reportMarkdown).toContain("语言偏好：最近对话更常使用中文");
    expect(report.diagnostics).toMatchObject({
      reportLanguage: "zh-CN",
      latestWorkspacePath: "/Users/test/Memmy"
    });
  });

  it.each([
    {
      name: "uses Chinese at the twenty-percent boundary",
      appLocale: "en-US",
      expectedLocale: "zh-CN",
      texts: [
        "请帮我检查这个页面并修复报告显示问题",
        "Please verify the latest backend integration test results.",
        "Keep the implementation concise and avoid unnecessary fallback logic.",
        "Review the current pull request before merging the changes.",
        "Update the report output and confirm the final behavior."
      ]
    },
    {
      name: "uses English below the twenty-percent boundary",
      appLocale: "zh-CN",
      expectedLocale: "en-US",
      texts: [
        "请帮我检查这个页面并修复报告显示问题",
        "Please verify the latest backend integration test results.",
        "Keep the implementation concise and avoid unnecessary fallback logic.",
        "Review the current pull request before merging the changes.",
        "Update the report output and confirm the final behavior.",
        "Run the complete test suite and summarize every failure."
      ]
    }
  ] as const)("$name", async ({ appLocale, expectedLocale, texts }) => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", texts.map((text, index) => query("codex", String(index + 1), text)))
      ],
      reportGenerator: {
        async generateReport(input) {
          return input.locale;
        }
      },
      now: () => 100
    });

    const report = await service.generateReport({ locale: appLocale });

    expect(report.reportMarkdown).toBe(expectedLocale);
    expect(report.diagnostics.reportLanguage).toBe(expectedLocale);
  });

  it("uses the scanned response-language preference instead of the App locale for generation and storage", async () => {
    const generateReport = vi.fn(async (input: OnboardingInsightGenerationInput) => (
      input.locale === "en-US" ? "English preferred-language report." : "中文报告。"
    ));
    const write = vi.fn(async () => undefined);
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          query("codex", "1", "Please keep the report concise and continue the latest implementation task."),
          query("codex", "2", "Use English for the response and include concrete next steps."),
          query("codex", "3", "Verify the build before giving me the final answer.")
        ])
      ],
      reportGenerator: { generateReport },
      memoryWriter: { write },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });
    const events = await collectStreamEvents(service.streamReport({ locale: "zh-CN" }));

    expect(report.reportMarkdown).toBe("English preferred-language report.");
    expect(generateReport).toHaveBeenCalledWith(expect.objectContaining({ locale: "en-US" }));
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      locale: "en-US",
      latestConversation: expect.objectContaining({ workspacePath: "/Users/test/Memmy" })
    }));
    expect(report.diagnostics).toMatchObject({
      reportLanguage: "en-US",
      latestWorkspacePath: "/Users/test/Memmy"
    });
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "done",
        response: expect.objectContaining({
          reportMarkdown: "English preferred-language report.",
          diagnostics: expect.objectContaining({
            reportLanguage: "en-US",
            latestWorkspacePath: "/Users/test/Memmy"
          })
        })
      })
    ]));
  });

  it("uses only the globally latest conversation in the report", async () => {
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [
          {
            ...query("codex", "1", "push 到 dev-jiang 分支后从 dev 合并冲突，列出冲突点让用户选择。"),
            workspacePath: "/Users/test/jiang"
          }
        ]),
        sampler("cursor", "Cursor", [
          {
            ...query("cursor", "1", "继续整理当前任务上下文，给出下一步执行计划并验证。"),
            workspacePath: null
          }
        ])
      ],
      reportGenerator: null,
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.reportMarkdown).toContain("push 到 dev-jiang 分支");
    expect(report.reportMarkdown).not.toContain("继续整理当前任务上下文");
  });
});

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function sampler(sourceId: string, displayName: string, queries: OnboardingSampleResult["queries"]): OnboardingInsightSampler {
  return {
    sourceId,
    displayName,
    async detect() {
      return true;
    },
    async sampleRecentUserQueries() {
      return {
        sourceId,
        displayName,
        recentSessionCount: 1,
        latestActivityAt: queries[0]?.createdAt ?? null,
        queries,
        errors: []
      };
    }
  };
}

function samplerWithRecentMessages(sourceId: string, displayName: string, latestAt: string): OnboardingInsightSampler {
  const user = {
    ...query(sourceId, `${sourceId}-user`, `请继续 ${sourceId} 的最近任务`),
    createdAt: new Date(Date.parse(latestAt) - 1_000).toISOString()
  };
  return {
    sourceId,
    displayName,
    async detect() {
      return true;
    },
    async sampleRecentUserQueries() {
      return {
        sourceId,
        displayName,
        recentSessionCount: 1,
        latestActivityAt: latestAt,
        queries: [user],
        recentMessages: [
          { ...user, role: "user" as const },
          {
            ...user,
            messageId: `${sourceId}-assistant`,
            role: "assistant" as const,
            createdAt: latestAt,
            text: `${displayName} recent answer`
          }
        ],
        errors: []
      };
    }
  };
}

function query(sourceId: string, messageId: string, text: string): OnboardingSampleResult["queries"][number] {
  return {
    sourceId,
    conversationId: `${sourceId}-conversation`,
    messageId,
    createdAt: "2026-06-01T10:00:00.000Z",
    text,
    workspacePath: "/Users/test/Memmy"
  };
}

function manyQueries(sourceId: string, count: number): OnboardingSampleResult["queries"] {
  const baseTime = Date.parse("2026-06-01T10:00:00.000Z");
  return Array.from({ length: count }, (_, index) => ({
    ...query(sourceId, String(index + 1), `第 ${index + 1} 条最近任务线索，需要继续实现首登报告和跨 Agent 接续。`),
    createdAt: new Date(baseTime + index * 1000).toISOString()
  }));
}

function timedQueries(sourceId: string, count: number, baseIso: string): OnboardingSampleResult["queries"] {
  const baseTime = Date.parse(baseIso);
  return Array.from({ length: count }, (_, index) => ({
    ...query(sourceId, String(index + 1), `${sourceId} recent ${index + 1}`),
    createdAt: new Date(baseTime + index * 1000).toISOString()
  }));
}

function generationInput(): Parameters<ReturnType<typeof createOpenAiCompatibleOnboardingInsightReportGenerator>["generateReport"]>[0] {
  return {
    locale: "en-US",
    profile: {
      nameHints: {
        selfDeclaredNames: [],
        homePathName: "test",
        computerUserName: "test",
        homeAndComputerMatch: true,
        genericAccountNames: ["admin", "administrator", "root", "ubuntu", "user", "test", "guest", "default", "runner", "ec2-user"]
      },
      preferredResponseLanguage: "en-US",
      activeAgentNames: ["Codex"],
      topAgents: [{ sourceId: "codex", displayName: "Codex", queryCount: 1, latestActivityAt: "2026-06-01T10:00:00.000Z" }],
      topKeywords: ["Memory"],
      topProjects: ["Memmy"],
      userInsights: [],
      taskCandidates: [],
      highSignalQueries: [],
      taskLikeQuery: null
    },
    sample: {
      discoveredAgentCount: 1,
      sampledQueryCount: 1,
      activeAgents: [{ sourceId: "codex", displayName: "Codex", queryCount: 1, latestActivityAt: "2026-06-01T10:00:00.000Z" }],
      queries: [{
        agentSource: "Codex",
        createdAt: "2026-06-01T10:00:00.000Z",
        workspacePath: "/Users/test/Memmy",
        text: "Continue the first report."
      }],
      latestConversation: {
        agentSource: "Codex",
        conversationId: "codex-conversation",
        latestActivityAt: "2026-06-01T10:00:00.000Z",
        workspacePath: "/Users/test/Memmy",
        messages: [
          { role: "user", createdAt: "2026-06-01T10:00:00.000Z", text: "Continue the first report." },
          { role: "assistant", createdAt: "2026-06-01T10:00:01.000Z", text: "The report prompt is updated." },
          { role: "tool", createdAt: "2026-06-01T10:00:02.000Z", text: "npm test: success" }
        ]
      }
    }
  };
}
