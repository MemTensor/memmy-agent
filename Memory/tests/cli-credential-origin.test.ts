import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runtimeTarget } from "../src/cli/runtime-installer.js";
import { runCommand } from "../src/cli/commands.js";

beforeEach(() => {
  for (const key of ["MEMMY_MEMORY_TOKEN", "MEMORY_SERVICE_TOKEN", "MEMMY_MEMORY_URL", "MEMORY_SERVICE_URL"]) {
    vi.stubEnv(key, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

async function receiver() {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization);
    const isAuthCheck = req.url === "/api/v1/auth/check";
    const authenticated = !!req.headers.authorization;
    res.writeHead(isAuthCheck && !authenticated ? 401 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(isAuthCheck ? { authenticated, authVersion: 1 } : { ok: true, protocolVersion: 1, serviceVersion: "2.1.0" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

it("sends implicit CLI credentials only to their configured origins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-origins-"));
  const local = await receiver();
  const other = await receiver();
  try {
    const config = join(dir, "config.yaml");
    await runCommand({ argv: ["init", "--config", config, "--home", dir, "--endpoint", local.url, "--skip-agent-skills"] });
    const health = (...args: string[]) => runCommand({ argv: ["health", "--config", config, ...args] });
    await health("--url", local.url + "/");
    expect(local.seen[0]).toMatch(/^Bearer [a-f0-9]{64}$/);
    await health("--url", other.url);
    vi.stubEnv("MEMORY_SERVICE_URL", other.url);
    await health();
    vi.stubEnv("MEMORY_SERVICE_TOKEN", "other-test-token");
    await health();
    await health("--url", local.url);
    await health("--url", other.url, "--token", "explicit-test-token");
    expect(other.seen).toEqual([undefined, undefined, "Bearer other-test-token", "Bearer explicit-test-token"]);
    expect(local.seen).toEqual([local.seen[0], local.seen[0]]);

    // A new-name URL override cannot claim the existing legacy pair's credential.
    vi.stubEnv("MEMMY_MEMORY_URL", local.url);
    await health();
    expect(local.seen.at(-1)).toBe(local.seen[0]);
    await health("--url", other.url);
    expect(other.seen.at(-1)).toBe("Bearer other-test-token");
    vi.stubEnv("MEMMY_MEMORY_URL", undefined);

    // Check a third origin and scheme/hostname changes without contacting external services.
    for (const url of ["https://other.invalid", local.url.replace("http:", "https:"), local.url.replace("127.0.0.1", "localhost")]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
      await runCommand({ argv: ["health", "--config", config, "--url", url], fetch });
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).has("authorization")).toBe(false);
    }
    vi.stubEnv("MEMORY_SERVICE_URL", undefined);
    vi.stubEnv("MEMORY_SERVICE_TOKEN", undefined);
    const before = await readFile(config, "utf8");
    await expect(runCommand({ argv: ["install", "--config", config, "--home", dir, "--endpoint", other.url, "--service-only"] }))
      .rejects.toThrow("requires a token for the new endpoint");
    expect(await readFile(config, "utf8")).toBe(before);
  } finally {
    await Promise.all([local.close(), other.close(), rm(dir, { recursive: true, force: true })]);
  }
});

it("recognizes equivalent HTTP origins for legacy configurations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli-legacy-origin-"));
  try {
    const config = join(dir, "config.yaml");
    await writeFile(config, "memmyMemory: {endpoint: 'https://example.invalid', token: legacy-test-token}");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
    await runCommand({ argv: ["health", "--config", config, "--url", "https://EXAMPLE.invalid:443/"], fetch });
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer legacy-test-token");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["install", "upgrade"])("%s refuses a foreign environment token before writing or probing", async command => {
  const dir = await mkdtemp(join(tmpdir(), "cli-install-origins-"));
  const a = await receiver();
  const b = await receiver();
  try {
    const config = join(dir, "config.json");
    const original = JSON.stringify({ memmyMemory: { storage: { endpoint: a.url } } });
    await writeFile(config, original);
    vi.stubEnv("MEMMY_MEMORY_URL", b.url);
    vi.stubEnv("MEMMY_MEMORY_TOKEN", "b-only");
    await expect(runCommand({ argv: [command, "--home", dir, "--config", config, "--endpoint", a.url,
      "--service-only", "--skip-legacy-migration", "--runtime-directory", join(dir, "unused")] }))
      .rejects.toThrow(/requires a (credential|token)/);
    expect(await readFile(config, "utf8")).toBe(original);
    expect(a.seen).toEqual([]);
    expect(b.seen).toEqual([]);
    await runCommand({ argv: ["health", "--config", config] });
    expect(b.seen).toEqual(["Bearer b-only"]);
    vi.stubEnv("MEMMY_MEMORY_URL", undefined);
    vi.stubEnv("MEMMY_MEMORY_TOKEN", undefined);
    await runCommand({ argv: ["health", "--config", config] });
    expect(a.seen).toEqual([undefined]);

    // An explicit token for A must still work, even with B's pair in the shell.
    vi.stubEnv("MEMMY_MEMORY_URL", b.url);
    vi.stubEnv("MEMMY_MEMORY_TOKEN", "b-only");
    const runtime = join(dir, "runtime");
    await mkdir(join(runtime, "dist/src/server"), { recursive: true });
    await writeFile(join(runtime, "dist/src/server/index.js"), "// fixture");
    await writeFile(join(runtime, "memory-runtime.json"), JSON.stringify({
      version: "2.1.0", target: runtimeTarget(process.platform, process.arch), protocolVersion: 1
    }));
    await runCommand({ argv: [command, "--home", dir, "--config", config, "--endpoint", a.url, "--token", "a-only",
      "--service-only", "--skip-service-registration", "--skip-legacy-migration", "--runtime-directory", runtime] });
    expect(a.seen.slice(1)).toEqual([undefined, undefined, "Bearer a-only"]);
    expect(JSON.parse(await readFile(config, "utf8")).memmyMemory.storage).toMatchObject({ endpoint: a.url, token: "a-only" });
  } finally {
    await Promise.all([a.close(), b.close(), rm(dir, { recursive: true, force: true })]);
  }
});
