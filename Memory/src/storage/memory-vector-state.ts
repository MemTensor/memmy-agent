import type { MemoryRow } from "../types.js";

export type MemoryVectorField = "vec_summary" | "vec_action" | "vec";

export interface MemoryVectorValue {
  vectorField: MemoryVectorField;
  vector: number[];
  embeddingModel?: string | null;
  embeddingProvider?: string | null;
}

const memoryVectors = Symbol.for("memmy.memory.vectors");

interface MemoryVectorState {
  values: Map<MemoryVectorField, MemoryVectorValue>;
  dirty: Set<MemoryVectorField>;
}

type MemoryVectorCarrier = MemoryRow & {
  [memoryVectors]?: MemoryVectorState;
};

export function attachMemoryVectors(memory: MemoryRow, vectors: MemoryVectorValue[]): MemoryRow {
  const values = new Map<MemoryVectorField, MemoryVectorValue>();
  for (const entry of vectors) {
    if (entry.vector.length === 0) continue;
    values.set(entry.vectorField, {
      ...entry,
      vector: [...entry.vector]
    });
  }
  const carrier = memory as MemoryVectorCarrier;
  if (values.size > 0) carrier[memoryVectors] = { values, dirty: new Set() };
  else delete carrier[memoryVectors];
  return memory;
}

export function attachMemoryVector(memory: MemoryRow, vector: MemoryVectorValue): MemoryRow {
  const current = (memory as MemoryVectorCarrier)[memoryVectors];
  const values = new Map(memoryVectorEntries(memory).map((entry) => [entry.vectorField, entry]));
  values.set(vector.vectorField, {
    ...vector,
    vector: [...vector.vector]
  });
  (memory as MemoryVectorCarrier)[memoryVectors] = {
    values,
    dirty: new Set([...(current?.dirty ?? []), vector.vectorField])
  };
  return memory;
}

export function memoryVector(
  memory: MemoryRow,
  vectorField: MemoryVectorField
): number[] | null {
  return (memory as MemoryVectorCarrier)[memoryVectors]?.values.get(vectorField)?.vector ?? null;
}

export function memoryVectorEntries(memory: MemoryRow): MemoryVectorValue[] {
  return [...((memory as MemoryVectorCarrier)[memoryVectors]?.values.values() ?? [])].map((entry) => ({
    ...entry,
    vector: [...entry.vector]
  }));
}

export function dirtyMemoryVectorEntries(memory: MemoryRow): MemoryVectorValue[] {
  const state = (memory as MemoryVectorCarrier)[memoryVectors];
  if (!state) return [];
  return [...state.dirty].flatMap((field) => {
    const entry = state.values.get(field);
    return entry ? [{ ...entry, vector: [...entry.vector] }] : [];
  });
}

export function transferMemoryVectors(source: MemoryRow, target: MemoryRow): MemoryRow {
  const sourceState = (source as MemoryVectorCarrier)[memoryVectors];
  if (!sourceState) return attachMemoryVectors(target, []);
  const values = new Map(memoryVectorEntries(source).map((entry) => [entry.vectorField, entry]));
  (target as MemoryVectorCarrier)[memoryVectors] = {
    values,
    dirty: new Set(sourceState.dirty)
  };
  return target;
}
