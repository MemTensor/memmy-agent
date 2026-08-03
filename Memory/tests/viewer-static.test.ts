import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { memoryPanelHtml } from "../src/viewer/static.js";

describe("memoryPanelHtml", () => {
  it("uses an inline favicon so the protected server does not receive browser favicon requests", () => {
    expect(memoryPanelHtml()).toContain('<link rel="icon" href="data:,">');
  });

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

  it("uses a fragment token for API requests without leaving it in the address bar", async () => {
    const harness = createViewerHarness();
    const stored = new Map<string, string>();
    let replacedUrl = "";
    runViewerScript(harness, {
      window: {
        location: {
          hash: "#token=panel-token",
          pathname: "/",
          search: ""
        }
      },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value)
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replacedUrl = url;
        }
      }
    });
    await flushPromises();

    expect(stored.get("memmyMemoryToken")).toBe("panel-token");
    expect(replacedUrl).toBe("/");
    expect(harness.requests()).not.toHaveLength(0);
    expect(harness.requests().every((request) => request.authorization === "Bearer panel-token")).toBe(true);
    expect(harness.requests().every((request) => !request.path.includes("panel-token"))).toBe(true);
  });

  it("validates a manually entered token against a protected panel endpoint", async () => {
    const harness = createViewerHarness();
    runViewerScript(harness, {
      sessionStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined
      }
    });

    harness.element("tokenInput").value = "manual-panel-token";
    const connect = harness.element("connectToken").onclick as () => Promise<void>;
    await connect();
    await flushPromises();

    expect(harness.requests()[0]).toEqual({
      path: "/api/v1/panel/status",
      authorization: "Bearer manual-panel-token"
    });
  });
});

type FakeRow = FakeElement & {
  dataset: { id: string };
  onclick: () => Promise<void>;
};

type DetailResolver = (body: unknown) => void;

function runViewerScript(
  harness: ReturnType<typeof createViewerHarness>,
  browserContext: Record<string, unknown> = {}
): void {
  const match = memoryPanelHtml().match(/<script>([\s\S]*)<\/script>/);
  const script = match?.[1];
  if (!script) {
    throw new Error("viewer script not found");
  }

  const context = createContext({
    document: harness.document,
    fetch: harness.fetch,
    navigator: { clipboard: { writeText: async () => undefined } },
    sessionStorage: {
      getItem: () => "viewer-test-token",
      setItem: () => undefined,
      removeItem: () => undefined
    },
    setTimeout: (callback: () => void) => {
      callback();
      return 0;
    },
    clearTimeout: () => undefined,
    URLSearchParams,
    ...browserContext
  });
  new Script(script).runInContext(context);
}

function createViewerHarness() {
  const elements = new Map<string, FakeElement>();
  const detailResolvers = new Map<string, DetailResolver>();
  const requests: Array<{ path: string; authorization?: string }> = [];
  const ids = [
    "navDashboard",
    "navMemories",
    "navActivity",
    "navTasks",
    "navSystem",
    "viewDashboard",
    "viewMemories",
    "viewActivity",
    "viewTasks",
    "viewSystem",
    "pageTitle",
    "pageSubtitle",
    "themeToggle",
    "lockConsole",
    "sidebarStatusDot",
    "sidebarStatusText",
    "sidebarVersion",
    "errorMessage",
    "stats",
    "analysisMetrics",
    "activityChart",
    "activityCaption",
    "activityTotal",
    "sourceDistribution",
    "sourceTotal",
    "queueSummary",
    "queueState",
    "recentActivity",
    "openActivity",
    "query",
    "layer",
    "status",
    "sourceAgent",
    "memoryRows",
    "emptyState",
    "listMeta",
    "memoryResultSummary",
    "pageInput",
    "totalPagesText",
    "prevPage",
    "nextPage",
    "detailTitle",
    "detailId",
    "detailContent",
    "detailJson",
    "deleteMemory",
    "activityQuery",
    "activityTool",
    "activitySource",
    "activityRows",
    "activityEmpty",
    "activityMeta",
    "activityDetailTitle",
    "activityDetailId",
    "activityDetailJson",
    "loadActivity",
    "clearActivity",
    "copyActivity",
    "taskQuery",
    "searchTasks",
    "clearTasks",
    "taskRows",
    "taskEmpty",
    "taskMeta",
    "taskResultSummary",
    "taskPageText",
    "prevTaskPage",
    "nextTaskPage",
    "taskDetailTitle",
    "taskDetailId",
    "taskDetailContent",
    "taskDetailJson",
    "copyTask",
    "deleteTask",
    "systemHealthBadge",
    "systemHealth",
    "systemSchema",
    "systemStorage",
    "systemModels",
    "systemQueues",
    "configJson",
    "runWorker",
    "reloadConfig",
    "copyConfig",
    "authScreen",
    "tokenInput",
    "authError",
    "connectToken",
    "toast",
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

  const fetch = async (path: string, options: { headers?: Record<string, string> } = {}) => {
    requests.push({ path, authorization: options.headers?.authorization });
    if (path === "/api/v1/panel/overview") {
      return jsonResponse({ counts: { memories: 2, experiences: 0, worldModels: 0, skills: 0 } });
    }
    if (path === "/api/v1/panel/analysis") {
      return jsonResponse({ metrics: { avgRecallScore: 0.8, recallEvents: 2, activeSkills: 0, recentlyUsedSkills: 0, avgToolLatencyMs: 12, p95ToolLatencyMs: 20 }, dailyMemoryWrites: [], dailySkillEvolutions: [], toolLatency: { tools: [], series: [] } });
    }
    if (path === "/api/v1/panel/metrics") {
      return jsonResponse({ storage: { backend: "sqlite" }, schema: { version: 1 }, changeSeq: 1, feedback: { recent: 0 }, jobs: { queued: 0, leased: 0, succeeded: 0, failed: 0, dead_letter: 0 }, embeddingRetries: { pending: 0, in_progress: 0, succeeded: 0, failed: 0 }, models: {} });
    }
    if (path === "/api/v1/panel/status") {
      return jsonResponse({ health: { ok: true, version: "1.0.4", mode: "dev", activeProfile: "byok", uptimeMs: 10, storage: { backend: "sqlite" } }, serverTime: new Date().toISOString() });
    }
    if (path === "/api/v1/panel/activity?limit=20") {
      return jsonResponse({ entries: [] });
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
      },
      documentElement: new FakeElement()
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
    },
    requests() {
      return requests;
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
  className = "";
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

  focus(): void {
    return undefined;
  }

  setAttribute(): void {
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
