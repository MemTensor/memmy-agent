import fs from "node:fs";
import path from "node:path";

export const TRANSCRIPTIONS_PATH = "audio/transcriptions";
export const MAX_TRANSCRIPTION_RETRIES = 3;
export const TRANSCRIPTION_BACKOFF_S = [1, 2, 4];
export const RETRYABLE_TRANSCRIPTION_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function resolveTranscriptionUrl(apiBase: string | null | undefined, defaultUrl: string): string {
  if (!apiBase) return defaultUrl;
  const base = apiBase.replace(/\/+$/g, "");
  if (base.endsWith(TRANSCRIPTIONS_PATH)) return base;
  return `${base}/${TRANSCRIPTIONS_PATH}`;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function isRetryableError(error: any): boolean {
  const name = String(error?.name ?? error?.constructor?.name ?? "");
  return /Timeout|Connect|Read|Write|Protocol|Network|Abort/i.test(name) || Boolean(error?.code);
}

async function readAudioInput(input: string | Buffer | Uint8Array): Promise<{ data: Buffer; filename: string } | null> {
  if (typeof input === "string") {
    if (!fs.existsSync(input) || !fs.statSync(input).isFile()) return null;
    try {
      return { data: fs.readFileSync(input), filename: path.basename(input) || "audio" };
    } catch {
      return null;
    }
  }
  return { data: Buffer.from(input), filename: "audio.bin" };
}

export async function postTranscriptionWithRetry({
  url,
  apiKey,
  data,
  filename,
  model,
  language = null,
  fetchImpl = fetch,
  sleepImpl = sleep,
}: {
  url: string;
  apiKey?: string | null;
  data: Buffer;
  filename: string;
  model: string;
  language?: string | null;
  fetchImpl?: typeof fetch;
  sleepImpl?: (seconds: number) => Promise<void>;
}): Promise<string> {
  for (let attempt = 0; attempt <= MAX_TRANSCRIPTION_RETRIES; attempt += 1) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(data)]), filename);
    form.append("model", model);
    if (language) form.append("language", language);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (RETRYABLE_TRANSCRIPTION_STATUS.has(response.status) && attempt < MAX_TRANSCRIPTION_RETRIES) {
        await sleepImpl(TRANSCRIPTION_BACKOFF_S[attempt]);
        continue;
      }
      if (!response.ok) return "";
      let payload: any;
      try {
        payload = await response.json();
      } catch {
        return "";
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
      return typeof payload.text === "string" ? payload.text : "";
    } catch (error) {
      if (attempt < MAX_TRANSCRIPTION_RETRIES && isRetryableError(error)) {
        await sleepImpl(TRANSCRIPTION_BACKOFF_S[attempt]);
        continue;
      }
      return "";
    }
  }
  return "";
}

export class OpenAITranscriptionProvider {
  apiKey: string | null;
  apiUrl: string;
  language: string | null;
  fetchImpl: typeof fetch;
  sleepImpl: (seconds: number) => Promise<void>;

  constructor({
    apiKey,
    apiBase,
    language = null,
    fetchImpl = fetch,
    sleepImpl = sleep,
  }: {
    apiKey?: string | null;
    apiBase?: string | null;
    language?: string | null;
    fetchImpl?: typeof fetch;
    sleepImpl?: (seconds: number) => Promise<void>;
  } = {}) {
    this.apiKey = apiKey ?? process.env.OPENAI_API_KEY ?? null;
    this.apiUrl = resolveTranscriptionUrl(
      apiBase ?? process.env.OPENAI_TRANSCRIPTION_BASE_URL,
      "https://api.openai.com/v1/audio/transcriptions",
    );
    this.language = language || null;
    this.fetchImpl = fetchImpl;
    this.sleepImpl = sleepImpl;
  }

  async transcribe(input: string | Buffer | Uint8Array): Promise<string> {
    if (!this.apiKey) return "";
    const audio = await readAudioInput(input);
    if (!audio) return "";
    return postTranscriptionWithRetry({
      url: this.apiUrl,
      apiKey: this.apiKey,
      data: audio.data,
      filename: audio.filename,
      model: "whisper-1",
      language: this.language,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
    });
  }
}

export class GroqTranscriptionProvider extends OpenAITranscriptionProvider {
  constructor(init: ConstructorParameters<typeof OpenAITranscriptionProvider>[0] = {}) {
    super({
      ...init,
      apiKey: init?.apiKey ?? process.env.GROQ_API_KEY ?? null,
      apiBase: init?.apiBase ?? process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
    });
    this.apiUrl = resolveTranscriptionUrl(init?.apiBase ?? process.env.GROQ_BASE_URL, "https://api.groq.com/openai/v1/audio/transcriptions");
  }

  override async transcribe(input: string | Buffer | Uint8Array): Promise<string> {
    if (!this.apiKey) return "";
    const audio = await readAudioInput(input);
    if (!audio) return "";
    return postTranscriptionWithRetry({
      url: this.apiUrl,
      apiKey: this.apiKey,
      data: audio.data,
      filename: audio.filename,
      model: "whisper-large-v3",
      language: this.language,
      fetchImpl: this.fetchImpl,
      sleepImpl: this.sleepImpl,
    });
  }
}
