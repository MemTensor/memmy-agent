/** Asr service tests. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { createMemmyConfigWriter } from "../../infrastructure/memmy-config/index.js";
import { createAsrService } from "../asr-service.js";

describe("asr service", () => {
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
