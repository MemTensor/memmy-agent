import { randomUUID } from "node:crypto";
import { MemoryServiceError } from "../../utils/error.js";
import type { PanelReadModel } from "../read-model/panel-read.js";
type Input = Parameters<PanelReadModel["panelMembers"]>[0];
type PageData = ReturnType<PanelReadModel["panelPageByIds"]>;
interface View {
  id: string;
  scope: string;
  input: Input;
  ids: string[];
  safety: string;
  change: string;
  createdAt: string;
  touched: number;
  bytes: number;
  pages: Map<number, PageData>;
  building: Map<number, Promise<PageData>>;
}
export class PanelBrowse {
  readonly instanceId = randomUUID();
  private views = new Map<string, View>();
  constructor(
    private readonly deps: {
      read: <T>(method: string, args: unknown[], signal?: AbortSignal) => Promise<{ safety: string; data: T }>;
      safety: () => string;
      change: () => string | number;
      budget?: number;
      idleMs?: number;
    }
  ) {}
  private scope(input: Input) {
    return JSON.stringify(input.namespace ?? {});
  }
  private get(id: string, input: Input): View {
    const view = this.views.get(id);
    if (!view || view.scope !== this.scope(input))
      throw new MemoryServiceError("conflict", "Panel view expired; refresh");
    if (view.safety !== this.deps.safety() || Date.now() - view.touched > (this.deps.idleMs ?? 30 * 60_000)) {
      this.views.delete(id);
      throw new MemoryServiceError("conflict", "Panel view expired; refresh");
    }
    view.touched = Date.now();
    return view;
  }
  async create(input: Input, signal?: AbortSignal) {
    const change = String(this.deps.change());
    const result = await this.deps.read<string[]>("members", [input], signal);
    if (signal?.aborted) throw new DOMException("Panel view cancelled", "AbortError");
    if (result.safety !== this.deps.safety())
      throw new MemoryServiceError("conflict", "Panel changed while preparing; refresh");
    const view: View = {
      id: randomUUID(),
      scope: this.scope(input),
      input,
      ids: result.data,
      safety: result.safety,
      change,
      createdAt: new Date().toISOString(),
      touched: Date.now(),
      bytes: Buffer.byteLength(JSON.stringify(result.data)),
      pages: new Map(),
      building: new Map()
    };
    this.views.set(view.id, view);
    try {
      this.limit(view);
      const page = await this.page(view.id, 1, input);
      if (signal?.aborted) throw new DOMException("Panel view cancelled", "AbortError");
      return page;
    } catch (error) {
      this.views.delete(view.id);
      throw error;
    }
  }
  async page(id: string, page: number, input: Input) {
    const view = this.get(id, input);
    const total = view.ids.length;
    const totalPages = Math.max(1, Math.ceil(total / 20));
    if (!Number.isSafeInteger(page) || page < 1 || page > totalPages)
      throw new MemoryServiceError("invalid_argument", "Invalid panel page");
    let data = view.pages.get(page);
    if (!data) {
      let building = view.building.get(page);
      if (!building) {
        building = (async () => {
          const result = await this.deps.read<PageData>("page", [
            view.ids.slice((page - 1) * 20, page * 20),
            view.input
          ]);
          this.get(id, input);
          if (result.safety !== view.safety) {
            this.views.delete(id);
            throw new MemoryServiceError("conflict", "Panel view expired; refresh");
          }
          view.bytes += Buffer.byteLength(JSON.stringify(result.data));
          this.limit(view);
          view.pages.set(page, result.data);
          return result.data;
        })();
        view.building.set(page, building);
      }
      try {
        data = await building;
      } finally {
        view.building.delete(page);
      }
    }
    this.get(id, input);
    return {
      viewId: id,
      instanceId: this.instanceId,
      safety: view.safety,
      createdAt: view.createdAt,
      page,
      pageSize: 20 as const,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
      ...data,
      serverTime: new Date().toISOString()
    };
  }
  check(id: string, input: Input) {
    const view = this.get(id, input);
    return {
      viewId: id,
      instanceId: this.instanceId,
      safety: view.safety,
      updated: view.change !== String(this.deps.change()),
      serverTime: new Date().toISOString()
    };
  }
  release(id: string, input: Input) {
    const view = this.views.get(id);
    if (view && view.scope === this.scope(input)) this.views.delete(id);
    return { ok: true };
  }
  clear() {
    this.views.clear();
  }
  private limit(current: View) {
    const budget = this.deps.budget ?? 64 * 1024 * 1024;
    let total = [...this.views.values()].reduce((sum, view) => sum + view.bytes, 0);
    for (const view of [...this.views.values()].sort((a, b) => a.touched - b.touched)) {
      if (total <= budget) return;
      if (view === current) continue;
      this.views.delete(view.id);
      total -= view.bytes;
    }
    if (total > budget) {
      this.views.delete(current.id);
      throw new MemoryServiceError("conflict", "Panel view exceeds memory budget; narrow the filter");
    }
  }
}
