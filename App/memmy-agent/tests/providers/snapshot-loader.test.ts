import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { Config } from "../../src/config/schema.js";
import { buildProviderSnapshot } from "../../src/providers/factory.js";
import { makeReloadingProviderSnapshotLoader } from "../../src/providers/snapshot-loader.js";

const roots: string[] = [];

function tmpConfig(data: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-provider-snapshot-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("provider snapshot loader", () => {
  it("builds snapshots from standard provider and model config", () => {
    const snapshot = buildProviderSnapshot(
      new Config({
        agents: {
          defaults: {
            provider: "openai",
            model: "gpt-4o",
          },
        },
        providers: {
          openai: {
            apiKey: "sk-user",
            apiBase: "https://api.openai.com/v1",
            apiType: "chatCompletions",
          },
        },
      }),
    );

    expect(snapshot.model).toBe("gpt-4o");
    expect((snapshot.provider as any).spec?.name).toBe("openai");
  });

  it("reloads latest YAML for provider snapshots", () => {
    const configPath = tmpConfig({
      agents: {
        defaults: {
          provider: "memmy_account",
          model: "agent_chat",
        },
      },
      providers: {
        memmy_account: {
          apiKey: "cloud-login-uuid",
          apiBase: `${process.env.MEMMY_CLOUD_SERVICE}/api/agentExternal/v1`,
        },
      },
    });
    const loader = makeReloadingProviderSnapshotLoader({ configPath });

    const accountSnapshot = loader();
    fs.writeFileSync(
      configPath,
      YAML.stringify({
        agents: {
          defaults: {
            provider: "openai",
            model: "gpt-4o",
          },
        },
        providers: {
          openai: {
            apiKey: "sk-user",
            apiBase: "https://api.openai.com/v1",
            apiType: "chatCompletions",
          },
        },
      }),
      "utf8",
    );
    const byokSnapshot = loader();

    expect((accountSnapshot.provider as any).spec?.name).toBe("memmy_account");
    expect((byokSnapshot.provider as any).spec?.name).toBe("openai");
    expect(accountSnapshot.model).toBe("agent_chat");
    expect(byokSnapshot.model).toBe("gpt-4o");
    expect(accountSnapshot.signature).not.toEqual(byokSnapshot.signature);
  });
});
