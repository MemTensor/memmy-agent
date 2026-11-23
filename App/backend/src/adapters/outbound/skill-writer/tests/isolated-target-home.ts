import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";

const isolatedUser = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await vi.importActual<typeof import("node:os")>("node:os");
  const { join } = await import("node:path");
  return { home: mkdtempSync(join(tmpdir(), "pr780-native-target-home-")) };
});

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  homedir: () => isolatedUser.home
}));

beforeEach(() => {
  // Guard before executing a target that could read its default user directory.
  expect(homedir()).toBe(isolatedUser.home);
  const memmyHome = join(isolatedUser.home, ".memmy");
  mkdirSync(memmyHome, { recursive: true });
  writeFileSync(join(memmyHome, "config.yaml"), "{}\n");
  vi.stubEnv("MEMMY_HOME", memmyHome);
  vi.stubEnv("MEMMY_CONFIG", join(memmyHome, "config.yaml"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(isolatedUser.home, { recursive: true, force: true });
});
afterAll(() => rmSync(isolatedUser.home, { recursive: true, force: true }));
