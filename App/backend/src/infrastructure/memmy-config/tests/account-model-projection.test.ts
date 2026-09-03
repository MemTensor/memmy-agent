import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearAccountModelProjectionFromMemmyConfig,
  readModelConfigCatalog,
  writeModelConfigCatalog,
  writeAccountModelProjectionToMemmyConfig
} from "../index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configFile(config: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memmy-account-catalog-"));
  roots.push(root);
  const file = join(root, "config.yaml");
  await writeFile(file, YAML.stringify(config), "utf8");
  return file;
}

async function readConfig(file: string): Promise<any> {
  return YAML.parse(await readFile(file, "utf8"));
}

function accountId(owner: string, capability: string): string {
  const hash = createHash("sha256").update(owner).digest("hex").slice(0, 12);
  return `memmy-account-${hash}-${capability.replaceAll("_", "-")}`;
}

function currentByokCatalog(): Record<string, unknown> {
  return {
    futureSection: { keepMe: true },
    providers: {
      openai: {
        apiKey: "byok-secret",
        futureProviderField: "keep-provider",
        endpoints: {
          chat: { apiBase: "https://api.example.test/v1", protocol: "openai-chat-completions" }
        }
      }
    },
    modelPresets: {
      byokAgent: {
        provider: "openai", endpoint: "chat", model: "gpt-5", source: "byok", capabilities: ["agent"]
      },
      byokAgent2: {
        provider: "openai", endpoint: "chat", model: "gpt-5.1", source: "byok", capabilities: ["agent"]
      },
      byokUnchecked: {
        provider: "openai", endpoint: "chat", model: "gpt-4.1", source: "byok", capabilities: ["agent"]
      },
      byokSummary: {
        provider: "openai", endpoint: "chat", model: "gpt-5-mini", source: "byok", capabilities: ["memory_summary"]
      }
    },
    modelAssignments: {
      byok: {
        agent: { candidates: ["byokAgent"], default: "byokAgent" },
        memorySummary: "byokSummary",
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null
      },
      account: {
        ownerAccountId: "previous-owner",
        agent: { candidates: ["byokAgent"], default: "byokAgent" },
        memorySummary: "byokSummary",
        memoryEvolution: null,
        embedding: null,
        asr: null,
        imageGeneration: null,
        futureAssignmentField: "keep-assignment"
      }
    },
    agents: { defaults: { modelPreset: "byokAgent", timezone: "+08:00" } }
  };
}

describe("account model projection current catalog", () => {
  it("creates an owner-scoped Provider, endpoint, six presets, and isolated assignment", async () => {
    const file = await configFile(currentByokCatalog());
    const beforeByok = (await readConfig(file)).modelAssignments.byok;

    const result = await writeAccountModelProjectionToMemmyConfig({
      cloudUuid: "cloud-token",
      userId: "owner-a"
    }, file);

    expect(result).toEqual({ changed: true, memoryConfigAffected: false });
    const saved = await readConfig(file);
    expect(saved.providers.memmy_account).toMatchObject({
      ownerAccountId: "owner-a",
      apiKey: "cloud-token",
      endpoints: {
        platform: {
          apiBase: expect.stringContaining("/api/agentExternal/v1"),
          protocol: "memmy-account"
        }
      }
    });
    expect(saved.providers.memmy_account).not.toHaveProperty("apiBase");
    for (const capability of ["agent", "memory_summary", "memory_evolution", "embedding", "asr", "image_generation"]) {
      expect(saved.modelPresets[accountId("owner-a", capability)]).toMatchObject({
        provider: "memmy_account",
        endpoint: "platform",
        source: "account",
        ownerAccountId: "owner-a",
        capabilities: [capability]
      });
    }
    expect(saved.modelAssignments.byok).toEqual(beforeByok);
    expect(saved.modelAssignments.account).toMatchObject({
      ownerAccountId: "owner-a",
      agent: {
        candidates: [accountId("owner-a", "agent"), "byokAgent"],
        default: "byokAgent"
      },
      memorySummary: "byokSummary",
      memoryEvolution: accountId("owner-a", "memory_evolution"),
      futureAssignmentField: "keep-assignment"
    });
    expect(saved.futureSection.keepMe).toBe(true);
    expect(saved.providers.openai.futureProviderField).toBe("keep-provider");
  });

  it("synchronizes the account BYOK candidates from the current local selection on every login", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokAgent2", "byokAgent2", "byokAgent"],
      default: "byokAgent2"
    };
    initial.modelAssignments.account.agent = {
      candidates: ["byokUnchecked", "byokAgent"],
      default: "byokUnchecked"
    };
    const file = await configFile(initial);
    const beforeByok = (await readConfig(file)).modelAssignments.byok;

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const afterFirstLogin = await readConfig(file);
    expect(afterFirstLogin.modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent"), "byokAgent2", "byokAgent"],
      default: accountId("owner-a", "agent")
    });
    expect(afterFirstLogin.modelAssignments.byok).toEqual(beforeByok);

    afterFirstLogin.modelAssignments.byok.agent = {
      candidates: ["byokUnchecked"],
      default: "byokUnchecked"
    };
    await writeFile(file, YAML.stringify(afterFirstLogin), "utf8");

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const afterSecondLogin = await readConfig(file);
    expect(afterSecondLogin.modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent"), "byokUnchecked"],
      default: accountId("owner-a", "agent")
    });
    expect(afterSecondLogin.modelAssignments.byok.agent).toEqual({
      candidates: ["byokUnchecked"],
      default: "byokUnchecked"
    });
  });

  it("switches owners without reviving the previous owner's platform definitions", async () => {
    const file = await configFile(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);
    const afterA = await readConfig(file);
    const beforeByok = afterA.modelAssignments.byok;

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-b", userId: "owner-b" }, file);
    const afterB = await readConfig(file);
    expect(afterB.modelPresets[accountId("owner-a", "agent")]).toBeUndefined();
    expect(afterB.modelPresets[accountId("owner-b", "agent")]).toBeDefined();
    expect(afterB.providers.memmy_account.ownerAccountId).toBe("owner-b");
    expect(afterB.modelAssignments.account.ownerAccountId).toBe("owner-b");
    expect(afterB.modelAssignments.byok).toEqual(beforeByok);

    await expect(writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-b", userId: "owner-b" }, file))
      .resolves.toEqual({ changed: false, memoryConfigAffected: false });
  });

  it("logout removes account definitions but leaves both assignment namespaces byte-equivalent", async () => {
    const file = await configFile(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);
    const before = await readConfig(file);

    const result = await clearAccountModelProjectionFromMemmyConfig(file);
    const after = await readConfig(file);
    expect(result).toEqual({ changed: true, memoryConfigAffected: false });
    expect(after.providers.memmy_account).toBeUndefined();
    expect(Object.values(after.modelPresets).some((preset: any) => preset.source === "account")).toBe(false);
    expect(after.modelAssignments.account).toEqual(before.modelAssignments.account);
    expect(after.modelAssignments.byok).toEqual(before.modelAssignments.byok);
    expect(after.app?.cloudUuid).toBeUndefined();
    expect(after.app?.userId).toBeUndefined();
  });

  it("manual logout synchronizes every selected account BYOK candidate back to local mode", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokAgent"],
      default: "byokAgent"
    };
    initial.app = {
      accountByokLocalSelectionBaseline: {
        ownerAccountId: "owner-a",
        candidates: ["byokAgent"]
      }
    };
    const file = await configFile(initial);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedIn = await readConfig(file);
    loggedIn.modelAssignments.account.agent = {
      candidates: [
        accountId("owner-a", "agent"),
        "byokAgent2",
        "byokAgent2",
        "byokAgent"
      ],
      default: "byokAgent2"
    };
    await writeFile(file, YAML.stringify(loggedIn), "utf8");

    await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true
    });

    const loggedOut = await readConfig(file);
    expect(loggedOut.modelAssignments.byok.agent).toEqual({
      candidates: ["byokAgent2", "byokAgent"],
      default: "byokAgent"
    });

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);
    const loggedInAgain = await readConfig(file);
    expect(loggedInAgain.modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent"), "byokAgent2", "byokAgent"],
      default: "byokAgent2"
    });
  });

  it("synchronizes the logout fallback into account mode after all account BYOK models were cleared", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokAgent"],
      default: "byokAgent"
    };
    const file = await configFile(initial);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedIn = await readConfig(file);
    loggedIn.modelAssignments.account.agent = {
      candidates: [accountId("owner-a", "agent")],
      default: accountId("owner-a", "agent")
    };
    await writeFile(file, YAML.stringify(loggedIn), "utf8");

    await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true
    });

    const loggedOut = await readConfig(file);
    expect(loggedOut.modelAssignments.byok.agent).toEqual({
      candidates: ["byokAgent"],
      default: "byokAgent"
    });
    expect(loggedOut.app?.accountByokLocalSelectionBaseline).toBeUndefined();

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);
    const loggedInAgain = await readConfig(file);
    expect(loggedInAgain.modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent"), "byokAgent"],
      default: accountId("owner-a", "agent")
    });

    await expect(writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file))
      .resolves.toEqual({ changed: false, memoryConfigAffected: false });
    expect((await readConfig(file)).modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent"), "byokAgent"],
      default: accountId("owner-a", "agent")
    });
  });

  it("synchronizes a local selection changed after an account selected no BYOK model", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokAgent2", "byokAgent"],
      default: "byokAgent2"
    };
    const file = await configFile(initial);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedIn = await readConfig(file);
    loggedIn.modelAssignments.account.agent = {
      candidates: [accountId("owner-a", "agent")],
      default: accountId("owner-a", "agent")
    };
    await writeFile(file, YAML.stringify(loggedIn), "utf8");

    await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true
    });
    const localView = await readModelConfigCatalog(file);
    const locallyChangedAssignments = structuredClone(localView.modelAssignments);
    locallyChangedAssignments.byok.agent = {
      candidates: ["byokUnchecked"],
      default: "byokUnchecked"
    };
    await writeModelConfigCatalog(file, {
      configRevision: localView.configRevision,
      providers: localView.providers,
      modelAssignments: locallyChangedAssignments
    });

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedInAgain = await readConfig(file);
    expect(loggedInAgain.modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent"), "byokUnchecked"],
      default: accountId("owner-a", "agent")
    });
  });

  it("synchronizes a local selection cleared after an account selected no BYOK model", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokAgent2", "byokAgent"],
      default: "byokAgent2"
    };
    const file = await configFile(initial);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedIn = await readConfig(file);
    loggedIn.modelAssignments.account.agent = {
      candidates: [accountId("owner-a", "agent")],
      default: accountId("owner-a", "agent")
    };
    await writeFile(file, YAML.stringify(loggedIn), "utf8");
    await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true
    });

    const localView = await readModelConfigCatalog(file);
    const locallyChangedAssignments = structuredClone(localView.modelAssignments);
    locallyChangedAssignments.byok.agent = { candidates: [], default: null };
    await writeModelConfigCatalog(file, {
      configRevision: localView.configRevision,
      providers: localView.providers,
      modelAssignments: locallyChangedAssignments
    });

    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedInAgain = await readConfig(file);
    expect(loggedInAgain.modelAssignments.byok.agent).toEqual({ candidates: [], default: null });
    expect(loggedInAgain.modelAssignments.account.agent).toEqual({
      candidates: [accountId("owner-a", "agent")],
      default: accountId("owner-a", "agent")
    });
  });

  it("manual logout keeps a still-selected local default when the account default is platform", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokAgent", "byokUnchecked"],
      default: "byokAgent"
    };
    const file = await configFile(initial);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedIn = await readConfig(file);
    loggedIn.modelAssignments.account.agent = {
      candidates: [accountId("owner-a", "agent"), "byokAgent2", "byokAgent"],
      default: accountId("owner-a", "agent")
    };
    await writeFile(file, YAML.stringify(loggedIn), "utf8");

    await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true
    });

    expect((await readConfig(file)).modelAssignments.byok.agent).toEqual({
      candidates: ["byokAgent2", "byokAgent"],
      default: "byokAgent"
    });
  });

  it("manual logout falls back to the first selected local model when neither prior default remains", async () => {
    const initial = currentByokCatalog() as any;
    initial.modelAssignments.byok.agent = {
      candidates: ["byokUnchecked"],
      default: "byokUnchecked"
    };
    const file = await configFile(initial);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-a", userId: "owner-a" }, file);

    const loggedIn = await readConfig(file);
    loggedIn.modelAssignments.account.agent = {
      candidates: [accountId("owner-a", "agent"), "byokAgent2", "byokAgent"],
      default: accountId("owner-a", "agent")
    };
    await writeFile(file, YAML.stringify(loggedIn), "utf8");

    await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true
    });

    expect((await readConfig(file)).modelAssignments.byok.agent).toEqual({
      candidates: ["byokAgent2", "byokAgent"],
      default: "byokAgent2"
    });
  });

  it("does not clear or synchronize a newer projection for the same account", async () => {
    const file = await configFile(currentByokCatalog());
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-old", userId: "owner-a" }, file);
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "token-new", userId: "owner-a" }, file);
    const beforeLateLogout = await readConfig(file);

    const result = await clearAccountModelProjectionFromMemmyConfig(file, {
      ownerAccountId: "owner-a",
      syncSelectedByokToLocal: true,
      expectedCloudUuid: "token-old"
    });

    expect(result).toEqual({ changed: false, memoryConfigAffected: false });
    expect(await readConfig(file)).toEqual(beforeLateLogout);
  });

  it("does not expose the account identifier in deterministic preset IDs", async () => {
    const file = await configFile({});
    await writeAccountModelProjectionToMemmyConfig({ cloudUuid: "secret-token", userId: "person@example.test" }, file);
    const ids = Object.keys((await readConfig(file)).modelPresets);
    expect(ids).toHaveLength(6);
    expect(ids.every((id) => !id.includes("person") && !id.includes("example"))).toBe(true);
  });
});
