import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { createMemmyConfigWriter } from "../infrastructure/memmy-config/index.js";
import { createPluginModelInferenceService } from "../services/plugin-model-inference-service.js";

const pluginRoot = resolve(process.env.LITERATURE_REVIEW_PLUGIN_ROOT ?? join(process.cwd(), "..", "Literature-Review-Plugin"));
const configPath = resolve(process.env.MEMMY_CONFIG ?? join(homedir(), ".memmy", "config.yaml"));
const liveEnabled = process.env.LITERATURE_REVIEW_LIVE_MODEL === "1"
  && existsSync(configPath)
  && existsSync(join(pluginRoot, "dist/src/algorithms/model-outline.js"));

describe.skipIf(!liveEnabled)("Literature Review Plugin with the current Memmy user model", () => {
  it("generates an outline, resumes section batches, and performs a bounded continuity rewrite", async () => {
    const writer = createMemmyConfigWriter({ configPath });
    const safeConfigContext = YAML.parse(readFileSync(configPath, "utf8")) as { app?: { userId?: string }; modelAssignments?: { account?: { agent?: { default?: string } }; byok?: { agent?: { default?: string } } } };
    const preferredMode = safeConfigContext.modelAssignments?.account?.agent?.default ? "account" : "byok";
    const activeAccountId = preferredMode === "account" ? safeConfigContext.app?.userId ?? null : null;
    const resolution = await writer.resolveAssignedModel?.({ mode: preferredMode, activeAccountId, capability: "agent" });
    if (!resolution?.ok) throw new Error(`Current Memmy agent model could not be resolved: ${resolution?.reason ?? "unknown"}`);
    const mode = preferredMode;

    const service = createPluginModelInferenceService({ resolveModel: async () => resolution, timeoutMs: 180_000 });
    const calls: Array<Record<string, unknown>> = [];
    const modelClient = async (input: Record<string, unknown>) => {
      const started = Date.now();
      try {
        const output = await service.invoke({
          pluginId: "literature-review",
          callId: `live-model-${calls.length + 1}`,
          conversationId: "literature-review-live-model",
          service: "model-inference",
          input,
          deadline: new Date(Date.now() + 180_000).toISOString()
        }) as { content: string; finishReason: string; usage: Record<string, number>; model: { provider: string; model: string } };
        calls.push({
          operation: classifyOperation(input),
          durationMs: Date.now() - started,
          inputCharacters: inputCharacters(input),
          outputCharacters: output.content.length,
          finishReason: output.finishReason,
          usage: output.usage,
          model: output.model
        });
        return output;
      } catch (error) {
        calls.push({
          operation: classifyOperation(input),
          durationMs: Date.now() - started,
          inputCharacters: inputCharacters(input),
          failed: true,
          code: error instanceof Error && "code" in error ? (error as Error & { code?: string }).code : undefined,
          message: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
    };

    const outlineModule = await import(pathToFileURL(join(pluginRoot, "dist/src/algorithms/model-outline.js")).href) as {
      generateOutlineWithModel(client: typeof modelClient, spec: Record<string, unknown>, keywords: unknown[], readings: unknown[]): Promise<{ outline: Array<Record<string, unknown>> }>;
    };
    const writingModule = await import(pathToFileURL(join(pluginRoot, "dist/src/algorithms/model-writing.js")).href) as {
      generateSectionsInBatches(client: typeof modelClient, spec: Record<string, unknown>, outline: unknown[], drafts: unknown[], evidence: unknown[], options: Record<string, unknown>): Promise<{ sections: Array<Record<string, unknown>>; batches: Array<Record<string, unknown>> }>;
      ensureParagraphBlocks(section: Record<string, unknown>, evidence: unknown[]): Record<string, unknown>;
      refineSectionsWithModel(client: typeof modelClient, spec: Record<string, unknown>, outline: unknown[], sections: unknown[], evidence: unknown[], targetIds: string[], batchSize: number, options: Record<string, unknown>): Promise<{ sections: Array<Record<string, unknown>>; batches: Array<Record<string, unknown>>; changedIds: string[]; validationPassed: boolean; citationsChanged: boolean }>;
    };

    const spec = {
      taskId: "live-model-check",
      title: "Persistent memory in language-model agents",
      topic: "How retrieval and update policies affect grounded long-horizon agent memory",
      researchQuestions: [
        "How does retrieval quality affect grounded responses?",
        "How do update policies reduce stale-memory conflicts?"
      ],
      outputLanguage: "en",
      citationStyle: "apa",
      onlineSearch: false,
      outputFormats: ["pdf"]
    };
    const keywords = [
      { id: "kw-1", term: "agent memory", normalizedTerm: "agent memory", aliases: [], weight: 10, selected: true, source: "spec" },
      { id: "kw-2", term: "retrieval quality", normalizedTerm: "retrieval quality", aliases: [], weight: 9, selected: true, source: "spec" },
      { id: "kw-3", term: "memory update", normalizedTerm: "memory update", aliases: [], weight: 8, selected: true, source: "spec" }
    ];
    const readings = [
      { id: "reading-1", paperId: "paper-1", summary: "A controlled benchmark links retrieval precision to grounded answers.", chunkIds: ["chunk-1"], evidenceIds: ["evidence-1"], evidenceLevel: "full-text", writingPermission: "factual-writing", claims: ["Higher retrieval precision reduces unsupported answers."], methods: ["controlled benchmark"], results: ["Unsupported answers decreased with retrieval precision."], limitations: ["One benchmark domain."], confidence: 0.9, qualityFlags: [] },
      { id: "reading-2", paperId: "paper-2", summary: "A longitudinal study evaluates versioned memory replacement.", chunkIds: ["chunk-2"], evidenceIds: ["evidence-2"], evidenceLevel: "full-text", writingPermission: "factual-writing", claims: ["Versioned replacement reduces stale-memory conflicts."], methods: ["longitudinal evaluation"], results: ["Contradictions decreased after versioned replacement."], limitations: ["Limited task families."], confidence: 0.88, qualityFlags: [] }
    ];
    const liveOutline = await outlineModule.generateOutlineWithModel(modelClient, spec, keywords, readings);

    const writingOutline = [
      { id: "outline-1", title: "Evidence synthesis", guidance: "Compare retrieval and update mechanisms.", order: 1, evidenceIds: [], children: [
        { id: "outline-1-1", title: "Retrieval quality", guidance: "Synthesize evidence about retrieval precision and grounded answers.", order: 1, evidenceIds: ["evidence-1"], children: [] },
        { id: "outline-1-2", title: "Memory updates", guidance: "Synthesize evidence about stale conflicts and versioned replacement.", order: 2, evidenceIds: ["evidence-2"], children: [] }
      ] }
    ];
    const evidence = [
      evidenceUnit("evidence-1", "paper-1", "Chen2024", "Higher retrieval precision reduced unsupported answers in a controlled benchmark."),
      evidenceUnit("evidence-2", "paper-2", "Rao2025", "Versioned replacement reduced stale-memory contradictions in a longitudinal evaluation.")
    ];
    const drafts = [
      sectionDraft("section-1", "outline-1-1", "evidence-1", "Chen2024"),
      sectionDraft("section-2", "outline-1-2", "evidence-2", "Rao2025")
    ];

    const firstBatch = await writingModule.generateSectionsInBatches(modelClient, spec, writingOutline, drafts.slice(0, 1), evidence, { batchSize: 1, attempt: 1 });
    const resumedBatch = await writingModule.generateSectionsInBatches(modelClient, spec, writingOutline, drafts.slice(1), evidence, { batchSize: 1, attempt: 2, existingSections: firstBatch.sections });
    const sections = [...firstBatch.sections, ...resumedBatch.sections];
    const hydrated = sections.map((section) => writingModule.ensureParagraphBlocks(section, evidence));
    const firstParagraph = (hydrated[0]?.paragraphs as Array<{ id: string }> | undefined)?.[0];
    if (!firstParagraph) throw new Error("Live model generation did not produce a target paragraph");
    const refinement = await writingModule.refineSectionsWithModel(modelClient, spec, writingOutline, hydrated, evidence, [], 1, {
      target: { type: "paragraph", id: firstParagraph.id },
      instruction: "Improve the transition and clarity without changing any factual claim or citation.",
      continuityScope: "adjacent"
    });

    const report = {
      generatedAt: new Date().toISOString(),
      result: "completed",
      currentModel: { provider: resolution.context.provider, model: resolution.context.model, mode },
      outline: { topLevelSections: liveOutline.outline.length, schemaValid: liveOutline.outline.length >= 2 },
      sectionGeneration: {
        firstRun: firstBatch.batches.map(batchSummary),
        resumedRun: resumedBatch.batches.map(batchSummary),
        citationsPreserved: sections.every((section) => (section.citeKeys as string[]).every((key) => String(section.markdown).includes(`[${key}]`)))
      },
      refinement: {
        batches: refinement.batches.map(batchSummary),
        validationPassed: refinement.validationPassed,
        citationsChanged: refinement.citationsChanged,
        changedIds: refinement.changedIds
      },
      calls,
      totalDurationMs: calls.reduce((sum, call) => sum + Number(call.durationMs ?? 0), 0),
      totalTokens: calls.reduce((sum, call) => sum + Number((call.usage as Record<string, number> | undefined)?.totalTokens ?? 0), 0)
    };
    writeReport(report);

    expect(liveOutline.outline.length).toBeGreaterThanOrEqual(2);
    expect(firstBatch.batches.every((batch) => batch.status === "completed")).toBe(true);
    expect(resumedBatch.batches.every((batch) => batch.status === "completed")).toBe(true);
    expect(report.sectionGeneration.citationsPreserved).toBe(true);
    expect(refinement.validationPassed).toBe(true);
    expect(refinement.citationsChanged).toBe(false);
    expect(calls.length).toBeGreaterThanOrEqual(5);
  }, 600_000);
});

function evidenceUnit(id: string, paperId: string, citeKey: string, statement: string) {
  return {
    id, paperId, locator: { chunkId: `${id}-chunk`, pageFrom: 1, pageTo: 1, paragraphFrom: 1, paragraphTo: 1 },
    summary: statement, claims: [statement], statements: [{ type: "result", text: statement, sentenceIndex: 1, confidence: 0.9 }],
    supportingTextHash: `sha256:${id}`, citeKey, evidenceLevel: "full-text", confidence: 0.9,
    quality: { score: 0.9, sourceTextQuality: 0.9, locatorCompleteness: 1, statementCoverage: 1, flags: [] },
    conflict: { status: "none", withEvidenceIds: [] }
  };
}

function sectionDraft(id: string, outlineNodeId: string, evidenceId: string, citeKey: string) {
  return { id, outlineNodeId, markdown: `Evidence is available [${citeKey}].`, paragraphs: [], evidenceIds: [evidenceId], citeKeys: [citeKey], status: "drafted" };
}

function classifyOperation(input: Record<string, unknown>): string {
  const messages = Array.isArray(input.messages) ? input.messages as Array<{ content?: unknown }> : [];
  const system = String(messages[0]?.content ?? "");
  if (system.includes("design evidence-oriented")) return "outline";
  if (system.includes("write evidence-grounded")) return "section-generation";
  if (system.includes("rewrite exactly one paragraph")) return "paragraph-rewrite";
  if (system.includes("check local paragraph continuity")) return "continuity-check";
  return "unknown";
}

function inputCharacters(input: Record<string, unknown>): number {
  return (Array.isArray(input.messages) ? input.messages : []).reduce((sum: number, raw) => sum + String((raw as { content?: unknown }).content ?? "").length, 0);
}

function batchSummary(batch: Record<string, unknown>) {
  return { status: batch.status, attempt: batch.attempt, outlineNodeIds: batch.outlineNodeIds, issues: batch.issues, error: batch.error };
}

function writeReport(report: Record<string, unknown>): void {
  const output = resolve(process.env.LITERATURE_REVIEW_LIVE_MODEL_REPORT ?? join(process.cwd(), "artifacts", "literature-review-live-model-report.json"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
