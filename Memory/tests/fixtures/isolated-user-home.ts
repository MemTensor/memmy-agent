import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

const isolatedUser = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const { join } = await import("node:path");
  return { home: mkdtempSync(join(tmpdir(), "pr780-http-contract-home-")) };
});

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => isolatedUser.home
}));

beforeEach(() => {
  for (const name of ["HOME", "USERPROFILE"]) vi.stubEnv(name, isolatedUser.home);
  for (const [name, directory] of Object.entries({ CODEX_HOME: ".codex", CLAUDE_CONFIG_DIR: ".claude", XDG_CONFIG_HOME: ".config", HERMES_HOME: ".hermes", OPENCLAW_STATE_DIR: ".openclaw" })) vi.stubEnv(name, join(isolatedUser.home, directory));

  expect(homedir()).toBe(isolatedUser.home);
  const memmyHome = join(isolatedUser.home, ".memmy");
  mkdirSync(memmyHome, { recursive: true });
  writeFileSync(join(memmyHome, "config.yaml"), JSON.stringify({ memmyMemory: {
    agentAccess: { autoScanKnownAgents: false, autoInjectSkill: false, watchFileChanges: false }
  } }));
  vi.stubEnv("MEMMY_HOME", memmyHome);
  vi.stubEnv("MEMMY_CONFIG", join(memmyHome, "config.yaml"));
  vi.stubEnv("MEMMY_MEMORY_HOME", join(memmyHome, "memory-service"));
  vi.stubEnv("MEMMY_CLOUD_SERVICE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(isolatedUser.home, { recursive: true, force: true });
});
afterAll(() => rmSync(isolatedUser.home, { recursive: true, force: true }));
