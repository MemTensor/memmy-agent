import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";

export function createCapturingL2Llm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string };
}>,
  skillCrystallizeResponse?: Record<string, unknown>,
  l2InductionResponse?: Record<string, unknown>,
  l3AbstractionResponse?: Record<string, unknown>
): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/l2-capturing",
      model: "l2-capturing"
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
      calls.push({ messages, options });
      if (options.operation === "l2.induction.v3") {
        return (l2InductionResponse ?? {
          title: "Use focused pytest migration checks",
          trigger: "pytest workflow fails around sqlite migration output",
          action: "Run the focused pytest workflow, inspect migration output, then retry the exact failing test.",
          rationale: "The evidence succeeded after narrowing the failing pytest path.",
          verification: "Rerun the exact failing pytest test and confirm it passes.",
          boundary: "Use for pytest migration workflows with concrete failing-test evidence.",
          caveats: ["Do not retry blindly before reading the migration output."],
          confidence: 0.77,
          support_trace_ids: []
        }) as unknown as T;
      }
      if (options.operation === "l3.abstraction.v2") {
        return (l3AbstractionResponse ?? {
          title: "Pytest sqlite migration environment",
          domain_tags: ["pytest", "sqlite"],
          environment: [{
            label: "test harness",
            description: "The project has pytest checks that exercise sqlite migration behavior.",
            evidenceIds: []
          }],
          inference: [{
            label: "migration failures",
            description: "Focused pytest failures expose sqlite migration regressions before broader runs.",
            evidenceIds: []
          }],
          constraints: [{
            label: "schema state",
            description: "SQLite schema state affects whether migration tests produce stable outcomes.",
            evidenceIds: []
          }],
          body: "Pytest sqlite migration environment.",
          confidence: 0.82
        }) as unknown as T;
      }
      if (options.operation === "skill.crystallize") {
        return (skillCrystallizeResponse ?? {
          name: "Focused Pytest Migration With A Very Very Long Name!!",
          retrieval_blurb: "Use for user requests about pytest sqlite migration failures and focused diagnostics.",
          trigger_context: "Use when a pytest sqlite migration workflow needs focused diagnostics.",
          display_title: "Focused pytest migration workflow",
          summary: "Use a focused pytest check to diagnose sqlite migration regressions.",
          parameters: [
            "schema-out parameter",
            {
              name: "mode",
              type: "enum",
              required: true,
              description: "Pytest run mode.",
              enum: ["focused", 7, "full"]
            },
            {
              type: "string",
              description: "Missing name should be filtered."
            }
          ],
          preconditions: [
            "A pytest workflow is failing around sqlite migration output. Read [unsafe](javascript:alert(1)).",
            42,
            "<script>alert(1)</script>"
          ],
          steps: [
            {
              title: "Run focused pytest",
              body: "Run the focused pytest workflow and inspect migration output before retrying."
            },
            {
              title: "Verify result",
              body: "Repeat the exact failing test after the migration fix."
            }
          ],
          examples: [
            "schema-out example",
            {
              input: "pytest sqlite migration failure",
              expected: 200
            },
            {}
          ],
          invocationGuide: "untrusted freeform guide that is outside the plugin schema",
          procedureJson: {
            summary: "untrusted schema-out procedure summary",
            tools: ["fake_tool"],
            tags: ["SchemaOut"],
            decisionGuidance: {
              antiPattern: ["Avoid accepting schema-out procedureJson."]
            }
          },
          tools: ["shell", "Shell"],
          decision_guidance: {
            preference: ["Prefer reading migration output before retrying.", "prefer reading migration output before retrying."],
            anti_pattern: ["Avoid blind pytest retries.", 404]
          },
          tags: ["Pytest", "pytest", "sqlite"]
        }) as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "l2-capturing",
        configured: true,
        remote: true
      };
    }
  };
}

export function createNoToolSkillLlm(calls: Array<{
  messages: Array<{ role: string; content: string }>;
  options: { operation: string };
}> = []): LlmClient {
  const base = createCapturingL2Llm(calls, {
    name: "memory_workflow_pytest_retry",
    retrieval_blurb: "Use for python REST memory workflows and pytest retry workflows that require focused verification.",
    trigger_context: "Use when a memory workflow or pytest workflow should inspect output before retrying.",
    summary: "Inspect the workflow output, apply the targeted fix, and rerun the focused check.",
    steps: [{
      title: "Inspect pytest failure",
      body: "Read the pytest failure output before retrying the command."
    }, {
      title: "Rerun focused check",
      body: "Rerun the exact focused pytest command after applying the fix."
    }],
    tools: [],
    tags: ["pytest", "retry"]
  });
  return {
    ...base,
    async completeJson<T extends Record<string, unknown>>(
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      options: { operation: string }
    ): Promise<T> {
      if (options.operation === "reward.reward.r_human.v6") {
        calls.push({ messages, options });
        return {
          goal_achievement: 1,
          process_quality: 1,
          user_satisfaction: 1,
          label: "success",
          reason: "explicit positive feedback confirms successful completion"
        } as unknown as T;
      }
      return base.completeJson<T>(messages, options);
    }
  };
}
