import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAppMemoryBudget } from "../../src/model/token-usage.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fetchAppMemoryBudget", () => {
  it.each(["home", "env", "option"])("reads the current profile budget with %s precedence", async (source) => {
    const root = mkdtempSync(join(tmpdir(), "memmy-budget-runtime-"));
    roots.push(root);
    for (const [file, port] of [["runtime.json", 18110], ["env.json", 18120], ["option.json", 18130]] as const) {
      writeFileSync(join(root, file), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}`, localToken: "profile-token" }));
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ dailyUsed: 12, lifetimeUsed: 34 })));
    await expect(fetchAppMemoryBudget({
      runtimeConfigPath: source === "option" ? join(root, "option.json") : undefined,
      env: { MEMMY_HOME: root, ...(source !== "home" ? { MEMMY_RUNTIME_CONFIG_PATH: join(root, "env.json") } : {}) },
      fetchImpl
    })).resolves.toEqual({ dailyUsed: 12, lifetimeUsed: 34 });
    const port = source === "home" ? 18110 : source === "env" ? 18120 : 18130;
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:${port}/api/app/byok-token-usage/memory-pipeline-usage`);
  });

  it("returns null when the caller aborts before the App responds", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        return;
      }
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    }));
    const pending = fetchAppMemoryBudget({
      runtimeConfig: { baseUrl: "http://127.0.0.1:18100", localToken: "runtime-token" },
      fetchImpl: fetchImpl as typeof fetch,
      signal: controller.signal,
      timeoutMs: 60_000
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).resolves.toBeNull();
  });
});
