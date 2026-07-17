import type { RuntimeConfig } from "@memmy/local-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpConfigClient } from "../config-client.js";

const config: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:18100",
  localToken: "token"
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("config-client", () => {
  it("http client 调用应用设置、隐私和模型配置真实路由", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      expect(init?.headers).toMatchObject({
        "x-memmy-local-token": "token"
      });
      if (init?.body !== undefined) {
        expect(init?.headers).toMatchObject({
          "content-type": "application/json"
        });
      }

      if (url.endsWith("/api/app/settings")) {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ language: "zh-CN" });
        return jsonResponse({
          userMode: "account",
          language: "zh-CN",
          theme: "system",
          autoUpdateEnabled: false,
          defaultLaunchMode: "pet",
          avatarId: "memmy-default",
          skinId: "default"
        });
      }

      if (url.endsWith("/api/app/privacy")) {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ allowMemoryImprovementUpload: true });
        return jsonResponse({
          telemetryOptIn: true,
          crashReportOptIn: false,
          allowMemoryImprovementUpload: true,
          localOnlyMode: false
        });
      }

      if (url.endsWith("/api/app/scan-preferences")) {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ autoInjectSkill: true });
        return jsonResponse({
          autoScanKnownAgents: true,
          watchFileChanges: true,
          autoInjectSkill: true
        });
      }

      if (url.endsWith("/api/app/improvement-program")) {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({ improvementProgram: "accepted" });
        return jsonResponse({
          onboarding: {
            completed: false,
            currentStep: "product_tour_required",
            hasAcceptedTerms: false,
            acceptedTermsVersion: null,
            scanPermission: "scan_only",
            improvementProgram: "accepted",
            completedAt: null
          },
          privacy: {
            telemetryOptIn: true,
            crashReportOptIn: false,
            allowMemoryImprovementUpload: true,
            localOnlyMode: false
          },
          tokenUsage: {
            planName: "体验 Token",
            totalTokens: 35000000,
            usedTokens: 1000000,
            remainingTokens: 34000000,
            expiresAt: null,
            lastSyncedAt: "2026-06-05T10:00:00.000Z"
          }
        });
      }

      if (url.endsWith("/api/app/token-usage")) {
        expect(init?.method).toBe("GET");
        return jsonResponse({
          planName: "体验 Token",
          totalTokens: 40000000,
          usedTokens: 900000,
          remainingTokens: 39100000,
          expiresAt: null,
          lastSyncedAt: "2026-06-24T10:00:00.000Z"
        });
      }

      if (url.endsWith("/api/app/model-config") && init?.method === "PUT") {
        expect(init?.method).toBe("PUT");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          provider: "openai_compatible",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4.1-mini",
          apiKey: "sk-test",
          memmyMemory: {
        summary: {
              provider: "anthropic",
              baseUrl: "https://memory.example.com/v1",
              modelId: "claude-3-5-haiku",
              apiKey: "sk-memory"
            },
            evolution: {
              provider: "qwen",
              baseUrl: "https://skill.example.com/v1",
              modelId: "qwen-plus",
              apiKey: "sk-skill"
            }
          },
          asr: {
            provider: "aliyun",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelId: "qwen3-asr-flash",
            apiKey: "sk-asr"
          }
        });
        return jsonResponse({
          provider: "openai_compatible",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4.1-mini",
          hasApiKey: true,
          apiKeyMasked: "sk••••test",
          embedding: localEmbeddingView(),
          memmyMemory: {
        summary: {
              provider: "anthropic",
              baseUrl: "https://memory.example.com/v1",
              modelId: "claude-3-5-haiku",
              hasApiKey: true,
              apiKeyMasked: "sk••••mory"
            },
            evolution: {
              provider: "qwen",
              baseUrl: "https://skill.example.com/v1",
              modelId: "qwen-plus",
              hasApiKey: true,
              apiKeyMasked: "sk••••kill"
            }
          },
          asr: {
            provider: "aliyun",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelId: "qwen3-asr-flash",
            hasApiKey: true,
            apiKeyMasked: "sk••••asr"
          },
          imageGen: null,
          updatedAt: "2026-06-04T00:00:00.000Z"
        });
      }

      if (url.endsWith("/api/app/model-config") && init?.method === "GET") {
        return jsonResponse({
          provider: "openai_compatible",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4.1-mini",
          hasApiKey: true,
          apiKeyMasked: "sk••••test",
          embedding: localEmbeddingView(),
          memmyMemory: {
        summary: {
              provider: "openai_compatible",
              baseUrl: "https://api.openai.com/v1",
              modelId: "gpt-4.1-mini",
              hasApiKey: true,
              apiKeyMasked: "sk••••test"
            },
            evolution: {
              provider: "openai_compatible",
              baseUrl: "https://api.openai.com/v1",
              modelId: "gpt-4.1-mini",
              hasApiKey: true,
              apiKeyMasked: "sk••••test"
            }
          },
          asr: {
            provider: "aliyun",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelId: "qwen3-asr-flash",
            hasApiKey: true,
            apiKeyMasked: "sk••••asr"
          },
          imageGen: null,
          updatedAt: "2026-06-04T00:00:00.000Z"
        });
      }

      if (url.endsWith("/api/app/model-config/test") && init?.method === "POST") {
        const body = JSON.parse(String(init?.body));
        if (body.capability === "asr") {
          expect(body).toMatchObject({
            provider: "qwen",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            modelId: "qwen3-asr-flash",
            apiKey: "sk-asr",
            capability: "asr"
          });
        } else if (body.capability === "embedding") {
          expect(body).toMatchObject({
            provider: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
            modelId: "text-embedding-3-small",
            apiKey: "sk-test",
            capability: "embedding"
          });
        } else {
          expect(body).toMatchObject({
            provider: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
            modelId: "gpt-5.5",
            apiKey: "sk-test",
            capability: "chat"
          });
        }
        return jsonResponse({
          ok: true,
          message: "连接成功",
          checkedAt: "2026-06-05T10:00:00.000Z"
        });
      }

      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpConfigClient(config);

    await expect(client.updateSettings({ language: "zh-CN" })).resolves.toMatchObject({ language: "zh-CN" });
    await expect(client.updatePrivacy({ allowMemoryImprovementUpload: true })).resolves.toMatchObject({ allowMemoryImprovementUpload: true });
    await expect(client.updateScanPreferences({ autoInjectSkill: true })).resolves.toMatchObject({ autoInjectSkill: true });
    await expect(client.setImprovementProgram(true)).resolves.toMatchObject({
      onboarding: { currentStep: "product_tour_required", improvementProgram: "accepted" },
      privacy: { allowMemoryImprovementUpload: true },
      tokenUsage: { remainingTokens: 34000000 }
    });
    await expect(client.getTokenUsage()).resolves.toMatchObject({
      totalTokens: 40000000,
      remainingTokens: 39100000,
      lastSyncedAt: "2026-06-24T10:00:00.000Z"
    });
    await expect(
      client.saveModelConfig({
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4.1-mini",
        apiKey: "sk-test",
        apiKeyMasked: "",
        configured: true,
        memmyMemory: {
        summary: {
            provider: "anthropic",
            endpoint: "https://memory.example.com/v1",
            model: "claude-3-5-haiku",
            apiKey: "sk-memory",
            apiKeyMasked: "",
            configured: true
          },
          evolution: {
            provider: "qwen",
            endpoint: "https://skill.example.com/v1",
            model: "qwen-plus",
            apiKey: "sk-skill",
            apiKeyMasked: "",
            configured: true
          }
        },
        asr: {
          provider: "aliyun",
          endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          model: "qwen3-asr-flash",
          apiKey: "sk-asr",
          apiKeyMasked: "",
          configured: true
        }
      })
    ).resolves.toMatchObject({
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKeyMasked: "sk••••test",
      configured: true,
      memmyMemory: {
        summary: {
          provider: "anthropic",
          endpoint: "https://memory.example.com/v1",
          model: "claude-3-5-haiku",
          apiKeyMasked: "sk••••mory",
          configured: true
        },
        evolution: {
          provider: "qwen",
          endpoint: "https://skill.example.com/v1",
          model: "qwen-plus",
          apiKeyMasked: "sk••••kill",
          configured: true
        }
      },
      asr: {
        provider: "aliyun",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-asr-flash",
        apiKeyMasked: "sk••••asr",
        configured: true
      }
    });
    await expect(client.getModelConfig()).resolves.toMatchObject({
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKeyMasked: "sk••••test",
      configured: true,
      asr: {
        provider: "aliyun",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-asr-flash",
        apiKeyMasked: "sk••••asr",
        configured: true
      }
    });
    await expect(
      client.testModelConfig({
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5.5",
        apiKey: "sk-test",
        apiKeyMasked: "",
        configured: false
      })
    ).resolves.toEqual({
      ok: true,
      message: "连接成功",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    await expect(
      client.testModelConfig({
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "text-embedding-3-small",
        apiKey: "sk-test",
        apiKeyMasked: "",
        configured: false
      }, "embedding")
    ).resolves.toEqual({
      ok: true,
      message: "连接成功",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    await expect(
      client.testModelConfig({
        provider: "qwen",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-asr-flash",
        apiKey: "sk-asr",
        apiKeyMasked: "",
        configured: false
      }, "asr")
    ).resolves.toEqual({
      ok: true,
      message: "连接成功",
      checkedAt: "2026-06-05T10:00:00.000Z"
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("测试已有脱敏 key 的配置时发送 secret target 且不把 masked key 当作明文 secret", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        ok: true,
        message: "连接成功",
        checkedAt: "2026-06-05T10:00:00.000Z"
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = createHttpConfigClient(config);

    await expect(
      (client.testModelConfig as any)({
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o",
        apiKey: "",
        apiKeyMasked: "sk-t••••cret",
        configured: true
      }, "chat", "primary")
    ).resolves.toMatchObject({ ok: true });

    expect(requestBodies).toEqual([
      {
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4o",
        capability: "chat",
        secretTarget: "primary"
      }
    ]);
  });

  it("保存已有脱敏 key 的配置时不把 masked key 当作明文 secret 回传", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4.1-mini",
        memmyMemory: {
        summary: {
            provider: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
            modelId: "gpt-4.1-mini"
          }
        },
        embedding: {
          mode: "custom",
          baseUrl: "https://embedding.example.com/v1",
          modelId: "text-embedding-3-small"
        },
        asr: {
          provider: "aliyun",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "qwen3-asr-flash"
        }
      });
      expect(body).not.toHaveProperty("apiKey");
      expect(body.embedding).not.toHaveProperty("apiKey");
      expect(body.memmyMemory.summary).not.toHaveProperty("apiKey");
      expect(body.memmyMemory.evolution).not.toHaveProperty("apiKey");
      expect(body.asr).not.toHaveProperty("apiKey");
      return jsonResponse({
        provider: "openai_compatible",
        baseUrl: "https://api.openai.com/v1",
        modelId: "gpt-4.1-mini",
        hasApiKey: true,
        apiKeyMasked: "sk-t••••cret",
        embedding: {
          mode: "custom",
          baseUrl: "https://embedding.example.com/v1",
          modelId: "text-embedding-3-small",
          hasApiKey: true,
          apiKeyMasked: "sk-e••••cret"
        },
        memmyMemory: {
        summary: {
            provider: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
            modelId: "gpt-4.1-mini",
            hasApiKey: true,
            apiKeyMasked: "sk-t••••cret"
          },
          evolution: {
            provider: "openai_compatible",
            baseUrl: "https://api.openai.com/v1",
            modelId: "gpt-4.1-mini",
            hasApiKey: true,
            apiKeyMasked: "sk-t••••cret"
          }
        },
        asr: {
          provider: "aliyun",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          modelId: "qwen3-asr-flash",
          hasApiKey: true,
          apiKeyMasked: "sk-a••••cret"
        },
        imageGen: null,
        updatedAt: "2026-06-04T00:00:00.000Z"
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpConfigClient(config);

    await expect(client.saveModelConfig({
      provider: "openai",
      endpoint: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "",
      apiKeyMasked: "sk-t••••cret",
      configured: true,
      embedding: {
        mode: "custom",
        endpoint: "https://embedding.example.com/v1",
        model: "text-embedding-3-small",
        apiKey: "",
        apiKeyMasked: "sk-e••••cret",
        configured: true
      },
      memmyMemory: {
        summary: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          apiKey: "",
          apiKeyMasked: "sk-t••••cret",
          configured: true
        },
        evolution: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "gpt-4.1-mini",
          apiKey: "",
          apiKeyMasked: "sk-t••••cret",
          configured: true
        }
      },
      asr: {
        provider: "aliyun",
        endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        model: "qwen3-asr-flash",
        apiKey: "",
        apiKeyMasked: "sk-a••••cret",
        configured: true
      }
    })).resolves.toMatchObject({
      apiKeyMasked: "sk-t••••cret",
      configured: true,
      asr: {
        apiKeyMasked: "sk-a••••cret",
        configured: true
      }
    });
  });

  it("测试连接后自动保存：memmyMemory 角色未配置(空 modelId)时省略 memmyMemory 而不是发送非法输入", async () => {
    // Regression for the 2026-07-13 main.log ZodError: a seeded model_id='' hydrated a memory role with model="".
    // Autosaving the complete state then failed RoleModelConfigInputSchema.modelId min(1) without visible feedback.
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(savedModelConfigView());
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpConfigClient(config);

    await expect(client.saveModelConfig({
      provider: "openai",
      endpoint: "https://gateway.example.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "sk-test",
      apiKeyMasked: "",
      configured: true,
      memmyMemory: {
        summary: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "",
          apiKey: "",
          apiKeyMasked: "",
          configured: false
        },
        evolution: {
          provider: "openai",
          endpoint: "https://api.openai.com/v1",
          model: "",
          apiKey: "",
          apiKeyMasked: "",
          configured: false
        }
      }
    })).resolves.toMatchObject({ provider: "openai" });

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      provider: "openai_compatible",
      baseUrl: "https://gateway.example.com/v1",
      modelId: "gpt-4.1-mini"
    });
    expect(requestBodies[0]).not.toHaveProperty("memmyMemory");
  });

  it("保存时 memmyMemory 只有单个角色未配置则该角色回退主模型", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(savedModelConfigView());
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpConfigClient(config);

    await client.saveModelConfig({
      provider: "openai",
      endpoint: "https://gateway.example.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "sk-test",
      apiKeyMasked: "",
      configured: true,
      memmyMemory: {
        summary: {
          provider: "anthropic",
          endpoint: "https://memory.example.com/v1",
          model: "claude-3-5-haiku",
          apiKey: "sk-memory",
          apiKeyMasked: "",
          configured: true
        },
        evolution: {
          provider: "openai",
          endpoint: "",
          model: "",
          apiKey: "",
          apiKeyMasked: "",
          configured: false
        }
      }
    });

    expect(requestBodies[0]).toMatchObject({
      memmyMemory: {
        summary: {
          provider: "anthropic",
          baseUrl: "https://memory.example.com/v1",
          modelId: "claude-3-5-haiku"
        },
        evolution: {
          provider: "openai_compatible",
          baseUrl: "https://gateway.example.com/v1",
          modelId: "gpt-4.1-mini"
        }
      }
    });
  });

  it("保存时未配置的 custom embedding 与空 endpoint 的 asr 被省略", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(savedModelConfigView());
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = createHttpConfigClient(config);

    await client.saveModelConfig({
      provider: "openai",
      endpoint: "https://gateway.example.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "sk-test",
      apiKeyMasked: "",
      configured: true,
      embedding: {
        mode: "custom",
        endpoint: "",
        model: "",
        apiKey: "",
        apiKeyMasked: "",
        configured: false
      },
      asr: {
        provider: "aliyun",
        endpoint: "",
        model: "qwen3-asr-flash",
        apiKey: "",
        apiKeyMasked: "",
        configured: false
      }
    });

    expect(requestBodies[0]).not.toHaveProperty("embedding");
    expect(requestBodies[0]).not.toHaveProperty("asr");
  });
});

function savedModelConfigView() {
  return {
    provider: "openai_compatible",
    baseUrl: "https://gateway.example.com/v1",
    modelId: "gpt-4.1-mini",
    hasApiKey: true,
    apiKeyMasked: "sk••••test",
    embedding: localEmbeddingView(),
    memmyMemory: {
      summary: {
        provider: "openai_compatible",
        baseUrl: "https://gateway.example.com/v1",
        modelId: "gpt-4.1-mini",
        hasApiKey: true,
        apiKeyMasked: "sk••••test"
      },
      evolution: {
        provider: "openai_compatible",
        baseUrl: "https://gateway.example.com/v1",
        modelId: "gpt-4.1-mini",
        hasApiKey: true,
        apiKeyMasked: "sk••••test"
      }
    },
    asr: null,
    imageGen: null,
    updatedAt: "2026-07-13T00:00:00.000Z"
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function localEmbeddingView() {
  return {
    mode: "local",
    baseUrl: null,
    modelId: null,
    hasApiKey: false,
    apiKeyMasked: ""
  };
}
