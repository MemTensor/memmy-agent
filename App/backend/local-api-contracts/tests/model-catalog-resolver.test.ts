import { describe, expect, it } from "vitest";
import {
  resolveAssignedModel,
  type RuntimeModelCatalog
} from "../src/index.js";

function catalog(): RuntimeModelCatalog {
  return {
    providers: {
      dashscope: {
        apiKey: "provider-key",
        extraHeaders: { shared: "provider", provider: "yes" },
        extraBody: { nested: { provider: true }, shared: { from: "provider" } },
        endpoints: {
          asr: {
            apiBase: "https://dashscope.example/v1",
            protocol: "dashscope-input-audio-chat",
            apiKey: "endpoint-key",
            extraHeaders: { shared: "endpoint" },
            extraBody: { shared: { from: "endpoint" }, nestedArray: [{ stable: true }] }
          }
        }
      },
      memmy_account: {
        apiKey: "account-key",
        ownerAccountId: "account-a",
        endpoints: {
          memory: {
            apiBase: "https://account.example/v1",
            protocol: "memmy-account"
          }
        }
      }
    },
    modelPresets: {
      "byok-asr": {
        provider: "dashscope",
        endpoint: "asr",
        model: "qwen3-asr-flash",
        source: "byok",
        capabilities: ["asr"]
      },
      "account-summary": {
        provider: "memmy_account",
        endpoint: "memory",
        model: "summary",
        source: "account",
        ownerAccountId: "account-a",
        capabilities: ["memory_summary"]
      }
    },
    modelAssignments: {
      byok: {
        asr: "byok-asr"
      },
      account: {
        ownerAccountId: "account-a",
        memorySummary: "account-summary"
      }
    }
  };
}

describe("resolveAssignedModel", () => {
  it("resolves the exact endpoint and applies endpoint credential overrides", () => {
    const resolved = resolveAssignedModel({
      catalog: catalog(),
      mode: "byok",
      capability: "asr"
    });

    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      context: expect.objectContaining({
        presetId: "byok-asr",
        endpointId: "asr",
        protocol: "dashscope-input-audio-chat"
      }),
      provider: expect.objectContaining({
        apiBase: "https://dashscope.example/v1",
        apiKey: "endpoint-key",
        extraHeaders: { shared: "endpoint", provider: "yes" }
      })
    }));
    expect(Object.isFrozen(resolved)).toBe(true);
    if (resolved.ok) {
      expect(Object.isFrozen(resolved.context.capabilities)).toBe(true);
      expect(Object.isFrozen(resolved.provider.extraHeaders)).toBe(true);
      expect(Object.isFrozen(resolved.provider.extraBody)).toBe(true);
      expect(Object.isFrozen(resolved.provider.extraBody.shared)).toBe(true);
      expect(Object.isFrozen(resolved.provider.extraBody.nestedArray)).toBe(true);
      expect(Object.isFrozen((resolved.provider.extraBody.nestedArray as unknown[])[0])).toBe(true);
      expect(resolved.provider.extraBody).toEqual({
        nested: { provider: true },
        shared: { from: "endpoint" },
        nestedArray: [{ stable: true }]
      });
    }
  });

  it("does not fall back when an explicit preset is unassigned", () => {
    expect(resolveAssignedModel({
      catalog: catalog(),
      mode: "byok",
      capability: "asr",
      requestedPreset: "account-summary"
    })).toEqual({ ok: false, code: "model_selection_unavailable" });
  });

  it("accepts a BYOK committed selection with an explicit null owner", () => {
    const resolved = resolveAssignedModel({
      catalog: catalog(),
      mode: "byok",
      capability: "asr",
      committedSelection: {
        presetId: "byok-asr",
        source: "byok",
        ownerAccountId: null
      }
    });

    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      context: expect.objectContaining({ ownerAccountId: null })
    }));
  });

  it("lets an assigned explicit request replace a previous committed selection", () => {
    const current = catalog();
    current.providers!.dashscope!.endpoints!.chat = {
      apiBase: "https://dashscope.example/v1",
      protocol: "openai-chat-completions"
    };
    current.modelPresets!["byok-agent"] = {
      provider: "dashscope",
      endpoint: "chat",
      model: "qwen-plus",
      source: "byok",
      capabilities: ["agent"]
    };
    current.modelAssignments!.byok!.agent = {
      candidates: ["byok-agent"],
      default: "byok-agent"
    };
    const resolved = resolveAssignedModel({
      catalog: current,
      mode: "byok",
      capability: "agent",
      requestedPreset: "byok-agent",
      committedSelection: {
        presetId: "old-preset",
        source: "byok",
        ownerAccountId: null
      }
    });

    expect(resolved).toEqual(expect.objectContaining({
      ok: true,
      context: expect.objectContaining({ presetId: "byok-agent" })
    }));
  });

  it("keeps account assignments dormant for another or missing account", () => {
    for (const activeAccountId of [undefined, "account-b"]) {
      expect(resolveAssignedModel({
        catalog: catalog(),
        mode: "account",
        activeAccountId,
        capability: "memory_summary"
      })).toEqual({ ok: false, code: "model_selection_unavailable" });
    }
  });

  it("rejects a committed selection with a forged owner even when the preset id exists", () => {
    expect(resolveAssignedModel({
      catalog: catalog(),
      mode: "account",
      activeAccountId: "account-a",
      capability: "memory_summary",
      committedSelection: {
        presetId: "account-summary",
        source: "account",
        ownerAccountId: "account-b"
      }
    })).toEqual({ ok: false, code: "model_selection_unavailable" });
  });

  it("fails closed for malformed raw catalog shapes", () => {
    for (const mutate of [
      (current: any) => { current.modelPresets["byok-asr"].capabilities = "asr"; },
      (current: any) => { current.providers.dashscope.endpoints.asr = "not-an-endpoint"; },
      (current: any) => { current.modelAssignments.byok.asr = { preset: "byok-asr" }; }
    ]) {
      const current = catalog() as any;
      mutate(current);
      expect(() => resolveAssignedModel({
        catalog: current,
        mode: "byok",
        capability: "asr"
      })).not.toThrow();
      expect(resolveAssignedModel({
        catalog: current,
        mode: "byok",
        capability: "asr"
      })).toEqual({ ok: false, code: "model_selection_unavailable" });
    }
  });

  it("rejects a capability-compatible preset wired to an incompatible endpoint protocol", () => {
    const current = catalog();
    current.providers!.dashscope!.endpoints!.asr!.protocol = "openai-chat-completions";
    expect(resolveAssignedModel({
      catalog: current,
      mode: "byok",
      capability: "asr"
    })).toEqual({ ok: false, code: "model_selection_unavailable" });
  });

  it("rejects Responses presets for Memory capabilities until a Responses adapter exists", () => {
    const current = catalog() as any;
    current.providers.dashscope.endpoints.asr.protocol = "openai-responses";
    current.modelPresets["byok-asr"].capabilities = ["memory_summary"];
    current.modelAssignments.byok = { memorySummary: "byok-asr" };

    expect(resolveAssignedModel({
      catalog: current,
      mode: "byok",
      capability: "memory_summary"
    })).toEqual({ ok: false, code: "model_selection_unavailable" });
  });
});
