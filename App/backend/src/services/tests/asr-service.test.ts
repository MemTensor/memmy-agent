/** Asr service tests. */
import { describe, expect, it } from "vitest";
import { createAsrService } from "../asr-service.js";

describe("asr service", () => {
  it("transcribes BYOK audio with qwen3-asr-flash through DashScope OpenAI-compatible API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const service = createAsrService({
      bootstrapRepository: {
        getAppSettings: () => ({ userMode: "byok" })
      },
      accountSessionRepository: {
        getCloudUuid: () => null
      },
      modelConfigRepository: {
        getAsrRuntimeConfig: () => ({
          provider: "aliyun",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "qwen3-asr-flash",
          apiKey: "dashscope-secret"
        })
      },
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

    const result = await service.transcribe({
      audioBase64: "UklGRg==",
      mimeType: "audio/wav",
      durationMs: 1200
    });

    expect(result).toEqual({
      text: "你好，Memmy",
      modelId: "qwen3-asr-flash",
      provider: "aliyun",
      source: "byok",
      transcribedAt: "2026-06-15T10:00:00.000Z"
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer dashscope-secret",
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
      }
    });
  });

  it("transcribes account-mode audio through Playground cloud service without local ASR key", async () => {
    const service = createAsrService({
      bootstrapRepository: {
        getAppSettings: () => ({ userMode: "account" })
      },
      accountSessionRepository: {
        getCloudUuid: () => "cloud-login-jwt"
      },
      modelConfigRepository: {
        getAsrRuntimeConfig: () => {
          throw new Error("BYOK ASR config should not be read in account mode");
        }
      },
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
      modelId: "qwen3-asr-flash",
      provider: "aliyun",
      source: "account",
      transcribedAt: "2026-06-15T10:05:00.000Z"
    });
  });
});
