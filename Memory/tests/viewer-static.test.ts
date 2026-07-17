import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { memoryPanelHtml } from "../src/viewer/static.js";

describe("memoryPanelHtml", () => {
  it("strips generated Summary prefixes from displayed memory titles", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    expect(harness.rowHtml()).toContain('<div class="memory-title">First memory</div>');
    expect(harness.rowHtml()).toContain('<div class="memory-title">Second memory</div>');
    expect(harness.rowHtml()).not.toContain('<div class="memory-title">Summary:');
  });

  it("keeps the right JSON panel on the latest clicked memory detail", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness);
    await flushPromises();

    const rows = harness.rows();
    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    const secondRow = rows[1];
    if (!firstRow || !secondRow) {
      throw new Error("expected two rendered memory rows");
    }
    const firstClick = firstRow.onclick();
    const secondClick = secondRow.onclick();

    harness.resolveDetail("memory-2", {
      item: { id: "memory-2", title: "Summary: Second memory", metadata: { source: "second" } }
    });
    await secondClick;

    expect(harness.element("detailId").textContent).toBe("memory-2");
    expect(harness.element("detailTitle").textContent).toBe("Second memory");
    expect(harness.element("detailJson").textContent).toContain('"source": "second"');

    harness.resolveDetail("memory-1", {
      item: { id: "memory-1", title: "First memory", metadata: { source: "first" } }
    });
    await firstClick;

    expect(harness.element("detailId").textContent).toBe("memory-2");
    expect(harness.element("detailJson").textContent).toContain('"source": "second"');
    expect(harness.element("detailJson").textContent).not.toContain('"source": "first"');
  });
});

type FakeRow = FakeElement & {
  dataset: { id: string };
  onclick: () => Promise<void>;
};

type DetailResolver = (body: unknown) => void;

function runViewerScript(harness: ReturnType<typeof createViewerHarness>): void {
  const match = memoryPanelHtml().match(/<script>([\s\S]*)<\/script>/);
  const script = match?.[1];
  if (!script) {
    throw new Error("viewer script not found");
  }

  const context = createContext({
    document: harness.document,
    fetch: harness.fetch,
    navigator: { clipboard: { writeText: async () => undefined } },
    URLSearchParams
  });
  new Script(script).runInContext(context);
}

function createViewerHarness() {
  const elements = new Map<string, FakeElement>();
  const detailResolvers = new Map<string, DetailResolver>();
  const ids = [
    "errorMessage",
    "stats",
    "query",
    "layer",
    "status",
    "memoryRows",
    "emptyState",
    "listMeta",
    "pageInput",
    "totalPagesText",
    "prevPage",
    "nextPage",
    "detailTitle",
    "detailId",
    "detailJson",
    "refresh",
    "search",
    "clearFilters",
    "copyJson"
  ];

  for (const id of ids) {
    elements.set(id, new FakeElement());
  }
  elements.get("pageInput")!.value = "1";

  const memoryRows = elements.get("memoryRows")!;
  Object.defineProperty(memoryRows, "innerHTML", {
    get() {
      return this.html;
    },
    set(value: string) {
      this.html = value;
      this.childRows = [...value.matchAll(/<tr data-id="([^"]+)"/g)].map((match) => {
        const encodedId = match[1];
        if (!encodedId) {
          throw new Error("memory row id not found");
        }
        const row = new FakeElement() as FakeRow;
        row.dataset = { id: decodeHtml(encodedId) };
        row.onclick = async () => undefined;
        return row;
      });
    }
  });

  const fetch = async (path: string) => {
    if (path === "/api/v1/panel/overview") {
      return jsonResponse({ counts: { memories: 2, experiences: 0, worldModels: 0, skills: 0 } });
    }
    if (path.startsWith("/api/v1/panel/items?")) {
      return jsonResponse({
        items: [
          listItem("memory-1", "Summary: First memory"),
          listItem("memory-2", "Summary: Second memory")
        ],
        page: 1,
        pageSize: 20,
        total: 2,
        totalPages: 1,
        hasNext: false,
        hasPrev: false
      });
    }
    if (path.startsWith("/api/v1/memory/")) {
      const id = decodeURIComponent(path.slice("/api/v1/memory/".length));
      return new Promise((resolve) => {
        detailResolvers.set(id, (body) => resolve(jsonResponse(body)));
      });
    }
    throw new Error(`unexpected fetch path: ${path}`);
  };

  return {
    document: {
      getElementById(id: string) {
        const element = elements.get(id);
        if (!element) {
          throw new Error(`missing element: ${id}`);
        }
        return element;
      }
    },
    element(id: string) {
      return elements.get(id)!;
    },
    fetch,
    resolveDetail(id: string, body: unknown) {
      const resolve = detailResolvers.get(id);
      if (!resolve) {
        throw new Error(`missing resolver for detail: ${id}`);
      }
      resolve(body);
    },
    rowHtml() {
      return memoryRows.html;
    },
    rows() {
      return memoryRows.childRows as FakeRow[];
    }
  };
}

class FakeElement {
  html = "";
  textContent = "";
  value = "";
  disabled = false;
  onclick: unknown;
  onkeydown: unknown;
  onfocus: unknown;
  onchange: unknown;
  childRows: FakeRow[] = [];
  dataset: Record<string, string> = {};
  classList = {
    add: () => undefined,
    remove: () => undefined,
    toggle: () => undefined
  };

  querySelectorAll(selector: string): FakeRow[] {
    return selector === "tr" ? this.childRows : [];
  }

  select(): void {
    return undefined;
  }
}

function listItem(id: string, title: string) {
  return {
    id,
    kind: "trace",
    memoryLayer: "L1",
    status: "activated",
    title,
    summary: `${title} summary`,
    tags: [],
    createdAt: "2026-06-22T00:00:00.000Z",
    updatedAt: "2026-06-22T00:00:00.000Z",
    version: 1
  };
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    statusText: "OK",
    text: async () => JSON.stringify(body)
  };
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
