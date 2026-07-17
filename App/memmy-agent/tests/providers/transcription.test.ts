import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GroqTranscriptionProvider,
  OpenAITranscriptionProvider,
  resolveTranscriptionUrl,
} from "../../src/providers/transcription.js";

const roots: string[] = [];

function audioFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-transcribe-"));
  roots.push(root);
  const file = path.join(root, "voice.ogg");
  fs.writeFileSync(file, Buffer.from("OggS\0fake-audio-bytes"));
  return file;
}

function response(status: number, payload: any = {}): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function rawResponse(status: number, content: string): Response {
  return new Response(content, { status });
}

function transientError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("transcription providers", () => {
  it("openai retries on 5xx then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, { text: "hello" }));
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("openai retries on 429 then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(429)).mockResolvedValueOnce(response(200, { text: "rate ok" }));
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("rate ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("openai retries on connect errors", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(transientError("ConnectError")).mockResolvedValueOnce(response(200, { text: "ok" }));
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("openai does not retry auth errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(401, { error: { message: "bad key" } }));
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("openai gives up after max attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503));
    const sleeps: number[] = [];
    const provider = new OpenAITranscriptionProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as any,
      sleepImpl: async (seconds) => {
        sleeps.push(seconds);
      },
    });

    await expect(provider.transcribe(audioFile())).resolves.toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it("openai backoff grows exponentially", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(503));
    const sleeps: number[] = [];
    const provider = new OpenAITranscriptionProvider({
      apiKey: "sk-test",
      fetchImpl: fetchImpl as any,
      sleepImpl: async (seconds) => {
        sleeps.push(seconds);
      },
    });

    await provider.transcribe(audioFile());

    expect(sleeps).toEqual([1, 2, 4]);
  });

  it("groq retries on 5xx then succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(502)).mockResolvedValueOnce(response(200, { text: "groq ok" }));
    const provider = new GroqTranscriptionProvider({ apiKey: "gsk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("groq ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("groq does not retry auth errors", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(403));
    const provider = new GroqTranscriptionProvider({ apiKey: "gsk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("openai missing api key short-circuits", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAITranscriptionProvider({ apiKey: null, fetchImpl: fetchImpl as any });

    await expect(provider.transcribe(audioFile())).resolves.toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("openai missing file short-circuits", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any });

    await expect(provider.transcribe("/nonexistent/path/voice.ogg")).resolves.toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns empty when an existing file is unreadable", async () => {
    const file = audioFile();
    const fetchImpl = vi.fn();
    vi.spyOn(fs, "readFileSync").mockImplementation((() => {
      throw new Error("denied");
    }) as any);
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any });

    await expect(provider.transcribe(file)).resolves.toBe("");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("provider forwards language in multipart bodies", async () => {
    for (const [Provider, language] of [
      [OpenAITranscriptionProvider, "en"],
      [GroqTranscriptionProvider, "ko"],
    ] as const) {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { text: "ok" }));
      const provider = new Provider({ apiKey: "k", language, fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

      await expect(provider.transcribe(audioFile())).resolves.toBe("ok");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const form = fetchImpl.mock.calls[0][1].body as FormData;
      expect(form.get("language")).toBe(language);
    }
  });

  it("provider omits language when unset", async () => {
    for (const Provider of [OpenAITranscriptionProvider, GroqTranscriptionProvider]) {
      const fetchImpl = vi.fn().mockResolvedValue(response(200, { text: "ok" }));
      const provider = new Provider({ apiKey: "k", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

      await expect(provider.transcribe(audioFile())).resolves.toBe("ok");

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const form = fetchImpl.mock.calls[0][1].body as FormData;
      expect(form.has("language")).toBe(false);
    }
  });

  it("language survives retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200, { text: "konnichiwa" }));
    const provider = new OpenAITranscriptionProvider({
      apiKey: "sk-test",
      language: "ja",
      fetchImpl: fetchImpl as any,
      sleepImpl: async () => {},
    });

    await expect(provider.transcribe(audioFile())).resolves.toBe("konnichiwa");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      const form = call[1].body as FormData;
      expect(form.get("language")).toBe("ja");
    }
  });

  it("returns empty on malformed json bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawResponse(200, "<html>not json</html>"));
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns empty on non-object json bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(rawResponse(200, "[]"));
    const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

    await expect(provider.transcribe(audioFile())).resolves.toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on every advertised transient status", async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response(status)).mockResolvedValueOnce(response(200, { text: "ok" }));
      const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

      await expect(provider.transcribe(audioFile())).resolves.toBe("ok");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("retries on every advertised transient exception", async () => {
    for (const error of [
      transientError("TimeoutException"),
      transientError("ConnectError"),
      transientError("ReadError"),
      transientError("WriteError"),
      transientError("RemoteProtocolError"),
    ]) {
      const fetchImpl = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(response(200, { text: "recovered" }));
      const provider = new OpenAITranscriptionProvider({ apiKey: "sk-test", fetchImpl: fetchImpl as any, sleepImpl: async () => {} });

      await expect(provider.transcribe(audioFile())).resolves.toBe("recovered");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it("resolveTranscriptionUrl falls back to the default endpoint", () => {
    const defaultUrl = "https://api.openai.com/v1/audio/transcriptions";

    expect(resolveTranscriptionUrl(null, defaultUrl)).toBe(defaultUrl);
    expect(resolveTranscriptionUrl("", defaultUrl)).toBe(defaultUrl);
  });

  it("resolveTranscriptionUrl appends the transcription path to chat-style bases", () => {
    expect(resolveTranscriptionUrl("https://api.groq.com/openai/v1", "https://x/audio/transcriptions")).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
    expect(resolveTranscriptionUrl("https://api.groq.com/openai/v1/", "https://x/audio/transcriptions")).toBe(
      "https://api.groq.com/openai/v1/audio/transcriptions",
    );
  });

  it("resolveTranscriptionUrl keeps full transcription endpoints", () => {
    const full = "https://api.groq.com/openai/v1/audio/transcriptions";

    expect(resolveTranscriptionUrl(full, "https://x/audio/transcriptions")).toBe(full);
  });

  it("groq provider normalizes chat-style api bases", () => {
    const provider = new GroqTranscriptionProvider({ apiKey: "gsk-test", apiBase: "https://api.groq.com/openai/v1" });

    expect(provider.apiUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  });
});
