import { describe, expect, it } from "vitest";
import type { MemoryRow } from "../../src/types.js";
import type { LlmClient } from "../../src/model/types.js";
import { attachMemoryVectors } from "../../src/storage/memory-vector-state.js";
import {
  buildPolicyDraft,
  buildPluginRetrievalQuery,
  buildSkillDraft,
  buildWorldModelDraft,
  classifyFeedbackText,
  classifyIntent,
  classifyIntentWithLlm,
  classifyTurnFeedback,
  classifyTurnRelation,
  classifyTurnRelationWithLlm,
  combineRewardAxes,
  captureTurnSteps,
  backpropagateTraces,
  detectDominantLanguage,
  extractToolNamesFromTraces,
  extractRetrievalTags,
  focusResearchRetrievalQuery,
  isRepositoryRepairPrompt,
  l2CandidateIdFor,
  l2CandidateSignatureHash,
  languageSteeringLine,
  packL2InductionTraces,
  renderRepositoryRepairProtocol,
  retrievePluginMemories,
  retrievalLayersForMode,
  retrievalLayersForProfile,
  signatureFromTraceParts,
  traceMetaFromMemory,
  type PolicyMemoryMeta,
  type TraceMemoryMeta,
  shapeWorldModelConfidence,
  skillEtaAfterRewardDrift,
  skillEtaAfterTrial,
  skillStatusAfterRewardDrift,
  skillStatusAfterTrial,
  priorityFor,
  verifySkillDraft
} from "../../src/algorithm/plugin-algorithms.js";

describe("plugin algorithm parity helpers", () => {
  it("uses first-stage vector scores without recalculating query similarity", () => {
    const memory = traceMemory(
      "trace-seeded-score",
      "episode-seeded-score",
      "unrelated stored text",
      0.5,
      [0, 1]
    );
    const result = retrievePluginMemories({
      query: "no keyword overlap",
      queryVector: [1, 0],
      memories: [memory],
      layers: ["L1"],
      limit: 1,
      channelScoresByMemory: new Map([
        [memory.id, { vec_summary: 0.91 }]
      ]),
      config: {
        minTraceSim: 0.2,
        tagFilter: "off"
      }
    });

    expect(result.hits[0]).toMatchObject({ id: memory.id });
    expect(retrievePluginMemories({
      query: "no keyword overlap",
      queryVector: [1, 0],
      memories: [memory],
      layers: ["L1"],
      limit: 1,
      config: { minTraceSim: 0.2, tagFilter: "off" }
    }).hits).toEqual([]);
  });

  it("uses first-stage text channel scores without rescoring loaded candidates", () => {
    const memory = traceMemory(
      "trace-seeded-fts",
      "episode-seeded-fts",
      "stored content with no matching terms",
      0.5,
      [0, 1]
    );
    const result = retrievePluginMemories({
      query: "completely different query",
      memories: [memory],
      layers: ["L1"],
      limit: 1,
      channelScoresByMemory: new Map([
        [memory.id, { fts: 0.75 }]
      ]),
      config: { tagFilter: "off" }
    });

    expect(result.hits[0]).toMatchObject({ id: memory.id });
  });

  it("generates L2 candidate pool ids with the plugin DJB2 signature hash", () => {
    expect(l2CandidateSignatureHash("docker|pip|pip.install|_")).toBe("45lfrb");
    expect(l2CandidateIdFor("docker|pip|pip.install|_", "tr:abc!*")).toBe("cand_45lfrb_trabc");
    expect(l2CandidateIdFor("docker|pip|pip.install|_", "tr_abc")).toBe(
      l2CandidateIdFor("docker|pip|pip.install|_", "tr_abc")
    );
  });

  it("builds plugin-style retrieval queries for all service entry points", () => {
    const turnStart = buildPluginRetrievalQuery({
      reason: "turn_start",
      userText: "Fix this docker compose file",
      contextHints: { cwd: "/tmp/x", role: "planner" }
    });
    expect(turnStart.text).toContain("Fix this docker compose file");
    expect(turnStart.text).toContain("cwd: /tmp/x");
    expect(turnStart.tags).toContain("docker");

    const toolDriven = buildPluginRetrievalQuery({
      reason: "tool_driven",
      tool: "memmy_memory_search",
      args: { userText: "past docker bugs", layers: ["L1"] }
    });
    expect(toolDriven.text).toContain("past docker bugs");
    expect(toolDriven.text).toContain('"layers":["L1"]');
    expect(toolDriven.text).not.toContain("tool:memmy_memory_search");

    expect(buildPluginRetrievalQuery({
      reason: "skill_invoke",
      skillId: "skill_123",
      query: "run pytest on api module"
    }).text.startsWith("skill:skill_123")).toBe(true);

    expect(buildPluginRetrievalQuery({
      reason: "sub_agent",
      profile: "coder",
      mission: "refactor SQL queries and add typescript types"
    }).tags).toEqual(expect.arrayContaining(["sql", "typescript"]));

    const repair = buildPluginRetrievalQuery({
      reason: "decision_repair",
      failingTool: "pip.install",
      failureCount: 3,
      lastErrorCode: "NETWORK_REFUSED"
    });
    expect(repair.text).toContain("failing_tool:pip.install");
    expect(repair.text).toContain("failures:3");
    expect(repair.text).toContain("error:NETWORK_REFUSED");
    expect(repair.tags).toEqual(expect.arrayContaining(["network", "pip"]));
  });

  it("normalizes repository repair prompts before retrieval embedding", () => {
    const prompt = [
      "COMMAND_WRAPPER run \"cd /tmp/repo && ...\"",
      "You need to fix a bug in the example repository.",
      "",
      "## Issue Description",
      "Public route prefix returns /current instead of /expected for RedirectBuilder.",
      "",
      "## Hints",
      "Look at RedirectBuilder.applyPrefix and patch the source.",
      "",
      "STRICT RULES:",
      "Do not finish until git diff is non-empty."
    ].join("\n");

    const compiled = buildPluginRetrievalQuery({
      reason: "turn_start",
      userText: prompt
    });

    expect(isRepositoryRepairPrompt(prompt)).toBe(true);
    expect(compiled.text).toContain("repository repair source fix");
    expect(compiled.text).toContain("Public route prefix");
    expect(compiled.text).toContain("hints: Look at RedirectBuilder.applyPrefix");
    expect(compiled.text).not.toContain("COMMAND_WRAPPER");
    expect(compiled.text).not.toContain("STRICT RULES");

    const protocol = renderRepositoryRepairProtocol(prompt);
    expect(protocol).toContain("Patch-readiness gate");
    expect(protocol).toContain("behavior-changing source");
    expect(protocol).toContain("zero tests found");
    expect(protocol).toContain("`FAIL`, `ERROR`, `AssertionError`");
    expect(protocol).toContain("Visible issue context");
    expect(protocol).toContain("RedirectBuilder");
    expect(protocol).toContain("Generic repair heuristics");
  });

  it("renders specialized repository repair heuristics before broad categories", () => {
    const prompt = [
      "COMMAND_WRAPPER run \"cd /tmp/repo && ...\"",
      "You need to fix a bug in the example repository.",
      "",
      "## Issue Description",
      "SQLite PRAGMA introspection fails for a table named select because the reserved keyword identifier is not quoted.",
      "A relationship lookup subquery also returns too many columns because annotations leak into the select list projection.",
      "",
      "## Hints",
      "Inspect backend metadata SQL and related lookup filter subquery projection."
    ].join("\n");

    const protocol = renderRepositoryRepairProtocol(prompt);

    expect(protocol).toContain("backend identifier quoting boundary");
    expect(protocol).toContain("single-column subquery projection");
    expect(protocol).toContain("route every identifier through the repository's existing quote/escape helper");
    expect(protocol).toContain("the final nested query should select only the target column");
  });

  it("focuses markdown question sections only in explicit research domain", () => {
    const prompt = [
      "You are a careful research assistant.",
      "",
      "## Question",
      "Which architect designed the library opened in 1907?",
      "",
      "## Instructions",
      "Search broadly and cite evidence."
    ].join("\n");

    expect(focusResearchRetrievalQuery(prompt).text).toContain("careful research assistant");
    expect(focusResearchRetrievalQuery(prompt, "research")).toEqual({
      text: "Which architect designed the library opened in 1907?",
      method: "question_section"
    });

    const compiled = buildPluginRetrievalQuery({
      reason: "turn_start",
      userText: prompt,
      domain: "research"
    });
    expect(compiled.text).toBe("Which architect designed the library opened in 1907?");
    expect(compiled.text).not.toContain("Search broadly");
  });

  it("applies explicit research injection profiles to retrieval layers", () => {
    const base = retrievalLayersForMode("turn_start");
    expect(retrievalLayersForProfile(base, { domain: "", readOnlyInjectionProfile: "skill" })).toEqual(base);
    expect(retrievalLayersForProfile(base, { domain: "research", readOnlyInjectionProfile: "experience" })).toEqual(["L2"]);
    expect(retrievalLayersForProfile(base, { domain: "research", readOnlyInjectionProfile: "skill" })).toEqual(["Skill"]);
    expect(retrievalLayersForProfile(base, { domain: "research", readOnlyInjectionProfile: "skill_experience" })).toEqual(["Skill", "L2"]);

    const toolDriven = retrievalLayersForMode("tool_driven");
    expect(toolDriven).not.toContain("Skill");
    expect(retrievalLayersForProfile(toolDriven, { domain: "research", readOnlyInjectionProfile: "skill" })).toEqual(["Skill"]);
  });

  it("extracts retrieval tags before plugin query truncation", () => {
    const query = `${"x".repeat(800)} docker ${"x".repeat(800)}`;
    const compiled = buildPluginRetrievalQuery({ reason: "skill_invoke", query });
    expect(compiled.truncated).toBe(true);
    expect(compiled.text).toContain("[truncated]");
    expect(compiled.text).not.toContain("docker");
    expect(compiled.tags).toContain("docker");
    expect(extractRetrievalTags("Docker container DOCKER")).toEqual(["docker"]);
  });

  it("classifies plugin-style turn intents and retrieval tier plans", async () => {
    expect(classifyIntent("谢谢")).toMatchObject({
      kind: "chitchat",
      retrieval: { tier1: false, tier2: false, tier3: false }
    });
    expect(classifyIntent("/memos status")).toMatchObject({
      kind: "meta",
      retrieval: { tier1: false, tier2: false, tier3: false }
    });
    expect(classifyIntent("你还记得我们之前讨论过 sqlite migration 吗")).toMatchObject({
      kind: "memory_probe",
      retrieval: { tier1: true, tier2: true, tier3: false }
    });

    const calls: string[] = [];
    const llmDecision = await classifyIntentWithLlm("Could be a task or a past-context question", {
      llm: intentLlm(calls)
    });
    expect(calls).toEqual(["session.intent.classify.v1"]);
    expect(llmDecision).toMatchObject({
      kind: "memory_probe",
      retrieval: { tier1: true, tier2: true, tier3: false }
    });
  });

  it("falls back to weak intent heuristics when the plugin-style LLM classifier is malformed", async () => {
    const calls: string[] = [];
    const decision = await classifyIntentWithLlm("please help me refactor this config", {
      llm: intentLlm(calls, {
        kind: "not_a_real_label",
        confidence: 1,
        reason: "bad label"
      })
    });

    expect(calls).toEqual(["session.intent.classify.v1"]);
    expect(decision.kind).toBe("task");
    expect(decision.signals).toContain("task.imperative_verb");
    expect(decision.signals).toContain("llm_skipped");
  });

  it("classifies feedback text with the plugin classifier rules", () => {
    expect(classifyFeedbackText("")).toMatchObject({
      shape: "unknown",
      confidence: 0
    });
    for (const raw of ["Great, that works!", "Perfect", "Thanks", "yes", "好的", "完美"]) {
      expect(classifyFeedbackText(raw).shape).toBe("positive");
    }
    for (const raw of ["No, that's wrong", "Don't do that", "stop that", "nope", "不对", "别这样"]) {
      expect(classifyFeedbackText(raw).shape).toBe("negative");
    }

    expect(classifyFeedbackText("Use uv instead of pip")).toMatchObject({
      shape: "preference",
      prefer: "uv",
      avoid: "pip"
    });
    expect(classifyFeedbackText("prefer yarn over npm")).toMatchObject({
      shape: "preference",
      prefer: "yarn",
      avoid: "npm"
    });
    expect(classifyFeedbackText("用 poetry 代替 pip")).toMatchObject({
      shape: "preference",
      prefer: "poetry",
      avoid: "pip"
    });
    const softPreference = classifyFeedbackText("i prefer bare metal");
    expect(softPreference.shape).toBe("preference");
    expect(softPreference.prefer).toBeUndefined();
    expect(classifyFeedbackText("next time use apt-get")).toMatchObject({
      shape: "preference",
      prefer: expect.stringContaining("apt-get")
    });

    for (const raw of ["Run the tests now", "Install pandas", "then delete the file"]) {
      expect(classifyFeedbackText(raw).shape).toBe("instruction");
    }
    const neutral = classifyFeedbackText("the weather is warm today");
    expect(neutral.shape).toBe("unknown");
    expect(neutral.confidence).toBeLessThan(0.5);
    expect(classifyFeedbackText("  Use uv instead of pip.  ").text).toBe("Use uv instead of pip.");

    expect(classifyFeedbackText("it should be 42, not 41")).toMatchObject({
      shape: "correction",
      correction: expect.stringContaining("42")
    });
    expect(classifyFeedbackText("应该是 utf-8 编码")).toMatchObject({
      shape: "correction",
      correction: expect.stringContaining("utf-8")
    });
    expect(classifyFeedbackText("不是 Python3.9,是 3.11")).toMatchObject({
      shape: "correction",
      correction: expect.stringContaining("3.11")
    });
    for (const raw of ["not quite", "close but", "almost"]) {
      expect(classifyFeedbackText(raw).shape).toBe("correction");
    }

    expect(classifyFeedbackText("also log every request")).toMatchObject({
      shape: "constraint",
      constraint: expect.stringContaining("log every request")
    });
    expect(classifyFeedbackText("make sure to handle null inputs")).toMatchObject({
      shape: "constraint",
      constraint: expect.stringContaining("handle null inputs")
    });
    expect(classifyFeedbackText("it must keep backwards compatibility")).toMatchObject({
      shape: "constraint",
      constraint: expect.stringContaining("keep backwards compatibility")
    });
    expect(classifyFeedbackText("还要加一个超时参数")).toMatchObject({
      shape: "constraint",
      constraint: expect.stringContaining("超时")
    });

    for (const raw of [
      "what do you mean by that?",
      "why did you import this package",
      "I don't understand",
      "???",
      "什么意思?",
      "没看懂"
    ]) {
      expect(classifyFeedbackText(raw).shape).toBe("confusion");
    }
    expect(classifyFeedbackText("use yarn instead of npm")).toMatchObject({
      shape: "preference",
      prefer: "yarn"
    });
  });

  it("classifies implicit turn feedback with the plugin rule fast path", () => {
    expect(classifyTurnFeedback({
      userText: "应该用递归实现，这样性能不好",
      agentText: "Use a loop to traverse the tree."
    })).toMatchObject({
      isFeedback: true,
      polarity: "negative",
      magnitude: 0.6,
      confidence: 0.65,
      method: "rule"
    });
    expect(classifyTurnFeedback({
      userText: "Perfect, that fixed it",
      agentText: "The retry now uses exponential backoff."
    })).toMatchObject({
      isFeedback: true,
      polarity: "positive",
      magnitude: 0.8,
      confidence: 0.85,
      method: "rule"
    });
    expect(classifyTurnFeedback({
      userText: "Can you also show the logs?",
      agentText: "The service is running."
    })).toMatchObject({
      isFeedback: false,
      polarity: "neutral"
    });
  });

  it("reads L1 trace text from camelCase metadata without tag leakage in snippets", () => {
    const memory = traceMemory(
      "trace-fruit",
      "episode-fruit",
      "我喜欢吃什么水果",
      0.8,
      [1, 0]
    );
    memory.tags = ["trace", "turn", "memmy"];
    const trace = memory.properties.internal_info.trace as Record<string, unknown>;
    trace.userText = "我喜欢吃什么水果";
    trace.agentText = "你喜欢吃的水果是草莓";

    const meta = traceMetaFromMemory(memory);
    expect(meta).toMatchObject({
      userText: "我喜欢吃什么水果",
      agentText: "你喜欢吃的水果是草莓"
    });

    const result = retrievePluginMemories({
      query: "我喜欢吃什么水果",
      queryVector: [1, 0],
      memories: [memory],
      layers: ["L1"],
      limit: 1,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits[0]?.snippet).toContain("你喜欢吃的水果是草莓");
    expect(result.hits[0]?.snippet).not.toContain("trace turn memmy");
  });

  it("recalls food preferences when Chinese fallback query uses 爱吃 instead of 喜欢吃", () => {
    const pork = traceMemory(
      "trace-red-braised-pork",
      "episode-red-braised-pork",
      "我喜欢吃红烧肉",
      0.5,
      [1, 0]
    );
    const swim = traceMemory(
      "trace-swim",
      "episode-swim",
      "喜欢游泳 有没有什么固定习惯",
      0.5,
      [0, 1]
    );
    const seat = traceMemory(
      "trace-seat",
      "episode-seat",
      "我讨厌坐靠窗位置 有什么具体场景",
      0.5,
      [0, 1]
    );

    const fallbackResult = retrievePluginMemories({
      query: "我爱吃什么",
      queryVector: [],
      memories: [swim, seat, pork],
      layers: ["L1"],
      limit: 3,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });
    const extractedResult = retrievePluginMemories({
      query: "我爱吃什么",
      queryExtract: {
        queryVecText: "我爱吃什么",
        keywords: ["我爱吃什么"]
      },
      queryVector: [],
      memories: [swim, seat, pork],
      layers: ["L1"],
      limit: 3,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(fallbackResult.hits.map((hit) => hit.id)).toContain("trace-red-braised-pork");
    expect(fallbackResult.hits[0]?.id).toBe("trace-red-braised-pork");
    expect(extractedResult.hits.map((hit) => hit.id)).toContain("trace-red-braised-pork");
    expect(extractedResult.hits[0]?.id).toBe("trace-red-braised-pork");
  });

  it("keeps keyword L1 hits when auto tags narrow only vector trace recall", () => {
    const taggedVector = traceMemory(
      "trace-tagged-vector",
      "episode-tagged-vector",
      "python vector workflow",
      0.8,
      [1, 0]
    );
    taggedVector.tags = ["python"];
    const keywordOnly = traceMemory(
      "trace-keyword-untagged",
      "episode-keyword-untagged",
      "specialterm exact remembered fact",
      0.8,
      [0, 1]
    );
    keywordOnly.tags = ["ruby"];

    const result = retrievePluginMemories({
      query: "python specialterm",
      queryExtract: {
        queryVecText: "python",
        keywords: ["specialterm"]
      },
      queryVector: [1, 0],
      memories: [taggedVector, keywordOnly],
      layers: ["L1"],
      limit: 5,
      mode: "search",
      config: {
        tagFilter: "auto",
        mmrLambda: 1
      },
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(expect.arrayContaining([
      "trace-tagged-vector",
      "trace-keyword-untagged"
    ]));
  });

  it("relaxes auto L1 vector tag filters when no tagged vector trace matches", () => {
    const vectorOnly = traceMemory(
      "trace-vector-untagged",
      "episode-vector-untagged",
      "general vector-only memory",
      0.8,
      [1, 0]
    );
    vectorOnly.tags = ["ruby"];

    const auto = retrievePluginMemories({
      query: "python",
      queryVector: [1, 0],
      memories: [vectorOnly],
      layers: ["L1"],
      limit: 5,
      mode: "search",
      config: { tagFilter: "auto" },
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });
    const strict = retrievePluginMemories({
      query: "python",
      queryVector: [1, 0],
      memories: [vectorOnly],
      layers: ["L1"],
      limit: 5,
      mode: "search",
      config: { tagFilter: "on" },
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(auto.hits.map((hit) => hit.id)).toContain("trace-vector-untagged");
    expect(strict.hits.map((hit) => hit.id)).not.toContain("trace-vector-untagged");
  });

  it("omits internal reflection labels from episode rollups while keeping real reflections", () => {
    const related = traceMemory(
      "trace-related-label",
      "episode-reflection-format",
      "sqlite migration path was fixed",
      0.8,
      [1, 0]
    );
    const realReflection = traceMemory(
      "trace-real-reflection",
      "episode-reflection-format",
      "rerun the migration test after fixing the path",
      0.7,
      [0.95, 0.05]
    );
    (related.properties.internal_info.trace as Record<string, unknown>).reflection = "RELATED";
    (realReflection.properties.internal_info.trace as Record<string, unknown>).reflection =
      "Prefer rerunning the focused migration test after changing the sqlite path.";

    const result = retrievePluginMemories({
      query: "sqlite migration test path",
      queryVector: [1, 0],
      memories: [related, realReflection],
      layers: ["L1"],
      limit: 5,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z"),
      config: { mmrLambda: 1 }
    });

    const episode = result.hits.find((hit) => hit.source === "episode");
    expect(episode?.snippet).not.toContain("reflection: RELATED");
    expect(episode?.snippet).toContain("reflection: Prefer rerunning the focused migration test");
  });

  it("classifies plugin-style turn relations for revision, follow-up, and new task boundaries", () => {
    expect(classifyTurnRelation({
      prevUserText: "Configure nginx TLS",
      prevAssistantText: "Use port 80 and reload nginx after editing the server block.",
      newUserText: "wrong, use port 443 instead"
    })).toMatchObject({
      relation: "revision",
      confidence: 0.85
    });
    expect(classifyTurnRelation({
      prevUserText: "Configure nginx TLS",
      prevAssistantText: "Use port 443 and verify with curl.",
      newUserText: "那证书自动续期呢"
    })).toMatchObject({
      relation: "follow_up",
      confidence: 0.85
    });
    expect(classifyTurnRelation({
      prevUserText: "Configure nginx TLS",
      prevAssistantText: "Use port 443 and verify with curl.",
      newUserText: "new task: summarize the Q4 hiring plan"
    })).toMatchObject({
      relation: "new_task",
      confidence: 0.85
    });
  });

  it("does not split an episode on a weak domain-tag mismatch alone", () => {
    const decision = classifyTurnRelation({
      prevUserText: "修复 TypeScript hook 的 turn lifecycle",
      prevAssistantText: "已经定位到 start 和 complete 没有绑定同一轮。",
      newUserText: "修改起来麻烦吗？",
      prevTags: ["typescript", "hook"]
    });

    expect(decision).toMatchObject({
      relation: "follow_up",
      confidence: 0.55
    });
    expect(decision.signals).toEqual(expect.arrayContaining([
      "r7_domain_shift",
      "weak_new_task_fallback"
    ]));
  });

  it("uses plugin-style LLM arbitration for weak turn relation splits", async () => {
    const calls: string[] = [];
    const decision = await classifyTurnRelationWithLlm({
      prevUserText: "Configure nginx TLS for the service",
      prevAssistantText: "Use port 443 and verify the certificate chain.",
      newUserText: "Can you also cover database certificate rotation?",
      prevTags: ["nginx"]
    }, {
      llm: relationLlm(calls)
    });

    expect(calls).toEqual(["relation.classify.v1", "relation.arbitration.v1"]);
    expect(decision).toMatchObject({
      relation: "follow_up",
      confidence: 0.55
    });
    expect(decision.signals).toContain("arbitration_override");
  });

  it("falls back to weak relation heuristics when the plugin-style LLM classifier is malformed", async () => {
    const calls: string[] = [];
    const decision = await classifyTurnRelationWithLlm({
      prevUserText: "Configure nginx TLS for the service",
      prevAssistantText: "Use port 443 and verify the certificate chain.",
      newUserText: "then run the nginx reload check",
      prevTags: ["nginx"]
    }, {
      llm: relationLlm(calls, undefined, {
        "relation.classify.v1": {
          relation: "adjacent_topic",
          confidence: 1,
          reason: "bad relation"
        }
      })
    });

    expect(calls).toEqual(["relation.classify.v1"]);
    expect(decision.relation).toBe("follow_up");
    expect(decision.signals).toContain("r4_follow_phrase");
    expect(decision.signals).toContain("llm_skipped");
  });

  it("uses the plugin relation LLM prompt and arbitration framing", async () => {
    const calls: string[] = [];
    const messages = new Map<string, Array<{ role: "system" | "user" | "assistant"; content: string }>>();
    await classifyTurnRelationWithLlm({
      prevUserText: "Configure nginx TLS for the service",
      prevAssistantText: "Use port 443 and verify the certificate chain.",
      newUserText: "Can you also cover database certificate rotation?",
      prevTags: ["nginx"]
    }, {
      llm: relationLlm(calls, messages)
    });

    const primary = messages.get("relation.classify.v1");
    expect(primary?.[0]?.content).toContain("DEFAULT to follow_up");
    expect(primary?.[0]?.content).toContain("Nginx SSL");
    expect(primary?.[0]?.content).toContain("tools, systems, or methods");
    expect(primary?.[1]?.content).toContain("PREVIOUS_USER_MESSAGE");

    const arbitration = messages.get("relation.arbitration.v1");
    expect(arbitration?.[0]?.content).toContain("Tools/methods/details/sub-aspects");
    expect(arbitration?.[0]?.content).toContain("When in doubt, choose follow_up");
    expect(arbitration?.[1]?.content).toContain("CURRENT TASK CONTEXT");
    expect(arbitration?.[1]?.content).toContain("NEW MESSAGE");
  });

  it("seeds captured trace priority like the plugin so fresh rows are recallable before reward", () => {
    const [step] = captureTurnSteps({
      episodeId: "episode-capture",
      sessionId: "session-capture",
      turnId: "turn-capture",
      userText: "remember this workflow",
      assistantText: "use the memory service",
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(step?.value).toBe(0);
    expect(step?.priority).toBe(0.5);
  });

  it("drops empty captured steps like the plugin normalizer", () => {
    expect(captureTurnSteps({
      episodeId: "episode-empty",
      sessionId: "session-empty",
      turnId: "turn-empty",
      userText: "",
      assistantText: "",
      createdAtIso: "2026-05-29T00:00:00.000Z"
    })).toEqual([]);
  });

  it("preserves tool input shape while clamping output like the plugin normalizer", () => {
    const input = {
      command: "node",
      args: ["script.js"],
      cwd: "/tmp/project",
      env: { NODE_ENV: "test" }
    };
    const [step] = captureTurnSteps({
      episodeId: "episode-tool-input",
      sessionId: "session-tool-input",
      turnId: "turn-tool-input",
      toolCalls: [{
        name: "shell",
        input,
        output: `start-${"x".repeat(300)}-tail`,
        success: true
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z",
      maxToolOutputChars: 120
    });

    expect(step?.toolCalls[0]?.input).toBe(input);
    expect(step?.toolCalls[0]?.output).toContain("…[truncated]…");
  });

  it("captures one complete L1 trace for a user turn with multiple tool calls", () => {
    const steps = captureTurnSteps({
      episodeId: "episode-full-turn",
      sessionId: "session-full-turn",
      turnId: "turn-full-turn",
      userText: "查上海明天天气",
      assistantText: "上海明天局部有阵雨。",
      toolCalls: [
        { name: "exec", input: "curl wttr.in/Shanghai", output: "weather json", success: true },
        { name: "complete_goal", input: {}, output: "done", success: true }
      ],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(steps).toHaveLength(1);
    expect(steps[0]?.userText).toBe("查上海明天天气");
    expect(steps[0]?.agentText).toBe("上海明天局部有阵雨。");
    expect(steps[0]?.stepIndex).toBe(0);
    expect(steps[0]?.subStepTotal).toBe(1);
    expect(steps[0]?.toolCalls.map((call) => call.name)).toEqual(["exec", "complete_goal"]);
  });

  it("extracts inline reflection from assistant text like the plugin capture path", () => {
    const [step] = captureTurnSteps({
      episodeId: "episode-reflection",
      sessionId: "session-reflection",
      turnId: "turn-reflection",
      userText: "fix sqlite migration",
      assistantText: [
        "I inspected the migration before editing.",
        "### Reasoning:",
        "I checked the schema first because retrying the failing query would not explain the sqlite migration error.",
        "### Result",
        "The migration path is now clear."
      ].join("\n"),
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(step?.reflection.source).toBe("none");
    expect(step?.reflection.text).toBeNull();
    expect(step?.reflection.alpha).toBe(0);
    expect(step?.rawReflection).toContain("schema first");
    expect(step?.agentThinking).toContain("schema first");
  });

  it("indexes plugin action vectors from tool identity and input only", () => {
    const [first] = captureTurnSteps({
      episodeId: "episode-action-output-a",
      sessionId: "session-action-output",
      turnId: "turn-action-output",
      userText: "run the sqlite migration check",
      toolCalls: [{
        name: "shell",
        input: "npm test -- sqlite",
        output: "first output",
        success: true
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });
    const [second] = captureTurnSteps({
      episodeId: "episode-action-output-b",
      sessionId: "session-action-output",
      turnId: "turn-action-output",
      userText: "run the sqlite migration check",
      toolCalls: [{
        name: "shell",
        input: "npm test -- sqlite",
        output: "different output with MODULE_NOT_FOUND",
        success: false
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(first?.vecAction).toEqual(second?.vecAction);
    expect(second?.errorSignatures).toContain("MODULE_NOT_FOUND");
  });

  it("derives plugin capture tags from tool errorCode instead of tool output text", () => {
    const [withoutErrorCode] = captureTurnSteps({
      episodeId: "episode-tag-output",
      sessionId: "session-tag-output",
      turnId: "turn-tag-output",
      toolCalls: [{
        name: "shell",
        output: "error: NETWORK_REFUSED",
        success: false
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });
    const [withErrorCode] = captureTurnSteps({
      episodeId: "episode-tag-code",
      sessionId: "session-tag-code",
      turnId: "turn-tag-code",
      toolCalls: [{
        name: "shell",
        output: "short output",
        errorCode: "E_NETWORK_REFUSED",
        success: false
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(withoutErrorCode?.tags).toEqual(["shell"]);
    expect(withoutErrorCode?.errorSignatures).toContain("NETWORK_REFUSED");
    expect(withErrorCode?.tags).toEqual(expect.arrayContaining(["network", "refused", "shell"]));
  });

  it("matches the plugin error-signature corpus and ignores tool input text", () => {
    const [fromInputOnly] = captureTurnSteps({
      episodeId: "episode-error-input",
      sessionId: "session-error-input",
      turnId: "turn-error-input",
      toolCalls: [{
        name: "shell",
        input: "echo MODULE_NOT_FOUND",
        output: "command completed",
        success: false
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });
    const [fromErrorCode] = captureTurnSteps({
      episodeId: "episode-error-code",
      sessionId: "session-error-code",
      turnId: "turn-error-code",
      toolCalls: [{
        name: "shell",
        input: "echo ok",
        output: "command completed",
        errorCode: "MODULE_NOT_FOUND",
        success: false
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(fromInputOnly?.errorSignatures).not.toContain("MODULE_NOT_FOUND");
    expect(fromErrorCode?.errorSignatures).toContain("MODULE_NOT_FOUND");
  });

  it("keeps plugin insertion order for equal-scored error signatures", () => {
    const [step] = captureTurnSteps({
      episodeId: "episode-error-order",
      sessionId: "session-error-order",
      turnId: "turn-error-order",
      toolCalls: [{
        name: "shell",
        output: [
          "error: very long failure message appears first",
          "fatal: short fail"
        ].join("\n"),
        success: false
      }],
      createdAtIso: "2026-05-29T00:00:00.000Z"
    });

    expect(step?.errorSignatures.slice(0, 2)).toEqual([
      "error: very long failure message appears first",
      "fatal: short fail"
    ]);
  });

  it("derives L2 signature errCode from plugin output/reflection sources only", () => {
    expect(signatureFromTraceParts(["shell"], [{
      name: "shell",
      input: "echo MODULE_NOT_FOUND",
      output: "command completed",
      errorCode: "MODULE_NOT_FOUND",
      success: false
    }], "")).toBe("shell|_|shell|_");
    expect(signatureFromTraceParts(["shell"], [{
      name: "shell",
      input: "echo ok",
      output: "error: MODULE_NOT_FOUND",
      errorCode: "OTHER_ERROR",
      success: false
    }], "")).toBe("shell|_|shell|MODULE_NOT_FOUND");
    expect(signatureFromTraceParts(["shell"], [{
      name: "shell",
      input: "echo ok",
      output: "command completed",
      success: false
    }], "reflection saw EXIT_2")).toBe("shell|_|shell|EXIT_2");
  });

  it("uses the plugin skill lifecycle prior when resolving trials", () => {
    expect(skillEtaAfterTrial({
      currentEta: 0.4,
      previousAttempts: 0,
      previousPasses: 0,
      nextAttempts: 1,
      nextPasses: 1
    })).toBeCloseTo(0.7);
    expect(skillEtaAfterTrial({
      currentEta: 0.7,
      previousAttempts: 1,
      previousPasses: 1,
      nextAttempts: 2,
      nextPasses: 1
    })).toBeCloseTo(0.466666, 5);
  });

  it("promotes or archives candidate skills with plugin lifecycle thresholds", () => {
    expect(skillStatusAfterTrial({
      currentStatus: "candidate",
      eta: 0.7,
      trialsAttempted: 1,
      candidateTrials: 1,
      minEtaForRetrieval: 0.1,
      archiveEta: 0.1
    })).toBe("active");
    expect(skillStatusAfterTrial({
      currentStatus: "candidate",
      eta: 0,
      trialsAttempted: 1,
      candidateTrials: 1,
      minEtaForRetrieval: 0.1,
      archiveEta: 0.1
    })).toBe("archived");
    expect(skillStatusAfterTrial({
      currentStatus: "candidate",
      eta: 0.4,
      trialsAttempted: 1,
      candidateTrials: 1,
      minEtaForRetrieval: 0.1,
      repairCandidateMinEta: 0.5,
      repairOrigin: true,
      archiveEta: 0.1
    })).toBe("archived");
  });

  it("applies plugin reward drift to skill eta and archive transitions", () => {
    const eta = skillEtaAfterRewardDrift({
      currentEta: 0.8,
      magnitude: 0.2
    });
    expect(eta).toBeCloseTo(0.62);
    expect(skillStatusAfterRewardDrift({
      currentStatus: "active",
      eta: 0.05,
      archiveEta: 0.1
    })).toBe("archived");
    expect(skillStatusAfterRewardDrift({
      currentStatus: "archived",
      eta: 0.8,
      archiveEta: 0.1
    })).toBe("archived");
  });

  it("uses plugin L2 gain smoothing and current policy status", () => {
    const evidence = [
      trace("trace-low-a", "episode-a", 0.1, [1, 0]),
      trace("trace-low-b", "episode-b", 0.1, [1, 0])
    ];
    const draft = buildPolicyDraft({
      signature: "python|pytest|_",
      evidenceTraces: evidence,
      allTraces: [
        ...evidence,
        trace("trace-high-other", "episode-other", 0.8, [0, 1])
      ],
      minSupport: 1,
      minGain: 0.02,
      archiveGain: -0.05,
      tauSoftmax: 0.5,
      gainEmaAlpha: 0.4,
      currentStatus: "active",
      currentGain: 0.1,
      currentSupport: 2
    });

    expect(draft.rawGain).toBeLessThan(-0.3);
    expect(draft.gain).toBeCloseTo(0.4 * draft.rawGain + 0.6 * 0.1);
    expect(draft.status).toBe("archived");
  });

  it("combines reward axes with the plugin R_human weights", () => {
    expect(combineRewardAxes({
      goalAchievement: 1,
      processQuality: 0.5,
      userSatisfaction: 0
    })).toBeCloseTo(0.6);
  });

  it("backpropagates reward with normalized plugin credit assignment", () => {
    const now = Date.parse("2026-05-29T00:00:00.000Z");
    const traces = [
      { ...trace("trace-alpha", "episode-reward", 0, [1, 0]), ts: now - 2000, alpha: 0.5 },
      { ...trace("trace-mid", "episode-reward", 0, [1, 0]), ts: now - 1000, alpha: 0 },
      { ...trace("trace-last", "episode-reward", 0, [1, 0]), ts: now, alpha: 0 }
    ];

    const updates = backpropagateTraces({
      traces,
      rHuman: 1,
      gamma: 0.9,
      decayHalfLifeDays: 365,
      now
    });

    expect(updates.map((update) => update.traceId)).toEqual([
      "trace-alpha",
      "trace-mid",
      "trace-last"
    ]);
    expect(updates[0]?.value).toBeCloseTo(1, 6);
    expect(updates[1]?.value).toBeCloseTo(0, 6);
    expect(updates[2]?.value).toBeCloseTo(0, 6);
  });

  it("clamps plugin reward backprop parameters and decays priority", () => {
    const now = Date.parse("2026-05-29T00:00:00.000Z");
    const oldTrace = { ...trace("trace-old", "episode-reward", 0, [1, 0]), ts: now - 30 * 86_400_000, alpha: 1 };
    const freshTrace = { ...trace("trace-fresh", "episode-reward", 0, [1, 0]), ts: now, alpha: 1 };

    const positive = backpropagateTraces({
      traces: [oldTrace, freshTrace],
      rHuman: 5,
      gamma: 2,
      decayHalfLifeDays: 30,
      now
    });
    expect(positive[1]?.value).toBeCloseTo(0.5);
    expect(positive[0]?.value).toBeCloseTo(0.5);
    expect(positive[0]?.priority).toBeCloseTo(0.25, 6);
    expect(priorityFor(1, oldTrace.ts, 30, now)).toBeCloseTo(0.5, 6);

    const negative = backpropagateTraces({
      traces: [freshTrace],
      rHuman: -5,
      gamma: -1,
      decayHalfLifeDays: 30,
      now
    });
    expect(negative[0]?.value).toBeCloseTo(-1);
    expect(negative[0]?.priority).toBe(0);
    expect(priorityFor(-0.9, oldTrace.ts, 30, now)).toBe(0);
  });

  it("uses plugin L2 relaxed defaults for first policy promotion", () => {
    const evidence = [trace("trace-good", "episode-good", 0.8, [1, 0])];
    const draft = buildPolicyDraft({
      signature: "python|pytest|_",
      evidenceTraces: evidence,
      allTraces: evidence
    });

    expect(draft.support).toBe(1);
    expect(draft.gain).toBeGreaterThan(0.02);
    expect(draft.status).toBe("active");
  });

  it("counts L2 support by distinct positive evidence episode", () => {
    const evidence = [
      trace("trace-one", "episode-shared", 0.8, [1, 0]),
      trace("trace-two", "episode-shared", 0.7, [1, 0])
    ];
    const draft = buildPolicyDraft({
      signature: "python|pytest|_",
      evidenceTraces: evidence,
      allTraces: evidence,
      minSupport: 1
    });

    expect(draft.support).toBe(1);
    expect(draft.status).toBe("active");
  });

  it("uses negative traces as L2 counter evidence without counting them as support", () => {
    const positive = trace("trace-positive", "episode-shared", 0.8, [1, 0]);
    const negative = trace("trace-negative", "episode-shared", -0.8, [0, 1]);
    const withoutCounter = buildPolicyDraft({
      signature: "python|pytest|_",
      evidenceTraces: [positive],
      allTraces: [positive]
    });
    const withCounter = buildPolicyDraft({
      signature: "python|pytest|_",
      evidenceTraces: [positive],
      allTraces: [positive, negative]
    });

    expect(withCounter.support).toBe(1);
    expect(withCounter.sourceTraceIds).toEqual(["trace-positive"]);
    expect(withCounter.sourceTraceIds).not.toContain("trace-negative");
    expect(withCounter.rawGain).toBeGreaterThan(withoutCounter.rawGain);
  });

  it("packs L2 induction traces with plugin prompt caps and language steering", () => {
    const packed = packL2InductionTraces([
      {
        ...trace("trace-pack", "episode-pack", 0.8, [1, 0]),
        userText: `pytest ${"x".repeat(900)}`,
        agentText: `run focused test ${"y".repeat(900)}`,
        toolCalls: [{
          name: "shell",
          input: { cmd: "npm test" },
          output: "ok",
          success: true
        }]
      }
    ], 1200, "python|pytest|_");

    expect(packed).toContain("PATTERN_SIGNATURE: python|pytest|_");
    expect(packed).toContain("tools: shell");
    expect(packed).not.toContain("x".repeat(500));
    expect(languageSteeringLine(detectDominantLanguage(["请修复这个失败流程"]))).toContain("Simplified Chinese");
  });

  it("keeps plugin L3 loose admission dampening and domain tags", () => {
    const loose = buildWorldModelDraft({
      minPolicies: 2,
      clusterMinSimilarity: 0.9,
      policies: [
        policy("p1", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.5),
        policy("p2", "Validate CUSIP issuer rows from EDGAR filing XML", [0, 1], 0.5)
      ]
    });
    expect(loose).toHaveLength(1);
    expect(loose[0]!.admission).toBe("loose");
    expect(loose[0]!.cohesion).toBeCloseTo(Math.SQRT1_2, 5);
    expect(loose[0]!.domainTags).toEqual(expect.arrayContaining(["sec13f", "sec-tooling"]));
    const base = 0.5 * 0.7 + loose[0]!.cohesion * 0.3;
    expect(loose[0]!.confidence).toBeCloseTo(shapeWorldModelConfidence(base, "loose", loose[0]!.cohesion));
    expect(loose[0]!.body).toContain("Admission: loose");
    expect(loose[0]!.structure.environment[0]?.evidenceIds).toEqual(expect.arrayContaining(["p1", "p2"]));
    expect(loose[0]!.structure.inference[0]?.description).toContain("admission=loose");

    const strict = buildWorldModelDraft({
      minPolicies: 2,
      clusterMinSimilarity: 0.9,
      policies: [
        policy("p3", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.5),
        policy("p4", "Validate SEC 13F filing XML parser output", [0.99, 0.01], 0.5)
      ]
    });
    expect(strict[0]!.admission).toBe("strict");
    expect(strict[0]!.confidence).toBeGreaterThan(loose[0]!.confidence);
  });

  it("uses plugin L3 and Skill gain/support eligibility floors", () => {
    expect(buildWorldModelDraft({
      policies: [policy("p-low-gain", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.01)]
    })).toHaveLength(0);
    expect(buildWorldModelDraft({
      policies: [policy("p-enough-gain", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.03)]
    })).toHaveLength(1);

    expect(buildSkillDraft({
      policy: policy("p-skill-low-gain", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.01),
      minGain: 0.02,
      minSupport: 1
    })).toBeNull();
    expect(buildSkillDraft({
      policy: policy("p-skill-enough-gain", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.03),
      minGain: 0.02,
      minSupport: 1
    })?.status).toBe("candidate");
    expect(buildSkillDraft({
      policy: {
        ...policy("p-skill-failure-only", "Avoid repeating a failed SEC 13F parser path", [1, 0], 0.5),
        experienceType: "failure_avoidance",
        evidencePolarity: "negative",
        skillEligible: false
      },
      minGain: 0.02,
      minSupport: 1
    })).toBeNull();
    expect(buildSkillDraft({
      policy: policy("p-skill-rebuild", "Parse SEC 13F infotable holdings with sec-api", [1, 0], 0.03),
      existing: {
        id: "skill-existing",
        memory: policy("skill-existing-policy", "existing skill", [1, 0], 0.5).memory,
        name: "existing",
        eta: 0.8,
        status: "active",
        support: 1,
        sourcePolicyIds: ["p-old"],
        sourceWorldModelIds: [],
        evidenceAnchorIds: ["trace-old"],
        invocationGuide: "existing",
        trialsAttempted: 0,
        trialsPassed: 0,
        repairOrigin: false,
        strictTrial: false,
        successRate: 0,
        betaPosterior: {
          alpha: 1,
          beta: 1,
          mean: 0.5
        },
        vec: [1, 0]
      },
      minGain: 0.02,
      minSupport: 1,
      minEtaForRetrieval: 0.1
    })?.eta).toBeCloseTo(0.515);
  });

  it("uses plugin skill verifier coverage and evidence resonance gates", () => {
    const source = policy("p-skill-verify", "Run pytest after changing TypeScript memory service code", [1, 0], 0.5);
    source.signature = "typescript|pytest|pytest";
    const draft = buildSkillDraft({
      policy: source,
      minGain: 0.02,
      minSupport: 1
    });
    expect(draft).not.toBeNull();
    const evidence = {
      ...trace("trace-skill-verify", "e1", 0.8, [1, 0]),
      userText: "TypeScript memory service code changed",
      agentText: "Run pytest and inspect failures before finalizing",
      summary: "Run pytest after code changes",
      toolCalls: [{ name: "pytest" }]
    };

    expect(verifySkillDraft({
      draft: draft!,
      evidenceTraces: [evidence]
    }).ok).toBe(true);
    expect(verifySkillDraft({
      draft: {
        ...draft!,
        procedureJson: {
          ...draft!.procedureJson,
          tools: ["kubectl", "aws"]
        }
      },
      evidenceTraces: [evidence]
    })).toMatchObject({
      ok: false,
      reason: "coverage=0.00<0.5"
    });
  });

  it("extracts command-level tool evidence from string tool inputs like the plugin", () => {
    const source = policy("p-command-tool", "Install apk build deps before compiling native packages", [1, 0], 0.5);
    source.signature = "alpine|native|shell";
    const draft = buildSkillDraft({
      policy: source,
      minGain: 0.02,
      minSupport: 1
    });
    expect(draft).not.toBeNull();
    const evidence = {
      ...trace("trace-command-tool", "episode-command-tool", 0.8, [1, 0]),
      userText: "native package compile fails on alpine",
      agentText: "Run apk add openssl-dev before rebuilding the package",
      summary: "Use apk build dependencies for native package compilation",
      toolCalls: [{ name: "shell", input: "apk add openssl-dev" }]
    };

    expect(Array.from(extractToolNamesFromTraces([evidence])).sort()).toEqual(["apk", "shell"]);
    expect(verifySkillDraft({
      draft: {
        ...draft!,
        procedureJson: {
          ...draft!.procedureJson,
          tools: ["apk"]
        }
      },
      evidenceTraces: [evidence]
    }).ok).toBe(true);
  });

  it("builds plugin-style episode rollup candidates for multi-trace Tier-2 recall", () => {
    const result = retrievePluginMemories({
      query: "python pytest failure",
      queryVector: [1, 0],
      memories: [
        traceMemory("trace_episode_a_1", "episode_a", "python pytest setup failed", 0.8, [1, 0]),
        traceMemory("trace_episode_a_2", "episode_a", "pytest rerun fixed fixture", 0.7, [0.95, 0.05]),
        traceMemory("trace_episode_b_1", "episode_b", "unrelated docker cleanup", 0.2, [0, 1])
      ],
      layers: ["L1"],
      limit: 4,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z"),
      config: { mmrLambda: 1 }
    });

    expect(result.debug.tierSizes.tier2).toBe(3);
    expect(result.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "episode_a",
        source: "episode"
      })
    ]));
  });

  it("retrieves Chinese trace memories with CJK punctuation and phrase overlap", () => {
    const result = retrievePluginMemories({
      query: "青竹项目的部署端口是多少？林浩偏好什么回答风格？",
      memories: [
        traceMemory(
          "trace-cjk-memory",
          "episode-cjk",
          "请记住：我叫林浩，喜欢简洁中文回答。我的项目代号是青竹，部署端口固定为 49231。",
          0.8,
          [0, 1]
        )
      ],
      layers: ["L1"],
      limit: 3,
      mode: "turn_start",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toContain("trace-cjk-memory");
  });

  it("prefers the episode rollup when multiple concrete traces share an episode", () => {
    const result = retrievePluginMemories({
      query: "python pytest failure",
      queryVector: [1, 0],
      memories: [
        traceMemory("trace_episode_dedupe_1", "episode_dedupe", "python pytest setup failed", 0.8, [1, 0]),
        traceMemory("trace_episode_dedupe_2", "episode_dedupe", "pytest rerun fixed fixture", 0.7, [0.95, 0.05])
      ],
      layers: ["L1"],
      limit: 3,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "episode_dedupe",
        source: "episode"
      })
    ]);
  });

  it("dedupes concrete traces behind the episode rollup when the rollup wins", () => {
    const result = retrievePluginMemories({
      query: "python pytest failure",
      queryVector: [1, 0],
      memories: [
        traceMemory("trace_episode_dedupe_1", "episode_dedupe", "python pytest setup failed", 0.8, [1, 0]),
        traceMemory("trace_episode_dedupe_2", "episode_dedupe", "pytest rerun fixed fixture", 0.7, [0.95, 0.05])
      ],
      layers: ["L1"],
      limit: 3,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z"),
      config: { mmrLambda: 1 }
    });

    expect(result.hits).toEqual([
      expect.objectContaining({
        id: "episode_dedupe",
        source: "episode"
      })
    ]);
  });

  it("honors plugin ranker tuning for relative threshold and multi-channel bypass", () => {
    const memories = [
      traceMemory("trace-ranker-strong", "episode-strong", "python pytest exact match", 0.8, [1, 0]),
      traceMemory("trace-ranker-multi-channel", "episode-weak", "python pytest weaker but confirmed", 0.1, [0.35, 0.65])
    ];
    const withBypass = retrievePluginMemories({
      query: "python pytest",
      queryVector: [1, 0],
      memories,
      layers: ["L1"],
      limit: 5,
      config: {
        relativeThresholdFloor: 0.95,
        multiChannelBypass: true
      },
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });
    const withoutBypass = retrievePluginMemories({
      query: "python pytest",
      queryVector: [1, 0],
      memories,
      layers: ["L1"],
      limit: 5,
      config: {
        relativeThresholdFloor: 0.95,
        multiChannelBypass: false
      },
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(withBypass.hits.map((hit) => hit.id)).toContain("trace-ranker-multi-channel");
    expect(withoutBypass.hits.map((hit) => hit.id)).not.toContain("trace-ranker-multi-channel");
  });

  it("uses plugin smart-seed MMR when choosing each tier seed", () => {
    const result = retrievePluginMemories({
      query: "specialterm",
      queryVector: [1, 0],
      memories: [
        skillMemory("skill-anchor", "anchor skill workflow", 1, [1, 0]),
        traceMemory("trace-seed-redundant", "episode-seed-a", "vector-only redundant trace", 1, [1, 0]),
        traceMemory("trace-seed-diverse", "episode-seed-b", "specialterm confirmed trace", 0.67, [0.3, 0.953939])
      ],
      layers: ["Skill", "L1"],
      limit: 2,
      config: {
        smartSeed: true,
        smartSeedRatio: 0.7,
        mmrLambda: 0.7
      },
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["skill-anchor", "trace-seed-diverse"]);
  });

  it("applies plugin retrieval floors for skill eta while keeping zero-priority traces recallable", () => {
    const lowEtaSkill = skillMemory("skill-low-eta", "python pytest workflow", 0.05, [1, 0]);
    const activeSkill = skillMemory("skill-active", "python pytest workflow", 0.2, [1, 0]);
    const archivedSkill = skillMemory("skill-archived", "python pytest workflow", 0.9, [1, 0]);
    (archivedSkill.properties.internal_info.skill as { status: string }).status = "archived";
    const skillResult = retrievePluginMemories({
      query: "python pytest workflow",
      queryVector: [1, 0],
      memories: [lowEtaSkill, activeSkill, archivedSkill],
      layers: ["Skill"],
      limit: 5,
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(skillResult.hits.map((hit) => hit.id)).toEqual(["skill-active"]);

    const zeroPriorityTrace = traceMemory("trace-low-priority", "episode-low", "python pytest broken", 0, [1, 0]);
    const defaultTraceResult = retrievePluginMemories({
      query: "python pytest broken",
      queryVector: [1, 0],
      memories: [zeroPriorityTrace],
      layers: ["L1"],
      limit: 5,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });
    const repairTraceResult = retrievePluginMemories({
      query: "python pytest broken",
      queryVector: [1, 0],
      memories: [zeroPriorityTrace],
      layers: ["L1"],
      limit: 5,
      mode: "decision_repair",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(defaultTraceResult.hits.map((hit) => hit.id)).toContain("trace-low-priority");
    expect(repairTraceResult.hits.map((hit) => hit.id)).toContain("trace-low-priority");
  });

  it("hides low-confidence world models from Tier-3 retrieval", () => {
    const lowConfidence = worldModelMemory("world-low", "python sqlite constraints", 0.1, [1, 0]);
    const highConfidence = worldModelMemory("world-high", "python sqlite constraints", 0.3, [1, 0]);
    const result = retrievePluginMemories({
      query: "python sqlite constraints",
      queryVector: [1, 0],
      memories: [lowConfidence, highConfidence],
      layers: ["L3"],
      limit: 5,
      mode: "world_model",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["world-high"]);
  });

  it("hides archived policies from Tier-2 policy retrieval", () => {
    const activePolicy = policyMemory("policy-active", "python pytest policy", "active", [1, 0]);
    const archivedPolicy = policyMemory("policy-archived", "python pytest policy", "archived", [1, 0]);
    const result = retrievePluginMemories({
      query: "python pytest policy",
      queryVector: [1, 0],
      memories: [activePolicy, archivedPolicy],
      layers: ["L2"],
      limit: 5,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["policy-active"]);
  });

  it("uses plugin Tier-2 experience salience for feedback-derived L2 policies", () => {
    const plainPolicy = policyMemory("policy-plain", "python pytest policy", "active", [1, 0]);
    const feedbackPolicy = policyMemory("policy-feedback", "python pytest policy", "active", [1, 0]);
    const feedbackInternal = feedbackPolicy.properties.internal_info.policy as Record<string, unknown>;
    feedbackInternal.gain = 0.02;
    feedbackInternal.raw_gain = 0.02;
    feedbackInternal.policy_confidence = 0.95;
    feedbackInternal.confidence = 0.95;
    feedbackInternal.salience = 0.1;
    feedbackInternal.source_feedback_ids = ["feedback-1"];

    const result = retrievePluginMemories({
      query: "python pytest policy",
      queryVector: [1, 0],
      memories: [plainPolicy, feedbackPolicy],
      layers: ["L2"],
      limit: 2,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["policy-feedback", "policy-plain"]);
    expect(result.hits[0]?.snippet).toContain("Trigger:");
  });

  it("suppresses feedback-derived experiences covered by a fresh plugin skill", () => {
    const coveredPolicy = policyMemory("policy-covered-experience", "python pytest workflow", "active", [1, 0]);
    const coveredInternal = coveredPolicy.properties.internal_info.policy as Record<string, unknown>;
    coveredInternal.source_feedback_ids = ["feedback-covered"];
    coveredInternal.salience = 0.9;
    const coveringSkill = skillMemory("skill-covering", "python pytest workflow", 0.9, [1, 0]);
    const skillInternal = coveringSkill.properties.internal_info.skill as Record<string, unknown>;
    skillInternal.source_policy_ids = ["policy-covered-experience"];

    const result = retrievePluginMemories({
      query: "python pytest workflow",
      queryVector: [1, 0],
      memories: [coveredPolicy, coveringSkill],
      layers: ["L2", "Skill"],
      limit: 5,
      mode: "search",
      now: Date.parse("2026-05-29T00:00:00.000Z")
    });

    expect(result.hits.map((hit) => hit.id)).toEqual(["skill-covering"]);
  });
});

function policy(id: string, title: string, vec: number[], gain: number): PolicyMemoryMeta {
  return {
    id,
    memory: {
      id,
      timeline: "2026-05-29T00:00:00.000Z",
      userId: "u",
      memoryType: "LongTermMemory",
      status: "activated",
      visibility: "private",
      memoryValue: title,
      tags: ["policy"],
      info: {},
      properties: {
        internal_info: {
          memory_layer: "L2"
        }
      },
      memoryLayer: "L2",
      version: 1,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    } satisfies MemoryRow,
    title,
    trigger: title,
    procedure: title,
    verification: "verify output",
    boundary: "same domain",
    support: 2,
    gain,
    confidence: 0.8,
    status: "active",
    experienceType: "success_pattern",
    evidencePolarity: "positive",
    skillEligible: true,
    signature: "sec13f|sec-tooling|_",
    sourceEpisodeIds: ["e1", "e2"],
    sourceTraceIds: [`tr_${id}`],
    sourceFeedbackIds: [],
    decisionGuidance: {
      preference: [],
      antiPattern: []
    },
    salience: gain,
    vec,
    updatedAtMs: 0
  };
}

function trace(id: string, episodeId: string, value: number, vec: number[]): TraceMemoryMeta {
  return {
    id,
    memory: {
      id,
      timeline: "2026-05-29T00:00:00.000Z",
      userId: "u",
      memoryType: "LongTermMemory",
      status: "activated",
      visibility: "private",
      memoryValue: id,
      tags: ["python", "pytest"],
      info: {},
      properties: {
        internal_info: {
          memory_layer: "L1"
        }
      },
      memoryLayer: "L1",
      version: 1,
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:00.000Z"
    } satisfies MemoryRow,
    ts: 0,
    episodeId,
    userId: "u",
    summary: id,
    userText: id,
    agentText: id,
    toolCalls: [],
    reflection: id,
    alpha: 1,
    value,
    priority: value,
    tags: ["python", "pytest"],
    errorSignatures: [],
    vecSummary: vec,
    vecAction: vec,
    signature: "python|pytest|_"
  };
}

function traceMemory(
  id: string,
  episodeId: string,
  summary: string,
  value: number,
  vec: number[]
): MemoryRow {
  return attachMemoryVectors({
    id,
    timeline: "2026-05-29T00:00:00.000Z",
    userId: "u",
    sessionId: "session-a",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryValue: summary,
    tags: ["python", "pytest"],
    info: {
      profile_id: "default"
    },
    properties: {
      internal_info: {
        memory_layer: "L1",
        memory_kind: "trace",
        trace: {
          key: id,
          ts: Date.parse("2026-05-29T00:00:00.000Z"),
          turn_id: id,
          raw_turn_id: `raw-${id}`,
          episode_id: episodeId,
          step_index: 0,
          sub_step_total: 1,
          tool_calls: [],
          reflection: summary,
          alpha: 1,
          usable: true,
          reflection_source: "synth",
          summary,
          tags: ["python", "pytest"],
          value,
          priority: value,
          signature: "python|pytest|_",
          error_signatures: []
        }
      }
    },
    memoryLayer: "L1",
    version: 1,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  }, [
    { vectorField: "vec_summary", vector: vec },
    { vectorField: "vec_action", vector: vec }
  ]);
}

function skillMemory(
  id: string,
  invocationGuide: string,
  eta: number,
  vec: number[]
): MemoryRow {
  return attachMemoryVectors({
    id,
    timeline: "2026-05-29T00:00:00.000Z",
    userId: "u",
    memoryType: "SkillMemory",
    status: "activated",
    visibility: "private",
    memoryKey: invocationGuide,
    memoryValue: invocationGuide,
    tags: ["python", "pytest"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "Skill",
        memory_kind: "skill",
        skill: {
          name: id,
          eta,
          status: "active",
          source_policy_ids: ["policy-skill"],
          evidence_anchor_ids: ["trace-skill"],
          invocation_guide: invocationGuide,
          trials_attempted: 1,
          trials_passed: 1
        }
      }
    },
    memoryLayer: "Skill",
    version: 1,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  }, [{ vectorField: "vec", vector: vec }]);
}

function policyMemory(
  id: string,
  title: string,
  status: "candidate" | "active" | "archived",
  vec: number[]
): MemoryRow {
  return attachMemoryVectors({
    id,
    timeline: "2026-05-29T00:00:00.000Z",
    userId: "u",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: title,
    memoryValue: title,
    tags: ["python", "pytest", "policy"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L2",
        memory_kind: "policy",
        policy: {
          title,
          trigger: title,
          procedure: title,
          verification: "verify output",
          boundary: "same domain",
          support: 2,
          gain: 0.5,
          raw_gain: 0.5,
          policy_confidence: 0.8,
          status,
          experience_type: "success_pattern",
          evidence_polarity: "positive",
          skill_eligible: true,
          signature: "python|pytest|_|_",
          source_episode_ids: ["episode-policy"],
          source_trace_ids: ["trace-policy"],
          decision_guidance: {
            preference: [],
            anti_pattern: []
          }
        }
      }
    },
    memoryLayer: "L2",
    version: 1,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  }, [{ vectorField: "vec", vector: vec }]);
}

function worldModelMemory(
  id: string,
  body: string,
  confidence: number,
  vec: number[]
): MemoryRow {
  return attachMemoryVectors({
    id,
    timeline: "2026-05-29T00:00:00.000Z",
    userId: "u",
    memoryType: "LongTermMemory",
    status: "activated",
    visibility: "private",
    memoryKey: body,
    memoryValue: body,
    tags: ["python", "sqlite"],
    info: {},
    properties: {
      internal_info: {
        memory_layer: "L3",
        memory_kind: "world_model",
        world_model: {
          title: id,
          domain_key: "python|db",
          domain_tags: ["python", "db"],
          policy_ids: ["policy-world"],
          confidence,
          cohesion: 1,
          admission: "strict",
          structure: {
            environment: [{ label: "python", description: "python sqlite", evidenceIds: ["policy-world"] }],
            inference: [{ label: "constraints", description: "sqlite constraints", evidenceIds: ["policy-world"] }],
            constraints: [{ label: "scope", description: "compatible tasks", evidenceIds: ["policy-world"] }]
          },
          body
        }
      }
    },
    memoryLayer: "L3",
    version: 1,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z"
  }, [{ vectorField: "vec", vector: vec }]);
}

function intentLlm(
  calls: string[],
  response: Record<string, unknown> = {
    kind: "memory_probe",
    confidence: 0.77,
    reason: "asks about prior context"
  }
): LlmClient {
  return {
    config: {
      provider: "host",
      endpoint: "http://127.0.0.1/intent",
      model: "intent-test",
      enableThinking: false,
      temperature: 0,
      maxTokens: 300,
      timeoutMs: 6000,
      maxRetries: 0,
      malformedRetries: 0
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      _messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      calls.push(options.operation);
      return response as T;
    },
    status() {
      return {
        provider: "host",
        model: "intent-test",
        configured: true,
        remote: true
      };
    }
  };
}

function relationLlm(
  calls: string[],
  messagesByOperation?: Map<string, Array<{ role: "system" | "user" | "assistant"; content: string }>>,
  responsesByOperation: Record<string, Record<string, unknown>> = {}
): LlmClient {
  return {
    config: {
      provider: "host",
      endpoint: "http://127.0.0.1/relation",
      model: "relation-test",
      enableThinking: false,
      temperature: 0,
      maxTokens: 300,
      timeoutMs: 6000,
      maxRetries: 0,
      malformedRetries: 0
    },
    isConfigured() {
      return true;
    },
    async complete() {
      return "{}";
    },
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      calls.push(options.operation);
      messagesByOperation?.set(options.operation, messages);
      if (responsesByOperation[options.operation]) {
        return responsesByOperation[options.operation] as T;
      }
      if (options.operation === "relation.classify.v1") {
        return {
          relation: "new_task",
          confidence: 0.7,
          reason: "database certificate rotation looks adjacent but maybe new"
        } as unknown as T;
      }
      return {
        relation: "follow_up",
        reason: "same certificate-management goal"
      } as unknown as T;
    },
    status() {
      return {
        provider: "host",
        model: "relation-test",
        configured: true,
        remote: true
      };
    }
  };
}
