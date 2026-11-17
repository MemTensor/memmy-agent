/** Asr service tests. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import { createAsrService } from "../asr-service.js";

describe("asr service", () => {
  it.each(["account", "byok"] as const)("prepares %s recordings without adding BYOK realtime support", async mode => {
    const fixture = catalogFixture(mode);
    try {
      const service = createAsrService({
        bootstrapRepository: { getAppSettings: () => ({ userMode: mode }) },
        accountSessionRepository: {
          get: () => ({ authenticated: true, profile: { userId: "owner-a" } }) as any,
          getCloudUuid: () => "pinned-account-token"
        },
        memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
        cloudClient: { transcribeAudio: async () => { throw new Error("no HTTP call during preparation"); } }
      });
      const prepared = await service.prepare();
      expect(prepared.transport).toBe(mode === "account" ? "websocket" : "http");
      expect(service.getSession(prepared.sessionId).context.source).toBe(mode);
      service.release(prepared.sessionId);
      expect(() => service.getSession(prepared.sessionId)).toThrow("expired");
    } finally { fixture.dispose(); }
  });

  it.each(["account-b", null])("keeps the original account credential after switching to %s", async next => {
    const fixture = catalogFixture("account");
    let token: string | null = "account-a";
    const uploads: string[] = [];
    try {
      const service = createAsrService({
        bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
        accountSessionRepository: {
          get: () => ({ authenticated: true, profile: { userId: "owner-a" } }) as any,
          getCloudUuid: () => token
        },
        memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
        cloudClient: { transcribeAudio: async input => { uploads.push(input.uuid); return { text: "done", modelId: "account-asr", provider: "memmy_account" }; } }
      });
      const session = await service.prepare();
      token = next;
      await service.transcribe({ sessionId: session.sessionId, audioBase64: "AQ==", mimeType: "audio/wav" });
      expect(uploads).toEqual(["account-a"]);
    } finally { fixture.dispose(); }
  });

  it("does not borrow a later login when the prepared session had no account credential", async () => {
    const fixture = catalogFixture("account");
    let token: string | null = null;
    let uploaded = false;
    try {
      const service = createAsrService({
        bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
        accountSessionRepository: {
          get: () => ({ authenticated: true, profile: { userId: "owner-a" } }) as any,
          getCloudUuid: () => token
        },
        memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
        cloudClient: { transcribeAudio: async () => { uploaded = true; return { text: "wrong account", modelId: "account-asr", provider: "memmy_account" }; } }
      });
      const session = await service.prepare(); token = "account-b";
      await expect(service.transcribe({ sessionId: session.sessionId, audioBase64: "AQ==", mimeType: "audio/wav" }))
        .rejects.toMatchObject({ code: "unauthorized" });
      expect(uploaded).toBe(false);
    } finally { fixture.dispose(); }
  });

  it("keeps BYOK on HTTP when it is selected in account mode", async () => {
    const fixture = catalogFixture("account");
    try {
      const config = YAML.parse(readFileSync(fixture.configPath, "utf8"));
      config.modelAssignments.account.asr = "byok-asr";
      writeFileSync(fixture.configPath, YAML.stringify(config));
      const service = createAsrService({
        bootstrapRepository: { getAppSettings: () => ({ userMode: "account" }) },
        accountSessionRepository: {
          get: () => ({ authenticated: true, profile: { userId: "owner-a" } }) as any,
          getCloudUuid: () => "account-token"
        },
        memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
        cloudClient: { transcribeAudio: async () => { throw new Error("no cloud HTTP call"); } }
      });
      expect((await service.prepare()).transport).toBe("http");
    } finally { fixture.dispose(); }
  });

  it("transcribes BYOK audio with qwen3-asr-flash through DashScope OpenAI-compatible API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fixture = catalogFixture("byok");
    const service = createAsrService({
      bootstrapRepository: {
        getAppSettings: () => ({ userMode: "byok" })
      },
      accountSessionRepository: {
        get: () => ({ authenticated: false }) as any,
        getCloudUuid: () => null
      },
      memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
      cloudClient: {
        transcribeAudio: async () => {
          throw new Error("cloud path should not be used");
        }
      },
      fetch: async (input, init) => {
        calls.push({ url: input.toString(), init: init ?? {} });
        return new Response(JSON.stringify({ choices: [{ message: { content: "你好，Memmy" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      },
      now: () => "2026-06-15T10:00:00.000Z"
    });

    const result = await service.transcribe({ audioBase64: "UklGRg==", mimeType: "audio/wav", durationMs: 1200 });

    expect(result).toEqual({
      text: "你好，Memmy",
      modelId: "qwen3-asr-flash",
      provider: "dashscope",
      source: "byok",
      transcribedAt: "2026-06-15T10:00:00.000Z"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer endpoint-secret",
      "x-endpoint-auth": "endpoint",
      "content-type": "application/json"
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: "qwen3-asr-flash",
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: "data:audio/wav;base64,UklGRg=="
              }
            }
          ]
        }
      ],
      asr_options: {
        enable_itn: false
      },
      language_hints: ["zh", "en"]
    });
    fixture.dispose();
  });

  it("transcribes account-mode audio through Playground cloud service without local ASR key", async () => {
    const fixture = catalogFixture("account");
    const service = createAsrService({
      bootstrapRepository: {
        getAppSettings: () => ({ userMode: "account" })
      },
      accountSessionRepository: {
        get: () => ({ authenticated: true, profile: { userId: "owner-a" } }) as any,
        getCloudUuid: () => "cloud-login-jwt"
      },
      memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
      cloudClient: {
        transcribeAudio: async (input) => ({
          text: `${input.audioBase64}:云端识别`,
          modelId: "qwen3-asr-flash",
          provider: "aliyun"
        })
      },
      fetch: async () => {
        throw new Error("direct fetch should not be used");
      },
      now: () => "2026-06-15T10:05:00.000Z"
    });

    await expect(
      service.transcribe({
        audioBase64: "BASE64",
        mimeType: "audio/webm",
        durationMs: 800
      })
    ).resolves.toEqual({
      text: "BASE64:云端识别",
      modelId: "account-asr",
      provider: "memmy_account",
      source: "account",
      transcribedAt: "2026-06-15T10:05:00.000Z"
    });
    fixture.dispose();
  });

  it("attaches the exact resolved BYOK model context to provider errors", async () => {
    const fixture = catalogFixture("byok");
    const service = createAsrService({
      bootstrapRepository: {
        getAppSettings: () => ({ userMode: "byok" })
      },
      accountSessionRepository: {
        get: () => ({ authenticated: false }) as any,
        getCloudUuid: () => null
      },
      memmyConfigWriter: createMemmyConfigWriter({ configPath: fixture.configPath }),
      cloudClient: {
        transcribeAudio: async () => {
          throw new Error("cloud path should not be used");
        }
      },
      fetch: async () => new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    });

    await expect(service.transcribe({
      audioBase64: "UklGRg==",
      mimeType: "audio/wav",
      durationMs: 1200
    })).rejects.toMatchObject({
      message: "invalid api key",
      code: "forbidden",
      actualModelContext: {
        presetId: "byok-asr",
        source: "byok",
        provider: "dashscope",
        endpointId: "asr",
        protocol: "dashscope-input-audio-chat",
        model: "qwen3-asr-flash",
        capability: "asr",
        capabilities: ["asr"]
      }
    });
    fixture.dispose();
  });
});

function catalogFixture(mode: "account" | "byok"): { configPath: string; dispose(): void } {
  const root = mkdtempSync(join(tmpdir(), "memmy-asr-catalog-"));
  const configPath = join(root, "config.yaml");
  const byok = {
    provider: "dashscope", endpoint: "asr", model: "qwen3-asr-flash", source: "byok",
    capabilities: ["asr"]
  };
  const account = {
    provider: "memmy_account", endpoint: "platform", model: "account-asr", source: "account",
    ownerAccountId: "owner-a", capabilities: ["asr"]
  };
  writeFileSync(configPath, YAML.stringify({
    app: { userMode: mode, ...(mode === "account" ? { userId: "owner-a" } : {}) },
    providers: {
      dashscope: {
        apiKey: "wrong-provider-key",
        endpoints: {
          chat: { apiBase: "https://wrong.example.test/v1", protocol: "openai-chat-completions" },
          asr: {
            apiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            protocol: "dashscope-input-audio-chat",
            apiKey: "endpoint-secret",
            extraHeaders: { "x-endpoint-auth": "endpoint" },
            extraBody: { language_hints: ["zh", "en"] }
          }
        }
      },
      memmy_account: {
        apiKey: "cloud-login-jwt",
        ownerAccountId: "owner-a",
        endpoints: {
          platform: { apiBase: "https://cloud.example.test/v1", protocol: "memmy-account" }
        }
      }
    },
    modelPresets: { "byok-asr": byok, "account-asr": account },
    modelAssignments: {
      byok: { asr: "byok-asr" },
      account: { ownerAccountId: "owner-a", asr: "account-asr" }
    }
  }));
  return { configPath, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
