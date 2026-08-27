import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { ModelCatalogWatcher } from "../../src/providers/model-catalog-watcher.js";

const roots: string[] = [];
const watchers: ModelCatalogWatcher[] = [];

function fixture(): { root: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-model-watcher-"));
  roots.push(root);
  const configPath = path.join(root, "config.yaml");
  writeConfig(configPath, "model-a");
  return { root, configPath };
}

function writeConfig(configPath: string, model: string): void {
  fs.writeFileSync(configPath, YAML.stringify({
    app: { userMode: "byok" },
    agents: { defaults: { modelPreset: "work" } },
    providers: {
      openai: {
        apiKey: "sk-test",
        endpoints: {
          chat: {
            apiBase: "https://api.example.com/v1",
            protocol: "openai-chat-completions",
          },
        },
      },
    },
    modelPresets: {
      work: {
        provider: "openai",
        endpoint: "chat",
        model,
        source: "byok",
        capabilities: ["agent"],
      },
    },
    modelAssignments: {
      byok: { agent: { candidates: ["work"], default: "work" } },
      account: {},
    },
  }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("ModelCatalogWatcher", () => {
  it("coalesces rapid writes and publishes only the latest valid catalog", async () => {
    const { configPath } = fixture();
    const onChange = vi.fn();
    const watcher = new ModelCatalogWatcher(configPath, onChange);
    watchers.push(watcher);

    fs.writeFileSync(configPath, "modelPresets: [");
    (watcher as any).schedule();
    await new Promise((resolve) => setTimeout(resolve, 180));
    writeConfig(configPath, "model-b");
    writeConfig(configPath, "model-c");
    (watcher as any).schedule();

    await waitFor(() => onChange.mock.calls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("ignores config changes outside the text-model catalog", async () => {
    const { configPath } = fixture();
    const onChange = vi.fn();
    const watcher = new ModelCatalogWatcher(configPath, onChange);
    watchers.push(watcher);

    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
    parsed.tools = { webSearch: { enabled: false } };
    fs.writeFileSync(configPath, YAML.stringify(parsed));
    (watcher as any).schedule();

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("publishes assignment and mode changes even when Provider definitions are unchanged", async () => {
    const { configPath } = fixture();
    const onChange = vi.fn();
    const watcher = new ModelCatalogWatcher(configPath, onChange);
    watchers.push(watcher);

    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8"));
    parsed.modelAssignments.byok.agent = { candidates: [], default: null };
    fs.writeFileSync(configPath, YAML.stringify(parsed));
    (watcher as any).schedule();

    await waitFor(() => onChange.mock.calls.length === 1);
    expect(onChange.mock.calls[0]?.[0]).toBe("ready");
  });

  it("publishes an invalid state after transient-read retries are exhausted", async () => {
    const { configPath } = fixture();
    const onChange = vi.fn();
    const watcher = new ModelCatalogWatcher(configPath, onChange);
    watchers.push(watcher);

    fs.writeFileSync(configPath, "modelPresets: [");
    (watcher as any).schedule();

    await waitFor(() => onChange.mock.calls.length === 1);
    expect(onChange).toHaveBeenCalledWith("invalid", "invalid");
  });
});
