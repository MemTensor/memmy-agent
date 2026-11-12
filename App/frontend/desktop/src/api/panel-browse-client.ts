import { ApiRequestError } from "./http.js";
import {
  PanelBrowseCheckSchema,
  PanelBrowsePageSchema,
  type PanelBrowseInput,
  type PanelBrowseOutput,
  type PanelBrowsePage,
  type PanelItemsInput
} from "@memmy/local-api-contracts";
import { PanelRequestQueue } from "./panel-request-queue.js";

interface View {
  key: string;
  filter: NonNullable<PanelBrowseInput["filter"]>;
  identity: Pick<PanelBrowsePage, "viewId" | "instanceId" | "safety" | "totalPages">;
  pages: Map<number, PanelBrowsePage>;
}
interface Selection {
  key: string;
  generation: number;
  controller: AbortController;
  refresh: boolean;
}

/** The client owns creation/publication; callers only own their subscription. */
export class PanelBrowseClient {
  private views = new Map<string, View>();
  private selections = new Map<string, Selection>();
  private requests = new PanelRequestQueue(2);
  private creations = new PanelRequestQueue(2);
  private cached = new Map<PanelBrowsePage, { view: View; page: number; bytes: number }>();
  private nextGeneration = 0;
  get idle(): boolean {
    return this.requests.idle && this.creations.idle;
  }
  hasView(section: string): boolean {
    return this.views.has(section) || this.selections.has(section);
  }
  private unsupported = false;
  constructor(
    private readonly request: (input: PanelBrowseInput, signal?: AbortSignal) => Promise<PanelBrowseOutput>,
    private readonly missing: (error: unknown) => boolean,
    private readonly budget = 5 * 1024 * 1024
  ) {}

  list(section: string, input: PanelItemsInput, signal?: AbortSignal): Promise<PanelBrowsePage | undefined> {
    if (this.unsupported) return Promise.resolve(undefined);
    const { page: requestedPage = 1, ...filterInput } = input;
    const filter = { ...filterInput, section: section === "tasks" ? ("tasks" as const) : ("items" as const) };
    const key = JSON.stringify(filter);
    let selection = this.selections.get(section);
    if (!selection || selection.key !== key) selection = this.select(section, key, false);
    const selected = selection;
    const current = this.views.get(section);
    const combined = signal ? AbortSignal.any([signal, selected.controller.signal]) : selected.controller.signal;
    return this.requests.request(
      `${section}:${selected.generation}:${requestedPage}`,
      async (sharedSignal) => {
        const valid = () => {
          if (this.selections.get(section) !== selected || sharedSignal.aborted) throw abortError();
        };
        try {
          let view = this.views.get(section);
          const refreshing = selected.refresh;
          let createdNow = false;
          if (!view || view.key !== key || refreshing) {
            createdNow = true;
            view = await this.creations.request(
              `${section}:${selected.generation}`,
              async (createSignal) => {
                const created = PanelBrowsePageSchema.parse(await this.request({ op: "create", filter }, createSignal));
                if (this.selections.get(section) !== selected || createSignal.aborted) {
                  this.release(created.viewId, filter);
                  throw abortError();
                }
                const replacement: View = { key, filter, identity: identity(created), pages: new Map() };
                const previous = this.views.get(section);
                this.views.set(section, replacement);
                selected.refresh = false;
                this.cache(replacement, created);
                if (previous) this.dispose(previous);
                return replacement;
              },
              sharedSignal
            );
          }
          valid();
          const page = refreshing ? 1 : Math.min(requestedPage, view.identity.totalPages);
          const cached = view.pages.get(page);
          let result: PanelBrowsePage;
          if (cached && createdNow && page === 1) {
            result = cached;
          } else if (cached) {
            const checked = PanelBrowseCheckSchema.parse(
              await this.request({ op: "check", viewId: view.identity.viewId, filter }, sharedSignal)
            );
            if (checked.instanceId !== cached.instanceId || checked.safety !== cached.safety)
              throw new ApiRequestError("Panel view expired; refresh", 409, "conflict");
            result = cached;
          } else {
            result = PanelBrowsePageSchema.parse(
              await this.request({ op: "page", viewId: view.identity.viewId, page, filter }, sharedSignal)
            );
          }
          valid();
          if (
            this.views.get(section) !== view ||
            result.viewId !== view.identity.viewId ||
            result.instanceId !== view.identity.instanceId ||
            result.safety !== view.identity.safety
          )
            throw abortError();
          view.identity = identity(result);
          this.cache(view, result);
          return result;
        } catch (error) {
          valid();
          if (!current && this.missing(error)) {
            this.unsupported = true;
            return undefined;
          }
          throw error;
        }
      },
      combined
    );
  }

  async check(section: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const view = this.views.get(section);
    if (!view) return { updated: false };
    const checked = PanelBrowseCheckSchema.parse(
      await this.request({ op: "check", viewId: view.identity.viewId, filter: view.filter }, signal)
    );
    signal?.throwIfAborted();
    if (this.views.get(section) !== view) throw abortError();
    return checked;
  }

  /** Refresh is atomic: retain the valid view until its replacement succeeds. */
  refresh(section: string) {
    const selection = this.selections.get(section);
    if (selection) this.select(section, selection.key, true);
  }

  reset(section?: string) {
    if (section) {
      this.selections.get(section)?.controller.abort();
      this.selections.delete(section);
      const view = this.views.get(section);
      this.views.delete(section);
      if (view) this.dispose(view);
    } else {
      for (const key of new Set([...this.views.keys(), ...this.selections.keys()])) this.reset(key);
      this.unsupported = false;
    }
  }

  private select(section: string, key: string, refresh: boolean): Selection {
    this.selections.get(section)?.controller.abort();
    const selection = { key, generation: ++this.nextGeneration, controller: new AbortController(), refresh };
    this.selections.set(section, selection);
    return selection;
  }
  private cache(view: View, value: PanelBrowsePage) {
    const previous = view.pages.get(value.page);
    if (previous) this.cached.delete(previous);
    view.pages.delete(value.page);
    view.pages.set(value.page, value);
    this.cached.set(value, { view, page: value.page, bytes: JSON.stringify(value).length * 2 });
    let bytes = [...this.cached.values()].reduce((sum, item) => sum + item.bytes, 0);
    for (const [entry, owner] of this.cached) {
      if (bytes <= this.budget && view.pages.size <= 10) break;
      if (bytes <= this.budget && owner.view !== view) continue;
      owner.view.pages.delete(owner.page);
      this.cached.delete(entry);
      bytes -= owner.bytes;
    }
  }
  private dispose(view: View) {
    for (const page of view.pages.values()) this.cached.delete(page);
    view.pages.clear();
    this.release(view.identity.viewId, view.filter);
  }
  private release(viewId: string, filter: View["filter"]) {
    void this.request({ op: "release", viewId, filter }).catch(() => undefined);
  }
}
function abortError() {
  return new DOMException("Superseded panel request", "AbortError");
}

function identity(page: PanelBrowsePage): View["identity"] {
  const { viewId, instanceId, safety, totalPages } = page;
  return { viewId, instanceId, safety, totalPages };
}
