import { mkdtemp, readFile, rm, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import YAML from "yaml";
import { ensureLocalMemoryToken } from "../src/config/local-token.js";
import { loadMemmyConfig } from "../src/config/index.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-auth-config-")); roots.push(root);
  vi.stubEnv("MEMMY_MEMORY_TOKEN", ""); vi.stubEnv("MEMORY_SERVICE_TOKEN", "");
  return join(root, "config.yaml");
}
it("concurrent initializers persist one credential and preserve unrelated configuration", async () => {
  const path = await fixture();
  await writeFile(path, YAML.stringify({ unrelated: { preserve: true }, memmyMemory: { storage: { future: 42 } } }));
  const tokens = await Promise.all(Array.from({ length: 5 }, () => ensureLocalMemoryToken(path)));
  expect(new Set(tokens).size).toBe(1); expect(tokens[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(loadMemmyConfig(path).config.storage.token).toBe(tokens[0]);
  expect(YAML.parse(await readFile(path, "utf8"))).toMatchObject({ unrelated: { preserve: true }, memmyMemory: { storage: { future: 42 } } });
  expect(await ensureLocalMemoryToken(path)).toBe(tokens[0]);
  if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
});
it("uses an explicit environment credential without overwriting configuration", async () => {
  const path = await fixture(); const original = "memmyMemory:\n  storage:\n    token: existing\n";
  await writeFile(path, original); vi.stubEnv("MEMMY_MEMORY_TOKEN", "environment-secret");
  expect(await ensureLocalMemoryToken(path)).toBe("environment-secret");
  expect(await readFile(path, "utf8")).toBe(original);
});
it("ignores empty environment credentials and preserves an existing token", async () => {
  const path = await fixture(); await writeFile(path, "memmyMemory:\n  storage:\n    token: existing\n");
  vi.stubEnv("MEMMY_MEMORY_TOKEN", "   ");
  expect(await ensureLocalMemoryToken(path)).toBe("existing");
});
it("fails when the configuration cannot be persisted", async () => {
  const path = await fixture(); await mkdir(path);
  await expect(ensureLocalMemoryToken(path)).rejects.toThrow();
});

it("shares the install token with a launcher that does not inherit the terminal environment", async () => {
  const path = await fixture();
  vi.stubEnv("MEMMY_MEMORY_TOKEN", "terminal-credential");
  await ensureLocalMemoryToken(path, true);
  vi.stubEnv("MEMMY_MEMORY_TOKEN", "");
  expect(await ensureLocalMemoryToken(path)).toBe("terminal-credential");
  vi.stubEnv("MEMMY_MEMORY_TOKEN", "different-credential");
  await expect(ensureLocalMemoryToken(path, true)).rejects.toThrow("match the shared config");
});
