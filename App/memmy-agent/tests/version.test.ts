import { afterEach, expect, it, vi } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
afterEach(() => { vi.doUnmock("node:fs"); vi.resetModules(); });
it("packaged runtimes stop at their own manifest without accessing the host manifest", async () => {
  vi.resetModules();
  const read = vi.fn((file: string) => {
    if (file !== join(packageRoot, "package.json")) throw new Error("EPERM: outside sandbox");
    return JSON.stringify({ name: "@memtensor/memmy-agent", version: "1.2.4" });
  });
  vi.doMock("node:fs", () => ({ existsSync: (file: string) => !file.endsWith("/src/package.json"), readFileSync: read }));
  expect((await import("../src/version.js")).VERSION).toBe("1.2.4");
  expect(read).toHaveBeenCalledTimes(1);
});
it("source checkouts still use the workspace project version", async () => {
  vi.resetModules();
  const manifests = new Map([
    [join(packageRoot, "package.json"), { name: "memmy-agent", version: "1.0.0" }],
    [join(dirname(dirname(packageRoot)), "package.json"), { name: "memmy-agent", version: "1.2.4", workspaces: [] }],
  ]);
  vi.doMock("node:fs", () => ({ existsSync: (file: string) => manifests.has(file), readFileSync: (file: string) => JSON.stringify(manifests.get(file)) }));
  expect((await import("../src/version.js")).VERSION).toBe("1.2.4");
});
