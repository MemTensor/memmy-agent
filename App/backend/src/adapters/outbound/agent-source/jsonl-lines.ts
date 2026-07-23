/** Jsonl lines module. */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Streams valid object rows from a JSONL file.
 * Malformed and non-object rows are skipped without interrupting the stream.
 *
 * @param filePath JSONL file path.
 * @param signal Optional abort signal.
 * @returns The JSON objects parsed line by line.
 */
export async function* readJsonlObjects(filePath: string, signal?: AbortSignal): AsyncIterable<JsonObject> {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({
    input: stream,
    crlfDelay: Number.POSITIVE_INFINITY
  });

  try {
    for await (const line of lines) {
      throwIfAborted(signal, filePath);
      if (line.trim().length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      if (!isJsonObject(parsed)) {
        continue;
      }

      yield parsed;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/**
 * Abort-signal check.
 *
 * @param signal Optional abort signal.
 * @param filePath Current file path.
 */
function throwIfAborted(signal: AbortSignal | undefined, filePath: string): void {
  if (signal?.aborted) {
    throw new DOMException(`JSONL read aborted: ${filePath}`, "AbortError");
  }
}

/**
 * JSON object type guard.
 *
 * @param value Unknown value.
 * @returns Whether it is a non-array object.
 */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
