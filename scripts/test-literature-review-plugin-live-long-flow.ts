import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { createMemmyConfigWriter } from "../App/backend/src/infrastructure/memmy-config/index.js";
import { createPluginModelInferenceService } from "../App/backend/src/services/plugin-model-inference-service.js";
import { executeReviewTool } from "../../Literature-Review-Plugin/src/runtime/engine.js";
import { TaskRepository } from "../../Literature-Review-Plugin/src/task/index.js";
import { createBuiltInProviders } from "../../Literature-Review-Plugin/src/retrieval/index.js";

const pluginRoot = resolve(process.env.LITERATURE_REVIEW_PLUGIN_ROOT ?? join(process.cwd(), "..", "Literature-Review-Plugin"));
const configPath = resolve(process.env.MEMMY_CONFIG ?? join(homedir(), ".memmy", "config.yaml"));
const runRoot = resolve(process.env.LITERATURE_REVIEW_LIVE_LONG_ROOT ?? join(pluginRoot, "evals", "reports", `live-long-flow-${Date.now()}`));
const resumeTaskId = process.env.LITERATURE_REVIEW_LIVE_LONG_RESUME_TASK_ID?.trim() ?? "";
const taskDataRoot = resolve(process.env.LITERATURE_REVIEW_LIVE_LONG_TASK_DATA_ROOT ?? join(runRoot, "task-data"));
await mkdir(runRoot, { recursive: true });
const safeConfig = YAML.parse(await readFile(configPath, "utf8")) as { app?: { userId?: string }; modelAssignments?: { account?: { agent?: { default?: string } } } };
const writer = createMemmyConfigWriter({ configPath });
const mode = safeConfig.modelAssignments?.account?.agent?.default ? "account" : "byok";
const resolution = await writer.resolveAssignedModel?.({ mode, activeAccountId: mode === "account" ? safeConfig.app?.userId ?? null : null, capability: "agent" });
if (!resolution?.ok) throw new Error(`Current Memmy model unavailable: ${resolution?.reason ?? "unknown"}`);
const inferenceTimeoutMs = Number(process.env.LITERATURE_REVIEW_LIVE_LONG_MODEL_TIMEOUT_MS ?? 300_000);
const inference = createPluginModelInferenceService({
  resolveModel: async () => resolution,
  timeoutMs: inferenceTimeoutMs,
  maxAttempts: 4,
  retryBaseDelayMs: Number(process.env.LITERATURE_REVIEW_LIVE_LONG_RETRY_DELAY_MS ?? 5_000)
});
const modelCalls: Array<Record<string, unknown>> = [];
const modelInference = async (input: Record<string, unknown>) => {
  const started = Date.now();
  try {
    const result = await inference.invoke({ pluginId: "literature-review", callId: `long-model-${modelCalls.length + 1}`, conversationId: "live-long-flow", service: "model-inference", input, deadline: new Date(Date.now() + inferenceTimeoutMs).toISOString() }) as Record<string, unknown>;
    await writeFile(join(runRoot, `model-call-${modelCalls.length + 1}.txt`), String(result.content ?? ""), "utf8");
    modelCalls.push({ ok: true, durationMs: Date.now() - started, usage: result.usage, model: result.model });
    return result as never;
  } catch (error) {
    modelCalls.push({ ok: false, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
};
const repository = new TaskRepository(taskDataRoot);
const providers = createBuiltInProviders(fetch, { contactEmail: process.env.MEMMY_PLUGIN_CONTACT_EMAIL, ncbiApiKey: process.env.NCBI_API_KEY });
const trace: Array<Record<string, unknown>> = [];
let taskId = resumeTaskId;
let sequence = 0;
const run = async (tool: Parameters<typeof executeReviewTool>[0], input: Record<string, unknown>) => {
  const started = Date.now();
  const result = await executeReviewTool(tool, input, `live-long-${++sequence}`, { repository, providers, fetcher: fetch, modelInference });
  trace.push({ tool, ok: result.ok, durationMs: Date.now() - started, summary: result.summary, warnings: result.warnings, missingInputs: result.missingInputs });
  if (!result.ok) throw new Error(`${tool}: ${result.summary}`);
  return result;
};
const refineAllSections = async (targetTaskId: string) => {
  const snapshot = await repository.load(targetTaskId);
  const outlineNodeIds = ((snapshot?.values.sections as Array<{ outlineNodeId?: string }> | undefined) ?? [])
    .map((section) => section.outlineNodeId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const startIndex = Math.max(0, Number(process.env.LITERATURE_REVIEW_LIVE_LONG_REFINE_START_INDEX ?? 0));
  for (const outlineNodeId of outlineNodeIds.slice(startIndex)) {
    let refinementMode = "";
    for (let attempt = 0; attempt < 2 && refinementMode !== "host-model"; attempt += 1) {
      const refined = await run("review_refine", {
        taskId: targetTaskId,
        targetIds: [outlineNodeId],
        instruction: "Improve cross-section continuity without changing evidence or citations.",
        continuityScope: "adjacent",
        batchSize: 1
      });
      refinementMode = (refined.data as { refinement?: { mode?: string } }).refinement?.mode ?? "";
    }
    if (refinementMode !== "host-model") throw new Error(`Continuity refinement still contains fallback for ${outlineNodeId}: ${refinementMode}`);
  }
};

let failure: unknown;
try {
  if (resumeTaskId) {
    const task = await repository.load(resumeTaskId);
    if (!task) throw new Error(`Resume task does not exist: ${resumeTaskId}`);
    let sectionMode = ((task.values.sectionGeneration as { mode?: string } | undefined)?.mode) ?? "";
    for (let attempt = 0; attempt < 3 && sectionMode !== "host-model"; attempt += 1) {
      const sections = await run("review_generate_sections", { taskId: resumeTaskId, batchSize: 2 });
      sectionMode = (sections.data as { generation?: { mode?: string } }).generation?.mode ?? "";
    }
    if (sectionMode !== "host-model") throw new Error(`Section generation still contains fallback batches after retries: ${sectionMode}`);
    await refineAllSections(resumeTaskId);
    await run("review_plan_figures", { taskId: resumeTaskId });
    await run("review_build_tables", { taskId: resumeTaskId });
    await run("review_build_bibliography", { taskId: resumeTaskId });
    const audit = await run("review_audit", { taskId: resumeTaskId });
    const abstractSuggestion = audit.suggestedNextTools.find((item) => item.toolName === "review_generate_abstract");
    if (!abstractSuggestion) throw new Error("Audit did not permit abstract generation");
    await run("review_generate_abstract", abstractSuggestion.args);
    await run("review_render", { taskId: resumeTaskId, formats: ["md", "bib", "pdf", "tex", "docx"] });
  } else {
  const created = await run("review_create_task", { title: "Retrieval-Augmented Generation for Language Models", topic: "Evidence, methods, limitations, and recent progress in retrieval-augmented generation", spec: { researchQuestions: ["How does retrieval augmentation improve grounded generation, and what limitations remain?"], dateRange: { from: 2023, to: 2025 }, outputLanguage: "en", citationStyle: "apa", renderMode: "neurips-2024", onlineSearch: true, outputFormats: ["pdf", "tex", "docx"] } });
  taskId = created.taskId;
  const keywords = await run("review_generate_keywords", { taskId });
  await run("review_update_keywords", { taskId, keywords: (keywords.data as { keywords: unknown[] }).keywords });
  const searched = await run("review_search_papers", { taskId, query: "retrieval augmented generation large language models", providers: ["arxiv", "pubmed", "openalex", "crossref"], limit: 20 });
  const searchData = searched.data as { candidates: Array<{ id: string; providerId?: string; availability?: string }>; recommendedPaperIds?: string[] };
  const candidates = searchData.candidates;
  const recommendedIds = new Set(searchData.recommendedPaperIds ?? []);
  // The candidates are already federated, deduplicated, and relevance-ranked by
  // the plugin. Select a realistic review corpus instead of the old smoke-only
  // shortcut that kept two arXiv records merely because they were downloadable.
  const selected = [
    ...candidates.filter((paper) => recommendedIds.has(paper.id) && paper.availability === "full-text"),
    ...candidates.filter((paper) => !recommendedIds.has(paper.id) && paper.availability === "full-text"),
    ...candidates.filter((paper) => recommendedIds.has(paper.id) && paper.availability !== "full-text"),
    ...candidates.filter((paper) => !recommendedIds.has(paper.id) && paper.availability !== "full-text")
  ].slice(0, 12);
  if (selected.length < 8) throw new Error(`Popular-topic search returned only ${selected.length} selectable candidates`);
  await run("review_update_paper_selection", { taskId, includedPaperIds: selected.map((paper) => paper.id), excludedPaperIds: candidates.filter((paper) => !selected.includes(paper)).map((paper) => paper.id) });
  await run("review_resolve_metadata", { taskId });
  await run("review_fetch_fulltexts", { taskId });
  await run("review_build_readings", { taskId });
  const outline = await run("review_generate_outline", { taskId });
  await run("review_update_outline", { taskId, outline: (outline.data as { outline: unknown[] }).outline });
  await run("review_map_evidence", { taskId });
  let sectionMode = "";
  for (let attempt = 0; attempt < 3 && sectionMode !== "host-model"; attempt += 1) {
    const sections = await run("review_generate_sections", { taskId, batchSize: 2 });
    sectionMode = (sections.data as { generation?: { mode?: string } }).generation?.mode ?? "";
  }
  if (sectionMode !== "host-model") throw new Error(`Section generation still contains fallback batches after retries: ${sectionMode}`);
  await refineAllSections(taskId);
  await run("review_plan_figures", { taskId });
  await run("review_build_tables", { taskId });
  await run("review_build_bibliography", { taskId });
  const audit = await run("review_audit", { taskId });
  const abstractSuggestion = audit.suggestedNextTools.find((item) => item.toolName === "review_generate_abstract");
  if (!abstractSuggestion) throw new Error("Audit did not permit abstract generation");
  await run("review_generate_abstract", abstractSuggestion.args);
  await run("review_render", { taskId, formats: ["md", "bib", "pdf", "tex", "docx"] });
  }
} catch (error) {
  failure = error;
}
const task = taskId ? await repository.load(taskId) : null;
const outputs = (task?.values.outputs as Array<{ format: string; path: string; name: string; generation?: { renderer?: string; fallback?: boolean } }> | undefined) ?? [];
const qualityChecks = {
  xelatex: outputs.some((output) => output.format === "pdf" && output.generation?.renderer === "xelatex" && output.generation.fallback === false),
  neuripsTemplate: false,
  citationCommands: false,
  bibliographyEntries: ((task?.values.bibliography as unknown[] | undefined) ?? []).length,
  figures: ((task?.values.figureBlocks as unknown[] | undefined) ?? []).length,
  tables: ((task?.values.tableBlocks as unknown[] | undefined) ?? []).length,
  sections: ((task?.values.sections as unknown[] | undefined) ?? []).length
};
if (!failure) {
  const tex = outputs.find((output) => output.name === "review.tex");
  if (!tex) failure = new Error("Quality delivery did not produce review.tex");
  else {
    const source = await readFile(tex.path, "utf8");
    qualityChecks.neuripsTemplate = source.includes("\\usepackage[preprint]{neurips_2024}");
    qualityChecks.citationCommands = source.includes("\\cite{") && source.includes("\\begin{thebibliography}{99}");
  }
  if (!qualityChecks.xelatex) failure = new Error("Quality delivery used PDFKit fallback instead of XeLaTeX");
  else if (!qualityChecks.neuripsTemplate) failure = new Error("Quality delivery did not load the NeurIPS 2024 template");
  else if (!qualityChecks.citationCommands) failure = new Error("Quality delivery did not render LaTeX citations and bibliography");
}
const deliveryRoot = join(runRoot, "delivery");
if (!failure) {
  for (const output of outputs) {
    const destination = join(deliveryRoot, output.name);
    await mkdir(resolve(destination, ".."), { recursive: true });
    await copyFile(output.path, destination);
  }
}
const report = { generatedAt: new Date().toISOString(), result: failure ? "failed" : "passed", failure: failure instanceof Error ? failure.message : failure, model: { provider: resolution.context.provider, model: resolution.context.model }, taskId, searchCandidates: (task?.values.searchResults as unknown[] | undefined)?.length ?? 0, searchDiagnostics: task?.values.searchDiagnostics ?? [], selectedPapers: (task?.values.selectedPaperIds as unknown[] | undefined)?.length ?? 0, parsedDocuments: (task?.values.parsedDocuments as unknown[] | undefined)?.length ?? 0, evidenceUnits: (task?.values.evidenceUnits as unknown[] | undefined)?.length ?? 0, outputs, deliveryRoot, qualityChecks, trace, modelCalls, totalModelTokens: modelCalls.reduce((sum, call) => sum + Number((call.usage as { totalTokens?: number } | undefined)?.totalTokens ?? 0), 0) };
await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`Live long-flow report: ${join(runRoot, "report.json")}`);
if (failure) throw failure;
