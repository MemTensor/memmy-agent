import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import vitestConfig from "../../vitest.config.js";
import { MemmyMemoryClient } from "../../src/memmy-memory/client.js";
import { discoverMemmyMemoryConnection } from "../../src/memmy-memory/discovery.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("default test Memory connection", () => {
  it.each(["process environment", "config file", "legacy environment aliases"])("isolates default test requests from developer Memory in the %s", async (source) => {
    const root = mkdtempSync(join(tmpdir(), "memmy-test-isolation-"));
    roots.push(root);
    const home = join(root, ".memmy");
    mkdirSync(home);
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, [
      "memmyMemory:",
      "  storage:",
      "    endpoint: http://127.0.0.1:18960",
      "    token: fixture-user-config-token",
    ].join("\n"));
    const connection = discoverMemmyMemoryConnection({
      homeDir: root,
      env: {
        ...(source === "process environment" ? {
          MEMMY_MEMORY_URL: "http://127.0.0.1:18960",
          MEMMY_MEMORY_TOKEN: "fixture-user-environment-token",
        } : source === "legacy environment aliases" ? {
          MEMORY_SERVICE_URL: "http://127.0.0.1:18960",
          MEMORY_SERVICE_TOKEN: "fixture-user-environment-token",
        } : {}),
        ...vitestConfig.test?.env,
        MEMMY_CONFIG: configPath,
      },
    });
    const request = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    const client = new MemmyMemoryClient(connection, request);
    await client.get("/api/v1/health");

    expect(request).toHaveBeenCalledWith("http://memory.test.invalid/api/v1/health", expect.any(Object));
    expect(request.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });
});
