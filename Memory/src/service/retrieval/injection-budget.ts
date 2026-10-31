import type { InjectedContext, MemoryKind, RecallMemoryLayer } from "../../types.js";

export interface InjectionPacket {
  injectedContext: InjectedContext;
  sourceMemoryIds: string[];
}

export interface BudgetSource {
  id: string;
  kind: MemoryKind;
  memoryLayer: RecallMemoryLayer;
  tokenEstimate?: number;
}

/** The renderer is the authority for both content and sources, including wrappers. */
export function budgetInjection<T>(
  candidates: T[],
  budget: number,
  render: (selected: T[]) => InjectionPacket,
  sources: (candidate: T) => BudgetSource[],
  fixedContextChars = 0
): InjectionPacket & { droppedDueToBudget: Array<BudgetSource & { reason: "token_budget" }> } {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  const measure = (items: T[]): InjectionPacket => {
    const packet = render(items);
    return { ...packet, injectedContext: { ...packet.injectedContext,
      tokenEstimate: Math.ceil(packet.injectedContext.markdown.length / 4) } };
  };
  // Fixed task instructions are independent of recalled memories. Charge only
  // the additional rendered text; keep tokenEstimate truthful for the full packet.
  const fits = (packet: InjectionPacket) => Math.ceil(Math.max(0,
    packet.injectedContext.markdown.length - fixedContextChars) / 4) <= limit;
  const full = measure(candidates);
  if ((limit > 0 || candidates.length === 0) && fits(full)) {
    return { ...full, droppedDueToBudget: [] };
  }
  let result: InjectionPacket = {
    injectedContext: { markdown: "", sections: [], tokenEstimate: 0 }, sourceMemoryIds: []
  };
  const selected: T[] = [];
  const rejected: T[] = [];
  const empty = measure([]);
  if (fits(empty)) result = empty;
  for (const candidate of candidates) {
    if (limit === 0) { rejected.push(candidate); continue; }
    const trial = measure([...selected, candidate]);
    if (fits(trial)) {
      selected.push(candidate);
      result = trial;
    } else {
      rejected.push(candidate);
    }
  }
  const retained = new Set(result.sourceMemoryIds);
  const dropped = new Map<string, BudgetSource & { reason: "token_budget" }>();
  for (const candidate of rejected) {
    for (const source of sources(candidate)) {
      if (!retained.has(source.id)) dropped.set(source.id, { ...source, reason: "token_budget" });
    }
  }
  return { ...result, droppedDueToBudget: [...dropped.values()] };
}
