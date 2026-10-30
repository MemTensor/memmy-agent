import { canonicalJson, type JsonValue } from "../../contracts/index.js";
import { createMemoryLogger } from "../../logging/logger.js";
import { languageSteeringLine, steeredPromptLanguage, traceMetaFromMemory } from "../../algorithm/plugin-algorithms.js";
import type { MemoryLanguage } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import { l3UnitKey } from "../../storage/l3-field-repository.js";
import type { EvolutionJobRecord, Repositories } from "../../storage/repositories.js";
import { nowIso } from "../../utils/time.js";
import { evolutionJobLogFields, logEvolutionDecision } from "../evolution/evolution-logging.js";
import { L3WorldModelTerminalEvidenceError } from "../evolution/l3-world-model-pipeline.js";
import { storedGeneratedTitle } from "../read-model/display-fields.js";
import { completeStrictJson } from "../l3-world-model/strict-json-completion.js";
import { classifyProcessingError } from "../worker/job-handlers.js";
import { buildEvidenceFragments } from "./evidence-fragments.js";
import { resolveProject } from "./project-resolver.js";
import { resolverContextFor, sessionWorkingDirectory, type L3FieldEnvironment } from "./session-units.js";
import { countL3Units } from "./text-units.js";
import type { EvidenceFragment, L3ItemKind, L3ItemRecord, L3UnitBatchRecord, L3UnitRecord, ResolvedProject } from "./types.js";
import { L3_UNIT_UPDATE_PROMPT, L3_UNIT_UPDATE_SCHEMA, l3UnitRetryNote } from "./unit-update-prompt.js";
import { parseL3UnitOutput, validateL3UnitOps, type L3UnitOp, type L3UpdateGroup } from "./unit-ops.js";

/** The evidence's turn and L1 still exist (neither deleted nor redacted since the input was built). */
function evidenceStillThere(repos: Repositories, fragment: EvidenceFragment): boolean {
  const rawTurn = repos.runtime.getRawTurn(fragment.rawTurnId);
  const memory = repos.memories.get(fragment.l1MemoryId);
  return Boolean(rawTurn && !rawTurn.deletedAt && !rawTurn.redactedAt &&
    memory && !memory.deletedAt && memory.status !== "deleted");
}

/** The run lost its job's lease to a newer run; it must leave the job and the batch alone. */
export class L3LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`l3 unit job ${jobId} was leased again; this run's result is dropped`);
    this.name = "L3LeaseLostError";
  }
}

interface PendingMachineItem {
  id: string;
  kind: L3ItemKind;
  content: string;
}

const l3FieldLogger = createMemoryLogger("l3-field");
const MAX_INPUT_CHARS = 65_536;
/** After the model rejects an input as too long for its context, the group is asked once more with this much. */
const FALLBACK_INPUT_CHARS = 16_384;
/** The output is a short list of ops; a smaller budget leaves room for the input in the context window. */
const MAX_OUTPUT_TOKENS = 16_384;
const MAX_USER_PROJECTS = 50;
const MAX_ITEMS_PER_KIND = 10;
const OVER_LENGTH_UNITS = 150;
const L1_SUMMARY_CHARS = 600;

/**
 * Turns one frozen batch into item operations. Each group (the machine plus at most one project)
 * gets one model call; nothing is written until every group has a valid answer, and then the
 * whole batch is written in one transaction.
 */
export class L3UnitUpdatePipeline {
  constructor(private readonly deps: {
    repos: Repositories;
    llm: LlmClient;
    language?: MemoryLanguage;
    environment: () => L3FieldEnvironment;
  }) {}

  async process(job: EvolutionJobRecord): Promise<void> {
    const batchId = typeof job.payload.batchId === "string" ? job.payload.batchId : "";
    const batch = this.deps.repos.l3Field.getBatch(batchId);
    if (!batch) throw new L3WorldModelTerminalEvidenceError(`missing l3 unit batch: ${batchId}`);
    // A job recovered after a restart may run again for a batch that was already written.
    if (batch.status === "applied") return;
    if (
      batch.status !== "queued" ||
      job.userId !== batch.userId ||
      job.sessionId !== batch.sessionId ||
      job.scopeKey !== batch.machineUnitKey ||
      job.scopeSeq !== batch.scopeSeq
    ) {
      throw new L3WorldModelTerminalEvidenceError("l3 unit job does not match its batch");
    }
    const machine = this.deps.repos.l3Field.getUnit(batch.machineUnitKey);
    const session = this.deps.repos.runtime.getSession(batch.sessionId);
    if (!machine || !session || session.userId !== batch.userId) {
      throw new L3WorldModelTerminalEvidenceError("l3 unit batch scope mismatch");
    }

    const groups = this.buildGroups(batch, machine, session);
    const decided: Array<{ group: L3UpdateGroup; ops: L3UnitOp[] }> = [];
    // Machine items earlier groups of this batch decided to write; later groups see them so they
    // do not write the same fact again in their own words.
    const addedToMachine: PendingMachineItem[] = [];
    for (const group of groups) {
      const ops = await this.decide(job, group, addedToMachine);
      decided.push({ group, ops });
      for (const op of ops) {
        if ((op.op === "add" || op.op === "replace") && op.unitKey === group.machine.unitKey) {
          addedToMachine.push({ id: `added-in-batch-${addedToMachine.length + 1}`, kind: op.kind, content: op.content });
        }
      }
    }
    this.apply(job, batch, decided);
  }

  private buildGroups(
    batch: L3UnitBatchRecord,
    machine: L3UnitRecord,
    session: NonNullable<ReturnType<Repositories["runtime"]["getSession"]>>
  ): L3UpdateGroup[] {
    const repos = this.deps.repos;
    const env = { ...this.deps.environment(), machineId: machine.machineId };
    const { cwd, isLocal } = sessionWorkingDirectory(session);
    const ctx = resolverContextFor(repos, env, batch.userId, isLocal);
    const sessionProject = cwd
      ? resolveProject({ path: cwd, role: "session_dir", sessionCwd: cwd, sessionProjectRoot: null }, ctx)
      : null;
    const projects = new Map<string, ResolvedProject>();
    const unitKeyOf = (project: ResolvedProject) => {
      const key = l3UnitKey({ userId: batch.userId, machineId: machine.machineId, kind: "project", identity: project.identity });
      if (!projects.has(key)) projects.set(key, project);
      return key;
    };

    const traces = repos.l3WorldModels.listInputTracesInRange(batch.sessionId, batch.startTraceSeq - 1, batch.endTraceSeq);
    const l1ByRawTurn = new Map<string, string>();
    for (const trace of traces) {
      if (!batch.l1MemoryIds.includes(trace.l1MemoryId) || l1ByRawTurn.has(trace.rawTurnId)) continue;
      const memory = repos.memories.get(trace.l1MemoryId);
      if (memory && !memory.deletedAt && memory.status !== "deleted") l1ByRawTurn.set(trace.rawTurnId, memory.id);
    }

    const fragments: EvidenceFragment[] = [];
    for (const rawTurnId of batch.rawTurnIds) {
      const rawTurn = repos.runtime.getRawTurn(rawTurnId);
      const l1MemoryId = l1ByRawTurn.get(rawTurnId);
      if (!rawTurn || !l1MemoryId || rawTurn.deletedAt || rawTurn.redactedAt) continue;
      if (rawTurn.userId !== batch.userId || rawTurn.sessionId !== batch.sessionId) {
        throw new L3WorldModelTerminalEvidenceError(`raw turn scope mismatch: ${rawTurnId}`);
      }
      fragments.push(...buildEvidenceFragments({
        rawTurn,
        l1MemoryId,
        sessionCwd: cwd,
        sessionProjectRoot: sessionProject?.checkoutRoot ?? null,
        resolve: (target, role) => resolveProject({
          path: target,
          role,
          sessionCwd: cwd,
          sessionProjectRoot: sessionProject?.checkoutRoot ?? null
        }, ctx),
        unitKeyOf
      }));
    }

    const l1Entries = new Map([...new Set(l1ByRawTurn.values())].map((id) => {
      const memory = repos.memories.get(id)!;
      const summary = traceMetaFromMemory(memory)?.summary || memory.memoryValue;
      return [id, {
        id,
        title: storedGeneratedTitle(memory) ?? "",
        summary: [...summary].slice(0, L1_SUMMARY_CHARS).join(""),
        at: memory.createdAt
      }] as const;
    }));
    const groupOf = (picked: EvidenceFragment[], project: L3UnitRecord | null): L3UpdateGroup => ({
      machine,
      project,
      fragments: picked,
      l1: [...new Set(picked.map((fragment) => fragment.l1MemoryId))].map((id) => l1Entries.get(id)!)
    });

    const groups: L3UpdateGroup[] = [];
    for (const [unitKey, resolved] of projects) {
      const picked = fragments.filter((fragment) => fragment.candidateUnitKeys.includes(unitKey));
      if (picked.length === 0) continue;
      const unit = repos.l3Field.ensureProjectUnit({ userId: batch.userId, machineId: machine.machineId, project: resolved });
      groups.push(groupOf(picked, unit));
    }
    const machineOnly = fragments.filter((fragment) => fragment.candidateUnitKeys.length === 0);
    if (machineOnly.length > 0) groups.push(groupOf(machineOnly, null));
    return groups;
  }

  private async decide(
    job: EvolutionJobRecord,
    group: L3UpdateGroup,
    addedToMachine: readonly PendingMachineItem[]
  ): Promise<L3UnitOp[]> {
    const repos = this.deps.repos;
    const machineItems = repos.l3Field.activeItems(group.machine.unitKey);
    // Removed on evidence newer than some of this group's: a batch processed late (rerun from dead
    // letter, history scanned late) or spanning a removal must not bring them back on older evidence.
    const oldestEvidenceAt = group.fragments.map((fragment) => fragment.at).sort()[0];
    const removedLater = oldestEvidenceAt
      ? repos.l3Field.itemsRemovedAfter([group.machine.unitKey, ...(group.project ? [group.project.unitKey] : [])], oldestEvidenceAt)
      : [];
    const projectItems = group.project ? repos.l3Field.activeItems(group.project.unitKey) : [];
    const activeItems = new Map([...machineItems, ...projectItems].map((item) => [item.id, item]));
    let input = this.buildInput(job, group, machineItems, projectItems, addedToMachine, removedLater, MAX_INPUT_CHARS);
    const addedIds = new Set(addedToMachine.map((item) => item.id));
    const language = activeItems.size === 0
      ? steeredPromptLanguage(this.deps.language, group.fragments.filter((f) => !f.toolName).map((f) => f.output))
      : undefined;
    const systemPrompt = language ? `${L3_UNIT_UPDATE_PROMPT}\n\n${languageSteeringLine(language)}` : L3_UNIT_UPDATE_PROMPT;
    const ask = (dynamicInput: JsonValue) => completeStrictJson({
      llm: this.deps.llm,
      operation: "l3_field.unit_update",
      systemPrompt,
      dynamicInput,
      expectedSchema: L3_UNIT_UPDATE_SCHEMA as unknown as JsonValue,
      validate: parseL3UnitOutput,
      maxTokens: MAX_OUTPUT_TOKENS
    });

    let first;
    try {
      first = await ask(input);
    } catch (error) {
      // Resending the same input would fail the same way; shrink it once instead.
      if (classifyProcessingError(error).code !== "model_input_too_long") throw error;
      logEvolutionDecision(job, "l3_unit_update", "input_too_long_shrunk", { maxChars: FALLBACK_INPUT_CHARS });
      input = this.buildInput(job, group, machineItems, projectItems, addedToMachine, removedLater, FALLBACK_INPUT_CHARS);
      first = await ask(input);
    }
    const checked = validateL3UnitOps(first.ops, group, activeItems, addedIds);
    if (checked.problems.length === 0) return checked.ops;
    // Semantic problems get one regeneration with the reasons; a second failure fails the batch.
    const second = await ask({
      ...input,
      previous_output: first as unknown as JsonValue,
      retry: l3UnitRetryNote(checked.problems)
    });
    const rechecked = validateL3UnitOps(second.ops, group, activeItems, addedIds);
    if (rechecked.problems.length > 0) {
      throw new Error(`l3 unit output rejected twice: ${rechecked.problems.join("; ")}`);
    }
    return rechecked.ops;
  }

  private buildInput(
    job: EvolutionJobRecord,
    group: L3UpdateGroup,
    machineItems: readonly L3ItemRecord[],
    projectItems: readonly L3ItemRecord[],
    addedToMachine: readonly PendingMachineItem[],
    removedLater: readonly L3ItemRecord[],
    maxChars: number
  ): Record<string, JsonValue> {
    const repos = this.deps.repos;
    const session = repos.runtime.getSession(job.sessionId!)!;
    const { cwd } = sessionWorkingDirectory(session);
    const items = (list: readonly L3ItemRecord[]) => list.map((item) => ({
      id: item.id,
      kind: item.kind,
      content: item.content,
      last_confirmed_at: item.lastConfirmedAt
    }));
    const evidence = group.fragments.map((fragment) => ({
      id: fragment.id,
      type: fragment.toolName ? "tool" : "user_text",
      ...(fragment.toolName
        ? { tool: fragment.toolName, input: (fragment.input ?? null) as JsonValue, is_error: fragment.isError }
        : {}),
      ...(fragment.toolName ? { output: fragment.output } : { text: fragment.output }),
      paths: fragment.paths,
      candidate_units: ["machine", ...fragment.candidateUnitKeys],
      at: fragment.at
    }));
    const input: Record<string, JsonValue> = {
      batch_l1: group.l1,
      evidence,
      machine: {
        profile: group.machine.profileText ?? null,
        items: [
          ...items(machineItems),
          ...addedToMachine.map((item) => ({ id: item.id, kind: item.kind, content: item.content, added_in_this_batch: true }))
        ]
      },
      projects: group.project
        ? [{
            unit_key: group.project.unitKey,
            name: group.project.displayName ?? null,
            source: group.project.identitySource ?? null,
            root: group.project.checkoutRoot ?? null,
            profile: group.project.profileText ?? null,
            items: items(projectItems)
          }]
        : [],
      // Only when some of this group's evidence is older than a removal: what was removed, and when.
      ...(removedLater.length > 0
        ? { removed_by_newer_evidence: removedLater.map((item) => ({
            kind: item.kind, content: item.content, removed_at: item.removedEvidenceAt ?? null
          })) }
        : {}),
      session: { cwd, current_project: group.project?.displayName ?? null },
      user_selected_projects: repos.l3Field.listUserProjects(job.userId)
        .slice(0, MAX_USER_PROJECTS)
        .map((project) => ({ name: project.name, root: project.rootPath }))
    };
    // When the input is too long the oldest tool calls go first, the user's own words last;
    // L1, items and profiles are kept.
    const charsBefore = canonicalJson(input).length;
    const evidenceBefore = evidence.length;
    let droppedTool = 0;
    let droppedUserText = 0;
    while (canonicalJson(input).length > maxChars && evidence.length > 1) {
      const oldestTool = evidence.findIndex((fragment) => fragment.type === "tool");
      const [removed] = evidence.splice(oldestTool >= 0 ? oldestTool : 0, 1);
      if (removed?.type === "tool") droppedTool += 1;
      else droppedUserText += 1;
    }
    if (droppedTool + droppedUserText > 0) {
      l3FieldLogger.debug("input.truncated", {
        ...evolutionJobLogFields(job),
        unitKey: group.project?.unitKey ?? group.machine.unitKey,
        maxChars,
        charsBefore,
        charsAfter: canonicalJson(input).length,
        evidenceBefore,
        evidenceAfter: evidence.length,
        droppedToolFragments: droppedTool,
        droppedUserTextFragments: droppedUserText
      });
    }
    return input;
  }

  private apply(job: EvolutionJobRecord, batch: L3UnitBatchRecord, decided: Array<{ group: L3UpdateGroup; ops: L3UnitOp[] }>): void {
    const repos = this.deps.repos;
    // Two groups changing the same machine item: the first group's op wins.
    const claimedMachineIds = new Set<string>();
    const plan = decided.map(({ group, ops }) => ({
      group,
      ops: ops.filter((op) => {
        if (op.unitKey !== group.machine.unitKey || op.op === "add") return true;
        const ids = op.op === "replace" ? op.ids : [op.id];
        if (ids.some((id) => claimedMachineIds.has(id))) {
          logEvolutionDecision(job, "l3_unit_update", "machine_item_conflict_dropped", { ids });
          return false;
        }
        ids.forEach((id) => claimedMachineIds.add(id));
        return true;
      })
    }));

    repos.transaction(() => {
      // A run that outlived its lease (the job was leased again since) writes nothing.
      if (job.leaseToken && !repos.runtime.isJobLeaseHeld(job)) throw new L3LeaseLostError(job.id);
      const status = repos.l3Field.getBatch(batch.id)?.status;
      if (status === "applied") return;
      // A run that outlived its lease can come back after a newer run of the same job dead-lettered
      // the batch, and later batches may have changed the items since: its result is dropped (nothing
      // is written) and the batch waits in dead letter for its rerun.
      if (status !== "queued") throw new L3WorldModelTerminalEvidenceError(`l3 unit batch is ${status ?? "missing"}; result dropped`);
      const at = nowIso();
      const touched = new Set<string>();
      for (const { group, ops } of plan) {
        const fragments = new Map(group.fragments.map((fragment) => [fragment.id, fragment]));
        for (const op of ops) {
          const unit = repos.l3Field.getUnit(op.unitKey);
          if (!unit) continue;
          const cited = op.evidence.map((id) => fragments.get(id)!);
          // The user may have deleted a turn or its L1 while the model was answering: an op that
          // cites it is dropped, as it would have been had the deletion come before.
          if (cited.some((fragment) => !evidenceStillThere(repos, fragment))) {
            logEvolutionDecision(job, "l3_unit_update", "deleted_evidence_op_dropped", { op: op.op });
            continue;
          }
          const evidenceAt = cited.map((fragment) => fragment.at).sort().at(-1) ?? at;
          // A unit reset must not be refilled by what was said before the reset, even when that
          // conversation is frozen later (a task closed late, or a batch rerun from dead letter).
          if (unit.deletedAt && (batch.createdAt <= unit.deletedAt || evidenceAt <= unit.deletedAt)) continue;
          // Older evidence must not overturn an item that newer evidence wrote or confirmed (a batch
          // rerun from dead letter is applied after the batches that came after it), and an item
          // already gone is not changed again.
          if (op.op === "replace" || op.op === "delete") {
            const targets = (op.op === "replace" ? op.ids : [op.id]).map((id) => repos.l3Field.getItem(id));
            if (targets.some((item) => !item || item.status !== "active" || item.lastConfirmedAt > evidenceAt)) {
              logEvolutionDecision(job, "l3_unit_update", "stale_op_dropped", { op: op.op, evidenceAt });
              continue;
            }
          }
          const evidence = {
            fragmentIds: op.evidence,
            l1MemoryIds: [...new Set(cited.map((fragment) => fragment.l1MemoryId))]
          };
          if (op.op === "confirm") {
            repos.l3Field.confirmItem(op.id, evidenceAt, at);
          } else if (op.op === "delete") {
            repos.l3Field.inactivateItem(op.id, { removedEvidenceAt: evidenceAt, at });
          } else {
            const created = repos.l3Field.insertItem({
              unitKey: op.unitKey, kind: op.kind, content: op.content, evidence, evidenceAt, batchId: batch.id, at
            });
            if (op.op === "replace") {
              for (const id of op.ids) repos.l3Field.inactivateItem(id, { replacedBy: created.id, removedEvidenceAt: evidenceAt, at });
            }
            if (countL3Units(op.content) > OVER_LENGTH_UNITS) {
              logEvolutionDecision(job, "l3_unit_update", "item_over_length", { itemId: created.id });
            }
          }
          touched.add(op.unitKey);
        }
      }
      for (const unitKey of touched) this.enforceLimit(job, unitKey, at);
      repos.l3Field.setBatchStatus(batch.id, "applied", at);
      // Refreshing the machine also refreshes every project snapshot on it.
      if (touched.has(batch.machineUnitKey)) repos.l3Field.refreshSnapshot(batch.machineUnitKey, at);
      for (const unitKey of touched) {
        if (unitKey !== batch.machineUnitKey) repos.l3Field.refreshSnapshot(unitKey, at);
      }
    });
  }

  /** Over the limit, the items confirmed longest ago go first. */
  private enforceLimit(job: EvolutionJobRecord, unitKey: string, at: string): void {
    const items = this.deps.repos.l3Field.activeItems(unitKey);
    for (const kind of ["env_fact", "project_constraint"] as L3ItemKind[]) {
      const ofKind = items
        .filter((item) => item.kind === kind)
        .sort((a, b) => a.lastConfirmedAt.localeCompare(b.lastConfirmedAt) || a.createdAt.localeCompare(b.createdAt));
      for (const item of ofKind.slice(0, Math.max(0, ofKind.length - MAX_ITEMS_PER_KIND))) {
        this.deps.repos.l3Field.inactivateItem(item.id, { at });
        logEvolutionDecision(job, "l3_unit_update", "item_evicted_over_limit", { itemId: item.id, unitKey });
      }
    }
  }
}
