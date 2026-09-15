import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ASR_MAX_AUDIO_BYTES } from "@memmy/local-api-contracts";
import type { PermissionManager } from "../../../../permission/index.js";
import { createProgressBus } from "../../../../services/progress-bus.js";
import type { BackendServices } from "../../../../services/index.js";
import { createLocalApiServer } from "../server.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("asr local api route", () => {
  it("accepts a recording far larger than fastify's default body limit", async () => {
    // An interview has to reach the route as one request, and Fastify's 1 MiB
    // default only fits a couple of minutes of speech.
    const transcribe = vi.fn(async () => ({
      text: "转写结果",
      modelId: "test-model",
      provider: "dashscope" as const,
      source: "account" as const,
      transcribedAt: new Date().toISOString()
    }));
    app = createServer(transcribe);

    const audioBase64 = "A".repeat(4 * 1024 * 1024);
    const response = await app.inject({
      method: "POST",
      url: "/api/asr/transcriptions",
      headers: { "x-memmy-local-token": "test-token" },
      payload: { audioBase64, mimeType: "audio/webm" }
    });

    expect(response.statusCode).toBe(200);
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("rejects audio beyond the transcription ceiling instead of forwarding it", async () => {
    const transcribe = vi.fn();
    app = createServer(transcribe as never);

    const response = await app.inject({
      method: "POST",
      url: "/api/asr/transcriptions",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {
        audioBase64: "A".repeat(Math.ceil((ASR_MAX_AUDIO_BYTES * 4) / 3) + 1),
        mimeType: "audio/webm"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("passes diarization through to the transcription service and returns its segments", async () => {
    const transcribe = vi.fn(async () => ({
      text: "甲说完乙说",
      modelId: "test-model",
      provider: "dashscope" as const,
      source: "account" as const,
      transcribedAt: new Date().toISOString(),
      segments: [
        { text: "甲说", speakerId: 0, startMs: 0, endMs: 500 },
        { text: "乙说", speakerId: 1, startMs: 500, endMs: 900 }
      ]
    }));
    app = createServer(transcribe);

    const response = await app.inject({
      method: "POST",
      url: "/api/asr/transcriptions",
      headers: { "x-memmy-local-token": "test-token" },
      payload: {
        audioBase64: "UklGRg==",
        mimeType: "audio/wav",
        diarization: true
      }
    });

    expect(response.statusCode).toBe(200);
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ diarization: true }));
    expect(response.json().segments).toEqual([
      { text: "甲说", speakerId: 0, startMs: 0, endMs: 500 },
      { text: "乙说", speakerId: 1, startMs: 500, endMs: 900 }
    ]);
  });
});

function createServer(transcribe: BackendServices["asr"]["transcribe"]): FastifyInstance {
  return createLocalApiServer({
    permissionManager: createPermissionManager(),
    services: {
      progressBus: createProgressBus(),
      asr: { transcribe }
    } as unknown as BackendServices,
    heartbeatIntervalMs: 20
  });
}

function createPermissionManager(): PermissionManager {
  return {
    async getRuntimeToken() {
      return "test-token";
    },
    async verifyRuntimeToken(token) {
      return token === "test-token";
    },
    async getScanPermission() {
      return "none";
    },
    async setScanPermission() {
      return undefined;
    },
    async canDetectAgentSources() {
      return true;
    },
    async canScanAgentSource() {
      return false;
    },
    async canWriteAgentSkill() {
      return false;
    },
    async canSearchMemory() {
      return true;
    },
    async revokeAgentSource() {
      return undefined;
    }
  };
}
