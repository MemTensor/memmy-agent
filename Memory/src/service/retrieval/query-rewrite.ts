import type { RecallHit } from "../../types.js";
import type { RetrievalResult } from "../../algorithm/plugin-algorithms.js";

export function normalizeQueryRewriteQueries(value: unknown, maxQueries: number): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const query = singleLine(item).slice(0, 500);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

export function mergeRetrievalResults(retrievals: RetrievalResult[], limit: number, rrfConstant: number, minPerQuery: number): RetrievalResult {
  const entries = new Map<string, { hit: RecallHit; score: number; firstRank: number; firstQueryIndex: number }>();
  for (const [queryIndex, retrieval] of retrievals.entries()) for (const [rank, hit] of retrieval.hits.entries()) {
    const existing = entries.get(hit.id); const entry = existing ?? { hit, score: 0, firstRank: rank, firstQueryIndex: queryIndex };
    entry.score += 1 / (rank + 1 + rrfConstant); if (!existing || hit.score > existing.hit.score) entry.hit = hit;
    entry.firstRank = Math.min(entry.firstRank, rank); entry.firstQueryIndex = Math.min(entry.firstQueryIndex, queryIndex); entries.set(hit.id, entry);
  }
  const ranked = Array.from(entries.values()).sort((left, right) => right.score - left.score || left.firstRank - right.firstRank || left.firstQueryIndex - right.firstQueryIndex);
  const perQueryKeep = Math.min(minPerQuery, Math.max(1, Math.floor(Math.max(0, limit) / Math.max(1, retrievals.length))));
  const reserved = new Set(retrievals.flatMap((retrieval) => retrieval.hits.slice(0, perQueryKeep).map((hit) => hit.id)));
  const hits = [...ranked.filter((entry) => reserved.has(entry.hit.id)), ...ranked.filter((entry) => !reserved.has(entry.hit.id))].slice(0, Math.max(0, limit)).map((entry) => ({ ...entry.hit, score: roundNumber(entry.score) }));
  const kept = { tier1: hits.filter((hit) => recallHitTier(hit) === "tier1").length, tier2: hits.filter((hit) => recallHitTier(hit) === "tier2").length, tier3: hits.filter((hit) => recallHitTier(hit) === "tier3").length };
  return { hits, debug: { tierSizes: retrievals.reduce((acc, retrieval) => ({ tier1: acc.tier1 + retrieval.debug.tierSizes.tier1, tier2: acc.tier2 + retrieval.debug.tierSizes.tier2, tier3: acc.tier3 + retrieval.debug.tierSizes.tier3 }), { tier1: 0, tier2: 0, tier3: 0 }), kept, topRelevance: hits[0]?.score ?? 0, droppedByThreshold: retrievals.reduce((sum, retrieval) => sum + retrieval.debug.droppedByThreshold, 0) } };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
function recallHitTier(hit: RecallHit): "tier1" | "tier2" | "tier3" { return hit.memoryLayer === "Skill" ? "tier1" : hit.memoryLayer === "L3" ? "tier3" : "tier2"; }
function roundNumber(value: number, digits = 4): number { const base = Math.pow(10, digits); return Math.round(value * base) / base; }
