import type { ProjectEvidenceInput } from "../../src/service/evolution/project-evidence.js";

export interface ProjectEvidenceEpisodeFixture {
  id: string;
  label: "noise" | "evidence";
  input: ProjectEvidenceInput;
}

// Compact replay set sampled from the failure modes seen in imported agent traces.
export const PROJECT_EVIDENCE_DATASET: ProjectEvidenceEpisodeFixture[] = [
  { id: "ep-01", label: "noise", input: { id: "ep-01", userText: "继续" } },
  { id: "ep-02", label: "noise", input: { id: "ep-02", userText: "有了吗" } },
  { id: "ep-03", label: "noise", input: { id: "ep-03", userText: "What is the architecture?" } },
  { id: "ep-04", label: "noise", input: { id: "ep-04", userText: "看看现在 L2 L3 skill 的质量如何" } },
  { id: "ep-05", label: "noise", input: { id: "ep-05", userText: "<codex_internal_context source=\"goal\">continue</codex_internal_context>" } },
  { id: "ep-06", label: "noise", input: { id: "ep-06", userText: "You are a focused child agent spawned by a parent agent." } },
  { id: "ep-07", label: "noise", input: { id: "ep-07", userText: "下一步什么工作" } },
  { id: "ep-08", label: "noise", input: { id: "ep-08", userText: "Can you look at the API?" } },
  { id: "ep-09", label: "noise", input: { id: "ep-09", userText: "再看看" } },
  { id: "ep-10", label: "noise", input: { id: "ep-10", userText: "<memmy_memory_context>historical context</memmy_memory_context>" } },
  { id: "ep-11", label: "noise", input: { id: "ep-11", userText: "What commands should we use?" } },
  { id: "ep-12", label: "noise", input: { id: "ep-12", userText: "继续检查数据库" } },
  { id: "ep-13", label: "noise", input: { id: "ep-13", userText: "Are there any skills?" } },
  { id: "ep-14", label: "noise", input: { id: "ep-14", userText: "看看这个项目" } },
  { id: "ep-15", label: "noise", input: { id: "ep-15", userText: "The next task is to continue." } },
  { id: "ep-16", label: "evidence", input: { id: "ep-16", userText: "Run the migration and verify the schema.", agentText: "Migration completed successfully; schema check passed.", toolCalls: [{ name: "shell", output: "exit code 0" }] } },
  { id: "ep-17", label: "evidence", input: { id: "ep-17", userText: "Use workspace_id for isolation.", agentText: "Implemented the namespace filter and tests pass.", reflection: "The API now enforces workspace scope." } },
  { id: "ep-18", label: "evidence", input: { id: "ep-18", userText: "Retry the failed worker job.", agentText: "The job succeeded on attempt two.", toolCalls: [{ name: "worker", output: "status: succeeded" }] } },
  { id: "ep-19", label: "evidence", input: { id: "ep-19", userText: "Add a stable dedupe key.", agentText: "The key is now derived from normalized namespace and signature.", reflection: "Equivalent inputs produce the same key." } },
  { id: "ep-20", label: "evidence", input: { id: "ep-20", userText: "Run the TypeScript tests.", agentText: "16 tests passed with exit code 0.", toolCalls: [{ name: "shell", output: "16 passed" }] } },
  { id: "ep-21", label: "evidence", input: { id: "ep-21", userText: "Do not activate a candidate automatically.", agentText: "Candidates remain resolving until the quality gate is met.", reflection: "Activation now requires explicit evidence." } },
  { id: "ep-22", label: "evidence", input: { id: "ep-22", userText: "Delete the generated project summaries.", agentText: "Removed 43 derived memories and preserved all L1 rows.", toolCalls: [{ name: "sqlite", output: "integrity_check: ok" }] } },
  { id: "ep-23", label: "evidence", input: { id: "ep-23", userText: "Use structured JSON from the evolution model.", agentText: "The client retries malformed JSON and validates the object shape.", reflection: "Unstructured completions are rejected." } },
  { id: "ep-24", label: "evidence", input: { id: "ep-24", userText: "Run the Docker health check.", agentText: "The service is healthy on port 18960.", toolCalls: [{ name: "docker", output: "healthy" }] } },
  { id: "ep-25", label: "evidence", input: { id: "ep-25", userText: "Keep raw L1 evidence immutable.", agentText: "The cleanup transaction changed only derived rows.", reflection: "L1 count is unchanged after replay." } },
  { id: "ep-26", label: "evidence", input: { id: "ep-26", userText: "Require two independent policy supports.", agentText: "The L3 gate skipped the single-policy cluster.", reflection: "A lone policy cannot establish a world model." } },
  { id: "ep-27", label: "evidence", input: { id: "ep-27", userText: "Generate the skill only after a passed trial.", agentText: "The skill stayed resolving until the trial passed.", toolCalls: [{ name: "trial", output: "pass" }] } },
  { id: "ep-28", label: "evidence", input: { id: "ep-28", userText: "Filter injected historical context.", agentText: "The extractor classified the trace as noise and skipped it.", reflection: "Prompt wrappers are not project evidence." } },
  { id: "ep-29", label: "evidence", input: { id: "ep-29", userText: "Replay the historical L1 set.", agentText: "The replay produced no project-synthesis records.", toolCalls: [{ name: "replay", output: "bad=0" }] } },
  { id: "ep-30", label: "evidence", input: { id: "ep-30", userText: "Persist evidence anchors on every skill.", agentText: "The generated skill references three source trace IDs.", reflection: "The provenance chain is inspectable." } }
];
