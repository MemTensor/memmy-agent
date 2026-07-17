import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OnboardingInsightSampler,
  OnboardingSampleResult
} from "../../adapters/outbound/agent-source/insight-sampler-types.js";
import {
  createAgentTaskModelOnboardingInsightReportGenerator,
  createOnboardingInsightService,
  createOpenAiCompatibleOnboardingInsightReportGenerator
} from "../onboarding-insight-service.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("onboarding insight service", () => {
  it("generates a cross-agent report from recent user queries without writing memory", async () => {
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
    expect(report.primaryAction?.type).toBe("cross_agent_synthesis");
    expect(report.primaryAction?.relatedAgents).toEqual(expect.arrayContaining(["Cursor", "Claude Code"]));
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

    expect(report.reportMarkdown).not.toContain("Grace江");
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

    expect(report.reportMarkdown).not.toContain("部署在云服务器上使用的");
    expect(report.reportMarkdown).toContain("Hi");
  });

  it("returns a fixed Memmy introduction when agents have no sampled memory", async () => {
    const generateReport = vi.fn(async () => "should not be used");
    const service = createOnboardingInsightService({
      samplers: [
        sampler("codex", "Codex", [])
      ],
      reportGenerator: { generateReport },
      now: () => 100
    });

    const report = await service.generateReport({ locale: "zh-CN" });

    expect(report.status).toBe("ready");
    expect(report.reportMarkdown).toBe([
      "这台设备上还没有 Memmy 可以读取的记录，不过从现在开始，你和 Agent 对话中产生的经验、决策和上下文，Memmy 会帮你持续沉淀下来。下一次开新对话或者切换 Agent 时，Memmy 可以直接注入相关记忆，不用你每次重新解释背景。",
      "比如项目里的命名约定、你偏好的实现方式、某个问题踩过的坑、一次排查最终定位到的原因——这些在日常工作中反复出现却不该反复解释的东西，之后都会变成可复用的长期记忆。",
      "如果你在 Cursor、Codex 等不同 Agent 之间切换工作，Memmy 也能把分散的上下文串起来——迁移的不是聊天记录，而是可以继续执行的任务现场。从这次对话开始，Memmy 就正式上班了。"
    ].join("\n\n"));
    expect(report.reportMarkdown).not.toContain("not enough recent user messages");
    expect(report.primaryAction).toBeUndefined();
    expect(report.secondaryActions).toEqual([]);
    expect(report.diagnostics).toMatchObject({
      discoveredAgentCount: 1,
      sampledQueryCount: 0,
      usedLlm: false
    });
    expect(generateReport).not.toHaveBeenCalled();
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
      "There are no records on this device that Memmy can read yet. From now on, though, Memmy will keep capturing the experience, decisions, and context that emerge from your conversations with Agents. The next time you start a new conversation or switch Agents, Memmy can inject the relevant memories directly, so you do not have to explain the background all over again.",
      "That includes project naming conventions, your preferred implementation style, pitfalls you have already encountered, and the root cause uncovered by a debugging session—things that recur in daily work but should not need to be explained repeatedly. They will become reusable long-term memory.",
      "If you switch between Agents such as Cursor and Codex, Memmy can also connect the context scattered across them. What moves is not merely a chat log, but a working task state that can be continued. Starting with this conversation, Memmy is officially on the job."
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
          agents: []
        }
      },
      {
        type: "done",
        response: expect.objectContaining({
          status: "ready",
          reportMarkdown: expect.stringContaining("There are no records on this device that Memmy can read yet"),
          secondaryActions: [],
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

  it("uses model-generated copy for all three report actions", async () => {
    const generateReport = vi.fn(async (input) => {
      const candidates = [input.primaryAction, ...input.secondaryActions];
      return [
        "Hi jiang，我已经把最近分散在不同 Agent 里的任务线索整理好了。",
        "  [MEMMY_ACTIONS_JSON]   ",
        JSON.stringify({
          actions: candidates.map((action, index) => ({
            type: action.type,
            buttonLabel: ["整合合并任务", "继续修复按钮", "沉淀技术决策"][index],
            description: ["汇总分支合并背景并形成执行计划", "接着修复首登报告按钮生成链路", "记录模型生成与规则校验的取舍"][index],
            suggestedPrompt: [
              "请整合 Codex 和 Cursor 中关于 dev-jiang 合并 dev 的讨论，归纳已经确认的保留方案、尚未解决的冲突以及下一步验证和提交计划。",
              "请继续修复首次登录扫描报告的三个行动按钮，让按钮内容结合最近任务由模型生成，并检查点击后发送的请求是否具体、通顺且可以直接执行。",
              "请把首次登录报告按钮采用模型生成、规则限定类型和元数据、异常时回退模板的方案整理成技术决策记录，并列出验证标准。"
            ][index]
          }))
        })
      ].join("\n");
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
    expect(report.reportMarkdown).not.toContain("MEMMY_ACTIONS");
    expect([report.primaryAction, ...report.secondaryActions].map((action) => action?.buttonLabel)).toEqual([
      "整合合并任务",
      "继续修复按钮",
      "沉淀技术决策"
    ]);
    expect(report.primaryAction).toMatchObject({
      relatedAgents: expect.arrayContaining(["Codex", "Cursor"]),
      suggestedPrompt: expect.stringContaining("dev-jiang 合并 dev")
    });
  });

  it("falls back to rule-generated actions when model action JSON is invalid", async () => {
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
    expect(report.primaryAction?.buttonLabel).toBe("继续这个任务");
    expect(report.secondaryActions).toHaveLength(2);
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
      maxSessionFiles: 12,
      maxQueries: 24,
      maxQueryChars: 600,
      deadlineMs: 10_000
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
    expect(generationInput?.sample.sampledQueryCount).toBe(96);
    expect(generationInput?.sample.queries).toHaveLength(60);
    expect(new Set(generationInput?.sample.queries.map((item) => item.agentSource))).toEqual(new Set(["Codex", "Cursor", "Claude Code"]));
  });

  it("puts the newest ten queries first before filling the model context with balanced samples", async () => {
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
    expect(queries).toHaveLength(60);
    expect(queries.slice(0, 10).map((item) => `${item.agentSource}:${item.text}`)).toEqual(
      Array.from({ length: 10 }, (_, index) => `Codex:codex recent ${20 - index}`)
    );
    expect(new Set(queries.slice(10).map((item) => item.agentSource))).toEqual(new Set(["Codex", "Cursor", "Claude Code"]));
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

  it("streams generated first-report text while hiding and parsing final model actions", async () => {
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
        async *streamReport(input) {
          const candidates = [input.primaryAction, ...input.secondaryActions];
          yield "Hi，";
          yield "我已经开始读你的最近任务。\r\n";
          yield "[";
          yield "MEMMY_ACTIONS";
          yield "_JSON]   \r\n";
          yield JSON.stringify({
            actions: candidates.map((action, index) => ({
              type: action.type,
              buttonLabel: ["继续首登优化", "整理实现决策", "排查流式输出"][index],
              description: ["接着完成当前首登报告优化", "记录模型按钮生成方案", "验证内部数据不会显示在页面"][index],
              suggestedPrompt: [
                "请继续优化首次登录报告生成链路，重点确认报告正文和三个模型按钮可以在同一次请求中稳定返回。",
                "请整理首次登录按钮由模型生成、规则限制行动类型并在异常时回退的技术决策和验证标准。",
                "请排查首次登录报告的流式输出，验证内部 action 标记和 JSON 不会显示到页面，同时最终按钮内容能够正确解析。"
              ][index]
            }))
          });
        }
      },
      now: () => 100
    });

    const events = [];
    for await (const event of service.streamReport({ locale: "zh-CN" })) {
      events.push(event);
    }

    expect(events[0]).toMatchObject({
      type: "sampled",
      diagnostics: {
        discoveredAgentCount: 1,
        sampledQueryCount: 1,
        usedLlm: false
      }
    });
    expect(events[1]).toEqual({ type: "chunk", delta: "Hi，" });
    expect(events[2]).toEqual({ type: "chunk", delta: "我已经开始读你的最近任务。\r\n" });
    expect(events.filter((event) => event.type === "chunk").map((event) => event.delta).join(""))
      .not.toMatch(/MEMMY_ACTIONS_JSON|"actions"/);
    expect(events[3]).toMatchObject({
      type: "done",
      response: {
        status: "ready",
        reportMarkdown: "Hi，我已经开始读你的最近任务。",
        primaryAction: expect.objectContaining({
          buttonLabel: "继续首登优化",
          suggestedPrompt: expect.stringContaining("同一次请求")
        }),
        diagnostics: expect.objectContaining({
          usedLlm: true
        })
      }
    });
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
          yield "报告包含[";
          yield "普通说明]，";
          yield "仍然应该正常显示。";
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

    const eventsPromise = collectStreamEvents(service.streamReport({ locale: "zh-CN" }));
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await eventsPromise;

    expect(events[0]).toMatchObject({
      type: "sampled",
      diagnostics: {
        discoveredAgentCount: 1,
        sampledQueryCount: 1
      }
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      response: {
        status: "ready",
        diagnostics: {
          discoveredAgentCount: 1,
          sampledQueryCount: 1
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
    expect(body.messages[0].content).toContain("正文长度是硬约束");
    expect(body.messages[0].content).toContain("正文结构是硬约束");
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
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(500);
    expect(body).not.toHaveProperty("reasoning_effort");
    expect(body.messages[0].content).not.toContain("保持 4-6 个短段落");
    expect(body.messages[0].content).toContain("这份报告的第一目标是任务接续");
    expect(body.messages[0].content).toContain("根据 user.profile.nameHints 综合判断");
    expect(body.messages[0].content).toContain("默认优先使用 homePathName");
    expect(body.messages[0].content).toContain("admin、administrator、root、ubuntu");
    expect(body.messages[0].content).toContain("不得把名字替换成“这个线索”");
    expect(body.messages[0].content).toContain("用户偏好/习惯段必须明确写出用户更习惯用中文还是英文交流");
    expect(body.messages[0].content).toContain("[MEMMY_ACTIONS_JSON]");
    expect(body.messages[0].content).toContain("不能只写“继续当前任务”");
    const userPayload = JSON.parse(String(body.messages[1].content));
    expect(userPayload.reportGoal.primary).toBe("task_continuation");
    expect(userPayload.reportGoal.mustNotBeShort).toBe(true);
    expect(userPayload.reportGoal.lengthConstraint).toContain("5-7 natural paragraphs");
    expect(userPayload.reportGoal.requiredParagraphPlan).toContain("best_tasks_to_continue_in_memmy_agent");
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
    expect(userPayload.recentTaskSignals).toEqual([expect.objectContaining({
      agentSource: "Codex",
      text: "Continue the first report."
    })]);
    expect(userPayload.actionCandidates).toHaveLength(3);
    expect(userPayload.actionCandidates[0]).toMatchObject({
      priority: "primary",
      type: "continue_task",
      objective: expect.stringContaining("选择最具体")
    });
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

  it("localizes first-report actions and carries inferred response language preference in context only", async () => {
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
    expect(report.primaryAction?.buttonLabel).toBe("Alright, pull it together");
    expect(report.primaryAction?.description).toContain("Codex");
    expect(report.primaryAction?.contextSummary).toContain("Language preference: recent conversations lean English");
    expect(report.primaryAction?.suggestedPrompt).not.toContain("Response language preference");
    expect(report.primaryAction?.suggestedPrompt).toContain("Projects:");
    expect(report.primaryAction?.suggestedPrompt).not.toContain("项目：");
    expect(report.secondaryActions.map((action) => action.buttonLabel)).toEqual([
      "Continue this task",
      "Summarize the decisions"
    ]);
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

    expect(report.primaryAction?.contextSummary).toContain("Language preference: recent conversations lean Chinese");
    expect(report.primaryAction?.suggestedPrompt).not.toContain("Response language preference");
  });

  it("uses concrete query snippets instead of generic Chinese task titles in action prompts", async () => {
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

    expect(report.primaryAction?.suggestedPrompt).toContain("最近任务：");
    expect(report.primaryAction?.suggestedPrompt).toContain("push 到 dev-jiang 分支");
    expect(report.primaryAction?.suggestedPrompt).toContain("继续整理当前任务上下文");
    expect(report.primaryAction?.suggestedPrompt).not.toContain("jiang 的当前任务");
    expect(report.primaryAction?.suggestedPrompt).not.toContain("最近的连续任务");
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
      taskLikeQuery: null,
      actionType: "continue_task"
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
      }]
    },
    primaryAction: {
      type: "continue_task",
      buttonLabel: "Continue",
      description: "Continue",
      contextSummary: "Current task",
      relatedAgents: ["Codex"],
      topicKeywords: ["Memory"],
      suggestedPrompt: "Continue"
    },
    secondaryActions: [
      {
        type: "decision_doc",
        buttonLabel: "Decide",
        description: "Decide",
        contextSummary: "Current task",
        relatedAgents: ["Codex"],
        topicKeywords: ["Memory"],
        suggestedPrompt: "Decide"
      },
      {
        type: "problem_diagnosis",
        buttonLabel: "Debug",
        description: "Debug",
        contextSummary: "Current task",
        relatedAgents: ["Codex"],
        topicKeywords: ["Memory"],
        suggestedPrompt: "Debug"
      }
    ]
  };
}
