export async function postJsonWithRetry<T>(
  input: {
    provider: string;
    url: string;
    headers?: Record<string, string>;
    body: unknown;
    timeoutMs: number;
    maxRetries: number;
  }
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= input.maxRetries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
      try {
        const response = await fetch(input.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.headers ?? {})
          },
          body: JSON.stringify(input.body),
          signal: controller.signal
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`${input.provider} HTTP ${response.status}: ${clip(text, 800)}`);
        }
        return (text ? JSON.parse(text) : {}) as T;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      lastError = error;
      if (attempt < input.maxRetries) {
        await sleep(Math.min(1_000 * Math.pow(2, attempt), 8_000));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function bearer(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
