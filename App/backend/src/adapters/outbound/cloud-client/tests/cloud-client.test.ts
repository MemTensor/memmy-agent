/** Cloud client tests. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpCloudClient } from "../index.js";

let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    server = undefined;
  }
});

describe("cloud client", () => {
  it("http client maps docs/cloud-api.md paths and response fields", async () => {
    const requests: Array<{ path: string; body: unknown; lang: string | undefined }> = [];
    server = createServer(async (request, response) => {
      const body = await readJson(request);
      requests.push({
        path: request.url ?? "",
        body,
        lang: request.headers.lang as string | undefined
      });

      if (request.url === "/api/agentUser/login") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            id: "1972215566392614914",
            email: "hello@example.com",
            phoneNumber: null,
            userName: "zdy",
            userAvatar: null,
            planType: "free",
            hasFinishedGuide: true,
            isNewUser: false,
            region: "中国-上海市",
            createTime: 1759047808000,
            uuid: "cloud.login.uuid"
          }
        });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await client.sendEmailCode({ email: "hello@example.com", zhEnv: true });
    await client.sendPhoneCode({ phoneNumber: "13800138000", zhEnv: false });
    const login = await client.login({
      email: "hello@example.com",
      verificationCode: "654321",
      loginSource: "Memmy"
    });

    expect(requests).toEqual([
      {
        path: "/api/user/sendVerification",
        body: { email: "hello@example.com", zhEnv: true },
        lang: "zh"
      },
      {
        path: "/api/agentUser/sendPhoneVerification",
        body: { phoneNumber: "13800138000", zhEnv: false },
        lang: "en"
      },
      {
        path: "/api/agentUser/login",
        body: { email: "hello@example.com", verificationCode: "654321", loginSource: "memmy" },
        lang: "zh"
      }
    ]);
    expect(login).toMatchObject({
      uuid: "cloud.login.uuid",
      accountUuid: "1972215566392614914",
      profile: {
        userId: "1972215566392614914",
        email: "hello@example.com",
        nickname: "zdy",
        planType: "free",
        hasFinishedGuide: true,
        registeredAt: "2025-09-28T08:23:28.000Z"
      },
      isNewUser: false
    });
    expect(login.profile.rawProfile).not.toHaveProperty("token");
    expect(login.profile.rawProfile).not.toHaveProperty("uuid");
  });

  it("maps cloud agent_user phone field to local phoneNumber", async () => {
    server = createServer((request, response) => {
      if (request.url === "/api/agentUser/login") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            id: "1972215566392614914",
            email: null,
            phone: "13800138000",
            userName: "喜乐松鼠",
            userAvatar: null,
            planType: "free",
            hasFinishedGuide: true,
            isNewUser: false,
            region: "中国-上海市",
            createTime: 1759047808000,
            uuid: "cloud.login.uuid"
          }
        });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    const login = await client.login({
      phoneNumber: "13800138000",
      verificationCode: "654321",
      loginSource: "Memmy"
    });

    expect(login.profile.phoneNumber).toBe("13800138000");
    expect(login.profile.rawProfile).toHaveProperty("phone", "13800138000");
    expect(login.profile.rawProfile).not.toHaveProperty("uuid");
  });

  it("does not synthesize phone-tail nickname when cloud userName is missing", async () => {
    server = createServer((request, response) => {
      if (request.url === "/api/agentUser/login") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            id: "1972215566392614914",
            email: null,
            phone: "13800138000",
            userAvatar: null,
            planType: "free",
            hasFinishedGuide: false,
            isNewUser: true,
            region: "中国-上海市",
            createTime: 1759047808000,
            uuid: "cloud.login.uuid"
          }
        });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    const login = await client.login({
      phoneNumber: "13800138000",
      verificationCode: "654321",
      loginSource: "Memmy"
    });

    expect(login.profile.nickname).toBe("Memmy User");
    expect(login.profile.nickname).not.toBe("user-8000");
  });

  it("http client logout posts to agentUser/logout with bearer token", async () => {
    const requests: Array<{ path: string; method: string | undefined; authorization: string | undefined }> = [];
    server = createServer((request, response) => {
      requests.push({
        path: request.url ?? "",
        method: request.method,
        authorization: request.headers.authorization
      });
      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await client.logout({ uuid: "cloud.login.uuid" });

    expect(requests).toEqual([
      {
        path: "/api/agentUser/logout",
        method: "POST",
        authorization: "Bearer cloud.login.uuid"
      }
    ]);
  });

  it("http client reads token usage from agentUser info and grants through quota update endpoint", async () => {
    const requests: Array<{ path: string; method: string | undefined; body: unknown; authorization: string | undefined }> = [];
    let quotaUpdated = false;
    server = createServer(async (request, response) => {
      requests.push({
        path: request.url ?? "",
        method: request.method,
        body: await readJson(request),
        authorization: request.headers.authorization
      });
      if (request.url === "/api/agentUser/info") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            planType: "free",
            tokenTotal: quotaUpdated ? 35000000 : 30000000,
            tokenAvailable: quotaUpdated ? 34998655 : 29998655,
            tokenConsumer: 1345,
            expiresAt: null,
            lastSyncedAt: "2026-06-05T10:00:00.000Z"
          }
        });
        return;
      }

      if (request.url === "/api/agentUser/quota/updateTokenTotal") {
        quotaUpdated = true;
      }

      sendJson(response, {
        code: 0,
        message: "ok",
        data: true
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getTokenUsage({ userId: "user-1", uuid: "cloud.login.uuid" })).resolves.toMatchObject({
      planName: "free",
      totalTokens: 30000000,
      usedTokens: 1345,
      remainingTokens: 29998655
    });
    await expect(
      client.grantImprovementProgramTokens({
        uuid: "cloud.login.uuid",
        tokenExtra: 5_000_000
      })
    ).resolves.toMatchObject({
      totalTokens: 35000000,
      remainingTokens: 34998655
    });

    expect(requests).toEqual([
      {
        path: "/api/agentUser/info",
        method: "GET",
        body: {},
        authorization: "Bearer cloud.login.uuid"
      },
      {
        path: "/api/agentUser/quota/updateTokenTotal",
        method: "POST",
        body: { tokenExtra: 5_000_000 },
        authorization: "Bearer cloud.login.uuid"
      },
      {
        path: "/api/agentUser/info",
        method: "GET",
        body: {},
        authorization: "Bearer cloud.login.uuid"
      }
    ]);
  });

  it("http client reads and updates cloud guide completion flag", async () => {
    const requests: Array<{ path: string; method: string | undefined; body: unknown; authorization: string | undefined }> = [];
    server = createServer(async (request, response) => {
      requests.push({
        path: request.url ?? "",
        method: request.method,
        body: await readJson(request),
        authorization: request.headers.authorization
      });
      if (request.url === "/api/agentUser/info") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            id: "1972215566392614914",
            email: "hello@example.com",
            phoneNumber: null,
            userName: "zdy",
            userAvatar: null,
            planType: "free",
            hasFinishedGuide: false,
            region: "中国-上海市",
            createTime: 1759047808000
          }
        });
        return;
      }

      sendJson(response, {
        code: 0,
        message: "ok",
        data: true
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getAccountInfo({ uuid: "cloud.login.uuid" })).resolves.toMatchObject({
      userId: "1972215566392614914",
      email: "hello@example.com",
      nickname: "zdy",
      hasFinishedGuide: false
    });
    await expect(client.updateAccountGuide({ uuid: "cloud.login.uuid", hasFinishedGuide: true })).resolves.toBeUndefined();
    await expect(client.updateAccountProfile({ uuid: "cloud.login.uuid", userName: "喜乐松鼠" })).resolves.toBeUndefined();

    expect(requests).toEqual([
      {
        path: "/api/agentUser/info",
        method: "GET",
        body: {},
        authorization: "Bearer cloud.login.uuid"
      },
      {
        path: "/api/agentUser/update",
        method: "POST",
        body: { hasFinishedGuide: true },
        authorization: "Bearer cloud.login.uuid"
      },
      {
        path: "/api/agentUser/update",
        method: "POST",
        body: { userName: "喜乐松鼠" },
        authorization: "Bearer cloud.login.uuid"
      }
    ]);
  });

  it("coerces a numeric hasFinishedGuide from cloud info into a boolean", async () => {
    server = createServer((request, response) => {
      if (request.url === "/api/agentUser/info") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            id: "1972215566392614914",
            email: "hello@example.com",
            phoneNumber: null,
            userName: "zdy",
            userAvatar: null,
            planType: "free",
            hasFinishedGuide: 1,
            region: "中国-上海市",
            createTime: 1759047808000
          }
        });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getAccountInfo({ uuid: "cloud.login.uuid" })).resolves.toMatchObject({
      hasFinishedGuide: true
    });
  });

  it("forwards the per-user grantKey so the cloud can dedup the improvement-program grant", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    server = createServer(async (request, response) => {
      requests.push({ path: request.url ?? "", body: await readJson(request) });
      if (request.url === "/api/agentUser/info") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: { tokenTotal: 35000000, tokenConsumer: 0, tokenAvailable: 35000000 }
        });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await client.grantImprovementProgramTokens({
      uuid: "cloud.login.uuid",
      tokenExtra: 5_000_000,
      grantKey: "improvement_program"
    });

    expect(requests).toContainEqual({
      path: "/api/agentUser/quota/updateTokenTotal",
      body: { tokenExtra: 5_000_000, grantKey: "improvement_program" }
    });
  });

  it("maps the cloud per-user improvementProgramGranted flag from account info", async () => {
    server = createServer((request, response) => {
      if (request.url === "/api/agentUser/info") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            id: "1972215566392614914",
            userName: "zdy",
            planType: "free",
            hasFinishedGuide: true,
            improvementProgramGranted: true
          }
        });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getAccountInfo({ uuid: "cloud.login.uuid" })).resolves.toMatchObject({
      improvementProgramGranted: true
    });
  });

  it("posts account-mode ASR transcription requests to Playground with bearer token", async () => {
    const requests: Array<{ path: string; body: unknown; authorization: string | undefined }> = [];
    server = createServer(async (request, response) => {
      requests.push({
        path: request.url ?? "",
        body: await readJson(request),
        authorization: request.headers.authorization
      });

      sendJson(response, {
        code: 0,
        message: "ok",
        data: {
          text: "你好，Memmy",
          modelId: "qwen3-asr-flash",
          provider: "aliyun"
        }
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    const result = await client.transcribeAudio({
      uuid: "cloud.login.uuid",
      audioBase64: "UklGRg==",
      mimeType: "audio/wav",
      durationMs: 1200
    });

    expect(result).toEqual({
      text: "你好，Memmy",
      modelId: "qwen3-asr-flash",
      provider: "aliyun"
    });
    expect(requests).toEqual([
      {
        path: "/api/agentAsr/transcriptions",
        body: {
          audioBase64: "UklGRg==",
          mimeType: "audio/wav",
          durationMs: 1200
        },
        authorization: "Bearer cloud.login.uuid"
      }
    ]);
  });

  it("posts account-mode ASR transcription requests to Playground with bearer token", async () => {
    const requests: Array<{ path: string; body: unknown; authorization: string | undefined }> = [];
    server = createServer(async (request, response) => {
      requests.push({
        path: request.url ?? "",
        body: await readJson(request),
        authorization: request.headers.authorization
      });

      sendJson(response, {
        code: 0,
        message: "ok",
        data: {
          text: "你好，Memmy",
          modelId: "qwen3-asr-flash",
          provider: "aliyun"
        }
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    const result = await client.transcribeAudio({
      uuid: "cloud.login.uuid",
      audioBase64: "UklGRg==",
      mimeType: "audio/wav",
      durationMs: 1200
    });

    expect(result).toEqual({
      text: "你好，Memmy",
      modelId: "qwen3-asr-flash",
      provider: "aliyun"
    });
    expect(requests).toEqual([
      {
        path: "/api/agentAsr/transcriptions",
        body: {
          audioBase64: "UklGRg==",
          mimeType: "audio/wav",
          durationMs: 1200
        },
        authorization: "Bearer cloud.login.uuid"
      }
    ]);
  });

  it("http client proxies integration capabilities/authorize/list/delete through Cloud Service with machine token", async () => {
    const requests: Array<{
      path: string;
      method: string | undefined;
      body: unknown;
      authorization: string | undefined;
      machineComposioToken: string | undefined;
    }> = [];
    server = createServer(async (request, response) => {
      requests.push({
        path: request.url ?? "",
        method: request.method,
        body: await readJson(request),
        authorization: request.headers.authorization,
        machineComposioToken: request.headers["x-memmy-composio-token"] as string | undefined
      });

      if (request.method === "GET" && request.url === "/api/composio/auth-configs?limit=100&show_disabled=false") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            items: [
              {
                id: "ac_airtable",
                toolkit: { slug: "airtable" }
              },
              {
                id: "ac_airtable_duplicate",
                toolkit_slug: "airtable"
              }
            ]
          }
        });
        return;
      }

      if (request.method === "POST" && request.url === "/api/composio/integrations/airtable/authorize") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            redirect_url: "https://airtable.com/oauth",
            id: "conn-airtable"
          }
        });
        return;
      }

      if (request.method === "GET" && request.url === "/api/composio/connections") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: {
            items: [{ id: "conn-airtable", toolkit: { slug: "airtable" }, status: "ACTIVE", account_email: "dev@example.com" }]
          }
        });
        return;
      }

      if (request.method === "DELETE" && request.url === "/api/composio/connections/conn-airtable") {
        sendJson(response, {
          code: 0,
          message: "ok",
          data: true
        });
        return;
      }

      sendJson(response, { code: 40000, message: "not found", data: null });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.listIntegrationCapabilities({ machineComposioToken: "mct_test" })).resolves.toEqual({ toolkits: ["airtable"] });
    await expect(client.authorizeIntegration({ machineComposioToken: "mct_test", slug: "airtable" })).resolves.toEqual({
      connectUrl: "https://airtable.com/oauth",
      connectionId: "conn-airtable"
    });
    await expect(client.listIntegrationConnections({ machineComposioToken: "mct_test" })).resolves.toEqual({
      connections: [{ id: "conn-airtable", toolkit: "airtable", status: "ACTIVE", accountEmail: "dev@example.com" }]
    });
    await expect(client.deleteIntegrationConnection({ machineComposioToken: "mct_test", id: "conn-airtable" })).resolves.toEqual({ ok: true });

    expect(requests).toEqual([
      {
        path: "/api/composio/auth-configs?limit=100&show_disabled=false",
        method: "GET",
        body: {},
        authorization: undefined,
        machineComposioToken: "mct_test"
      },
      {
        path: "/api/composio/integrations/airtable/authorize",
        method: "POST",
        body: {},
        authorization: undefined,
        machineComposioToken: "mct_test"
      },
      {
        path: "/api/composio/connections",
        method: "GET",
        body: {},
        authorization: undefined,
        machineComposioToken: "mct_test"
      },
      {
        path: "/api/composio/connections/conn-airtable",
        method: "DELETE",
        body: {},
        authorization: undefined,
        machineComposioToken: "mct_test"
      }
    ]);
  });

  it("http client fetches legal agreement urls from Playground desktop endpoint", async () => {
    const requests: Array<{ path: string; method: string | undefined }> = [];
    const legal = {
      terms: {
        "zh-CN": "https://legal.memtensor.cn/terms?lang=zh-CN",
        "en-US": "https://legal.memtensor.cn/terms?lang=en-US"
      },
      data: {
        "zh-CN": "https://legal.memtensor.cn/data?lang=zh-CN",
        "en-US": "https://legal.memtensor.cn/data?lang=en-US"
      }
    };
    server = createServer((request, response) => {
      requests.push({ path: request.url ?? "", method: request.method });
      sendJson(response, { code: 0, message: "ok", data: legal });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getLegalUrls()).resolves.toEqual(legal);
    expect(requests).toEqual([{ path: "/api/memmy/desktop/legal/agreements", method: "GET" }]);
  });

  it("http client returns undefined when legal endpoint fails or shape mismatches", async () => {
    server = createServer((request, response) => {
      if (request.url === "/api/memmy/desktop/legal/agreements") {
        // Non-zero business code simulating a Playground error; getLegalUrls must swallow the error and fall back to undefined.
        sendJson(response, { code: 50000, message: "boom", data: null });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getLegalUrls()).resolves.toBeUndefined();
  });

  it("http client returns undefined when legal payload misses a locale url", async () => {
    server = createServer((request, response) => {
      sendJson(response, {
        code: 0,
        message: "ok",
        data: {
          terms: { "zh-CN": "https://legal.memtensor.cn/terms?lang=zh-CN", "en-US": "https://legal.memtensor.cn/terms?lang=en-US" },
          data: { "zh-CN": "https://legal.memtensor.cn/data?lang=zh-CN" }
        }
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getLegalUrls()).resolves.toBeUndefined();
  });

  it("http client fetches promotion flags from Playground desktop endpoint", async () => {
    const requests: Array<{ path: string; method: string | undefined }> = [];
    const promotions = { loginBanner: true, improvementGift: false, applyMore: true };
    server = createServer((request, response) => {
      requests.push({ path: request.url ?? "", method: request.method });
      sendJson(response, { code: 0, message: "ok", data: promotions });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getPromotions()).resolves.toEqual(promotions);
    expect(requests).toEqual([{ path: "/api/memmy/desktop/promotions", method: "GET" }]);
  });

  it("http client returns undefined when promotions endpoint fails or shape mismatches", async () => {
    server = createServer((request, response) => {
      if (request.url === "/api/memmy/desktop/promotions") {
        sendJson(response, { code: 50000, message: "boom", data: null });
        return;
      }

      sendJson(response, { code: 0, message: "ok", data: true });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getPromotions()).resolves.toBeUndefined();
  });

  it("http client returns undefined when promotions payload misses a flag", async () => {
    server = createServer((request, response) => {
      // applyMore is missing, so safeParse fails and should fall back to undefined, with bootstrap falling back to enabling everything.
      sendJson(response, {
        code: 0,
        message: "ok",
        data: { loginBanner: true, improvementGift: true }
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Mock cloud server did not bind to a port");
    }
    const client = createHttpCloudClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 1000 });

    await expect(client.getPromotions()).resolves.toBeUndefined();
  });

});

function listen(serverToListen: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    serverToListen.once("error", reject);
    serverToListen.listen({ host: "127.0.0.1", port: 0 }, () => {
      serverToListen.off("error", reject);
      resolve();
    });
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
