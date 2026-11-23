import type { MemoryRow } from "../../types.js";
import { DEVICE_MEMORY_OWNER } from "../namespace/memory-owner.js";
import { profileIdFromMemory, projectIdFromMemory } from "../namespace/namespace-scope.js";

/** Shared local comparison/lease scope, distinct from a source owner's authorization and snapshots. */
export function l2ComparisonScope(memory: MemoryRow): string {
  return JSON.stringify([DEVICE_MEMORY_OWNER, projectIdFromMemory(memory) ?? memory.appId ?? null,
    profileIdFromMemory(memory) ?? "default"]);
}

/** A device-owned lesson bridges retained ownership; unrelated historical owners never do. */
export function l2SharesComparisonScope(left: MemoryRow, right: MemoryRow): boolean {
  return (left.userId === right.userId || left.userId === DEVICE_MEMORY_OWNER || right.userId === DEVICE_MEMORY_OWNER)
    && l2ComparisonScope(left) === l2ComparisonScope(right);
}
