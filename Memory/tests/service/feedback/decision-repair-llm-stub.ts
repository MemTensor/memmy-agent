import { DEFAULT_MEMMY_CONFIG, type LlmClient } from "../../../src/index.js";

export function createDecisionRepairEvolutionLlm(): LlmClient {
  return {
    config: {
      ...DEFAULT_MEMMY_CONFIG.evolution,
      provider: "host",
      endpoint: "http://127.0.0.1/decision-repair-evolution",
      model: "decision-repair-evolution"
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
      if (options.operation === "reward.reward.r_human.v7") {
        return {
          goal_achievement: 1,
          process_quality: 1,
          user_satisfaction: 1,
          label: "success",
          reason: "explicit positive feedback confirms successful completion"
        } as unknown as T;
      }
      if (options.operation === "failure.experience.sink.v5") {
        const payload = JSON.parse(_messages.find((message) => message.role === "user")?.content ?? "{}") as {
          evidence_trace_ids?: string[];
        };
        const traceId = payload.evidence_trace_ids?.[0];
        return {
          title: "Avoid reporting TLS completion before verification",
          trigger: "When configuring TLS and reporting the service endpoint.",
          procedure: "Use the requested secure port and verify TLS before reporting completion.",
          verification: "Confirm the secure endpoint responds successfully with certificate verification enabled.",
          boundary: "Use for TLS configuration tasks with an explicit port or verification requirement.",
          experience_type: "failure_avoidance",
          decision_guidance: {
            prefer: ["Verify the secure endpoint before reporting completion."],
            avoid: ["Do not report TLS completion while the requested port or verification remains wrong."]
          },
          support_trace_ids: traceId ? [traceId] : [],
          confidence: 0.82
        } as unknown as T;
      }
      if (options.operation === "l2.induction.v4") {
        return {
          title: "Use focused sqlite repair checks",
          trigger: "sqlite migration repair requires deterministic verification",
          action: "Inspect migration output, apply the targeted repair, and rerun the focused check.",
          rationale: "The repair path is supported by successful trace evidence.",
          verification: "Rerun the focused sqlite migration check and confirm it passes.",
          boundary: "Use for sqlite migration repair workflows with concrete evidence.",
          caveats: ["Do not retry blindly before reading migration output."],
          confidence: 0.77,
          support_trace_ids: []
        } as unknown as T;
      }
      if (options.operation === "l3.abstraction.v3") {
        return {
          title: "SQLite migration repair environment",
          domain_tags: ["sqlite", "migration"],
          environment: [{
            label: "repair workflow",
            description: "The workflow validates sqlite migration repairs with focused checks.",
            evidenceIds: []
          }],
          inference: [],
          constraints: [],
          body: "SQLite migration repair environment.",
          confidence: 0.82
        } as unknown as T;
      }
      if (options.operation === "skill.crystallize") {
        return {
          name: "memory_workflow_sqlite_repair",
          retrieval_blurb: "Use for sqlite migration repair workflows that require focused verification.",
          trigger_context: "Use when a sqlite migration repair should inspect output before retrying.",
          summary: "Inspect migration output, apply the targeted repair, and rerun the focused check.",
          steps: [{
            title: "Inspect migration failure",
            body: "Read the sqlite migration failure output before retrying."
          }, {
            title: "Rerun focused check",
            body: "Rerun the exact focused check after applying the repair."
          }],
          tools: [],
          tags: ["sqlite", "migration", "repair"]
        } as unknown as T;
      }
      return {} as T;
    },
    status() {
      return {
        provider: "host",
        model: "decision-repair-evolution",
        configured: true,
        remote: true
      };
    }
  };
}
