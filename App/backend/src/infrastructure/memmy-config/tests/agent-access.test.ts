import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryScanPreferencesStore,
  ensureMemoryScanPreferences,
  readMemoryScanPreferences
} from "../agent-access.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("memmyMemory agent access preferences", () => {
  it("migrates legacy Desktop preferences without replacing existing Memory fields", async () => {
    const path = fixture({
      memmyMemory: {
        summary: { model: "keep-me" },
        agentAccess: { autoScanKnownAgents: false }
      }
    });
    await ensureMemoryScanPreferences(path, {
      autoScanKnownAgents: true,
      watchFileChanges: false,
      autoInjectSkill: true
    });

    const raw = YAML.parse(readFileSync(path, "utf8")) as any;
    expect(raw.memmyMemory.summary.model).toBe("keep-me");
    expect(raw.memmyMemory.agentAccess).toEqual({
      autoScanKnownAgents: false,
      watchFileChanges: false,
      autoInjectSkill: true
    });
  });

  it("reads and patches the same preferences used by the Viewer", async () => {
    const path = fixture({ memmyMemory: {} });
    await ensureMemoryScanPreferences(path, {
      autoScanKnownAgents: true,
      watchFileChanges: true,
      autoInjectSkill: false
    });
    const store = createMemoryScanPreferencesStore(path);
    await store.updateScanPreferences({ watchFileChanges: false, autoInjectSkill: true });

    expect(store.getScanPreferences()).toEqual({
      autoScanKnownAgents: true,
      watchFileChanges: false,
      autoInjectSkill: true
    });
    expect(readMemoryScanPreferences(path)).toEqual(store.getScanPreferences());
  });
});

function fixture(content: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "memmy-agent-access-"));
  roots.push(root);
  const path = join(root, "config.yaml");
  writeFileSync(path, YAML.stringify(content));
  return path;
}
