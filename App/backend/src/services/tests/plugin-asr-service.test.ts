/** Plugin `asr` host-service tests. */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsrTranscriptionInput } from "@memmy/local-api-contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPluginAsrService } from "../plugin-asr-service.js";
import { createPluginHostServiceRouter } from "../plugin-host-service-router.js";

describe("plugin asr host service", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memmy-plugin-asr-"));
    outside = mkdtempSync(join(tmpdir(), "memmy-private-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("transcribes an upload and forwards diarization and hotwords", async () => {
    const audioPath = join(root, "interview.m4a");
    writeFileSync(audioPath, Buffer.from("fake-audio"));
    const received: AsrTranscriptionInput[] = [];
    const service = createPluginAsrService({
      audioRoots: [root],
      asr: {
        transcribe: async (input) => {
          received.push(input);
          return {
            text: "hello",
            modelId: "qwen3-asr-flash",
            provider: "dashscope",
            source: "account",
            transcribedAt: "2026-06-15T10:00:00.000Z",
            segments: [{ text: "hello", speakerId: 0, startMs: 0, endMs: 500 }]
          };
        }
      }
    });

    const response = await service.invoke(call({ path: audioPath, diarization: true, hotwords: ["劳动合同"] }));

    expect(received[0]).toMatchObject({
      mimeType: "audio/mp4",
      diarization: true,
      hotwords: ["劳动合同"],
      audioBase64: Buffer.from("fake-audio").toString("base64")
    });
    expect(response).toMatchObject({ text: "hello", segments: [{ speakerId: 0, text: "hello" }] });
  });

  it("rejects a path outside the Host-owned audio roots", async () => {
    const audioPath = join(outside, "private.wav");
    writeFileSync(audioPath, Buffer.from("private"));
    const service = createPluginAsrService({ audioRoots: [root], asr: unreachableAsr() });

    await expect(service.invoke(call({ path: audioPath }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a symlink inside an audio root that escapes it", async () => {
    const target = join(outside, "private.wav");
    writeFileSync(target, Buffer.from("private"));
    symlinkSync(target, join(root, "linked.wav"));
    const service = createPluginAsrService({ audioRoots: [root], asr: unreachableAsr() });

    await expect(service.invoke(call({ path: join(root, "linked.wav") }))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects an empty recording", async () => {
    const audioPath = join(root, "empty.wav");
    writeFileSync(audioPath, Buffer.alloc(0));
    const service = createPluginAsrService({ audioRoots: [root], asr: unreachableAsr() });

    await expect(service.invoke(call({ path: audioPath }))).rejects.toMatchObject({ code: "invalid_argument" });
  });

  it("routes only the asr service and rejects unknown services", async () => {
    const audioPath = join(root, "interview.wav");
    writeFileSync(audioPath, Buffer.from("audio"));
    const router = createPluginHostServiceRouter([
      { services: ["model-inference"], invoker: { invoke: async () => "inference" } },
      {
        services: ["asr"],
        invoker: createPluginAsrService({
          audioRoots: [root],
          asr: {
            transcribe: async () => ({
              text: "ok",
              modelId: "qwen3-asr-flash",
              provider: "dashscope",
              source: "account",
              transcribedAt: "2026-06-15T10:00:00.000Z"
            })
          }
        })
      }
    ]);

    await expect(router.invoke({ ...call({ path: audioPath }), service: "model-inference" })).resolves.toBe("inference");
    await expect(router.invoke(call({ path: audioPath }))).resolves.toMatchObject({ text: "ok" });
    await expect(router.invoke({ ...call({ path: audioPath }), service: "file-input" }))
      .rejects.toMatchObject({ code: "host_service_unavailable" });
  });
});

function call(input: Record<string, unknown>) {
  return {
    pluginId: "vertical-demo",
    callId: "call-1",
    conversationId: "conversation-1",
    service: "asr",
    input
  };
}

function unreachableAsr() {
  return {
    transcribe: async () => {
      throw new Error("transcription should not be reached");
    }
  };
}
