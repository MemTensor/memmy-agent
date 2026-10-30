import type { EvidenceFragment, L3ItemKind, L3ItemRecord, L3UnitRecord } from "./types.js";

/** One model call: the machine plus at most one project, with the evidence that may support them. */
export interface L3UpdateGroup {
  machine: L3UnitRecord;
  project: L3UnitRecord | null;
  fragments: EvidenceFragment[];
  l1: Array<{ id: string; title: string; summary: string; at: string }>;
}

/** A validated operation; every op names the unit it changes. */
export type L3UnitOp =
  | { op: "add"; unitKey: string; kind: L3ItemKind; content: string; evidence: string[] }
  | { op: "replace"; unitKey: string; kind: L3ItemKind; ids: string[]; content: string; evidence: string[] }
  | { op: "delete"; unitKey: string; id: string; evidence: string[] }
  | { op: "confirm"; unitKey: string; id: string; evidence: string[] };

interface RawOp {
  op: "add" | "replace" | "delete" | "confirm";
  unit?: string;
  unit_key?: string;
  kind?: string;
  content?: string;
  ids?: string[];
  id?: string;
  evidence: string[];
}

const MIN_REPOSITORY_NAME_LENGTH = 4;

/** JSON shape only; semantic checks run in validateL3UnitOps so the model can be told what was wrong. */
export function parseL3UnitOutput(value: unknown): { reason: string; ops: RawOp[] } {
  if (!isRecord(value) || !Array.isArray(value.ops)) throw new TypeError("expected {reason, ops[]}");
  const ops = value.ops.map((op, index): RawOp => {
    if (!isRecord(op) || !["add", "replace", "delete", "confirm"].includes(op.op as string)) {
      throw new TypeError(`ops[${index}]: unknown op`);
    }
    if (!isStringArray(op.evidence)) throw new TypeError(`ops[${index}]: evidence must be a string array`);
    if (op.ids !== undefined && !isStringArray(op.ids)) throw new TypeError(`ops[${index}]: ids must be a string array`);
    for (const key of ["unit", "unit_key", "kind", "content", "id"]) {
      if (op[key] !== undefined && typeof op[key] !== "string") throw new TypeError(`ops[${index}]: ${key} must be a string`);
    }
    return op as unknown as RawOp;
  });
  return { reason: typeof value.reason === "string" ? value.reason : "", ops };
}

/** Checks every op against the group; returns the ops that pass and one line per problem. */
export function validateL3UnitOps(
  rawOps: readonly RawOp[],
  group: L3UpdateGroup,
  activeItems: ReadonlyMap<string, L3ItemRecord>,
  /** Items written earlier in this batch: shown to the model, but changes to them are dropped, not errors. */
  addedInBatch: ReadonlySet<string> = new Set()
): { ops: L3UnitOp[]; problems: string[] } {
  const fragments = new Map(group.fragments.map((fragment) => [fragment.id, fragment]));
  const groupUnits = new Set([group.machine.unitKey, ...(group.project ? [group.project.unitKey] : [])]);
  const usedIds = new Set<string>();
  const ops: L3UnitOp[] = [];
  const problems: string[] = [];

  rawOps.forEach((raw, index) => {
    const fail = (message: string) => problems.push(`ops[${index}]: ${message}`);
    const targets = raw.op === "replace" ? raw.ids ?? [] : raw.op === "add" ? [] : [raw.id ?? ""];
    if (targets.some((id) => addedInBatch.has(id))) return;
    const evidence = [...new Set(raw.evidence)];
    if (evidence.length === 0) return fail("evidence is empty");
    const unknown = evidence.filter((id) => !fragments.has(id));
    if (unknown.length) return fail(`evidence ${unknown.join(", ")} is not a fragment of this input`);

    if (raw.op === "add" || raw.op === "replace") {
      const content = raw.content?.trim() ?? "";
      if (!content) return fail("content is empty");
      let unitKey: string;
      let kind: L3ItemKind;
      let ids: string[] = [];
      if (raw.op === "add") {
        if (raw.unit === "machine") {
          unitKey = group.machine.unitKey;
        } else if (raw.unit === "project") {
          if (!group.project) return fail("no project is listed, so unit must be machine");
          if (raw.unit_key && raw.unit_key !== group.project.unitKey) return fail(`unit_key ${raw.unit_key} is not a listed project`);
          unitKey = group.project.unitKey;
        } else {
          return fail(`unit must be "machine" or "project"`);
        }
        if (raw.kind !== "env_fact" && raw.kind !== "project_constraint") return fail("kind must be env_fact or project_constraint");
        kind = raw.kind;
      } else {
        ids = [...new Set(raw.ids ?? [])];
        if (ids.length === 0) return fail("replace needs ids");
        const items = ids.map((id) => activeItems.get(id));
        const missing = ids.filter((_, i) => !items[i] || !groupUnits.has(items[i]!.unitKey));
        if (missing.length) return fail(`id ${missing.join(", ")} is not an active item of this group`);
        const reused = ids.filter((id) => usedIds.has(id));
        if (reused.length) return fail(`id ${reused.join(", ")} is already changed by another op`);
        unitKey = items[0]!.unitKey;
        kind = items[0]!.kind;
        if (items.some((item) => item!.unitKey !== unitKey || item!.kind !== kind)) {
          return fail("replaced ids must share one unit and kind");
        }
      }
      const isMachine = unitKey === group.machine.unitKey;
      if (isMachine && kind !== "env_fact") return fail("machine items must be env_fact");
      if (kind === "env_fact" && !evidence.some((id) => provesFact(fragments.get(id)!, unitKey, isMachine))) {
        return fail("env_fact needs a cited tool output or error that touched this unit");
      }
      if (isMachine && group.project && mentionsProject(content, group.project)) {
        return fail("a machine item must not mention a project, repository or folder");
      }
      ids.forEach((id) => usedIds.add(id));
      ops.push(raw.op === "add"
        ? { op: "add", unitKey, kind, content, evidence }
        : { op: "replace", unitKey, kind, ids, content, evidence });
      return;
    }

    const id = raw.id ?? "";
    const item = activeItems.get(id);
    if (!item || !groupUnits.has(item.unitKey)) return fail(`id ${id || "(missing)"} is not an active item of this group`);
    if (usedIds.has(id)) return fail(`id ${id} is already changed by another op`);
    usedIds.add(id);
    ops.push({ op: raw.op, unitKey: item.unitKey, id, evidence });
  });
  return { ops, problems };
}

/** A tool call with output or an error, whose own paths belong to the unit (any call counts for the machine). */
function provesFact(fragment: EvidenceFragment, unitKey: string, isMachine: boolean): boolean {
  if (!fragment.toolName || !(fragment.isError || fragment.output?.trim())) return false;
  return isMachine || fragment.candidateUnitKeys.includes(unitKey);
}

function mentionsProject(content: string, project: L3UnitRecord): boolean {
  const lower = content.toLowerCase();
  if (project.checkoutRoot && lower.includes(project.checkoutRoot.toLowerCase())) return true;
  const name = project.displayName?.trim().toLowerCase();
  if (!name || name.length < MIN_REPOSITORY_NAME_LENGTH) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, "u").test(lower);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
