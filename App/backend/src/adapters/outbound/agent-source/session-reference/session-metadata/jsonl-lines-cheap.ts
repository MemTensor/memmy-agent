/**
 * Streams a JSONL file's rows without parsing the ones nothing needs.
 *
 * <p>A session file is mostly tool output and assistant text: records of many kilobytes that the scan turns into
 * messages, but that a listing only needs a timestamp from. Parsing them is the whole cost of reading a file - 8.5GB
 * of Codex history took ten seconds - while a regular expression finds the same timestamp in microseconds. So the
 * caller says which lines it wants parsed, and the rest arrive as their raw text.</p>
 *
 * <p>The read is a stream, so memory stays proportional to one record rather than to the file: a 50MB session read
 * this way peaks around 50MB.</p>
 */
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** One row of the file: its text, and its parsed form when the caller asked for it. */
export interface CheapRow {
  /** The row's own text, without the trailing newline. */
  text: string;
  /** Set only when `wantsParse` returned true; a row that failed to parse yields null. */
  parsed: Record<string, unknown> | null;
}

/** A record longer than this is skipped rather than buffered: no session record needs more. */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

/**
 * Streams rows, parsing only those `wantsParse` accepts.
 *
 * @param wantsParse Decides per line, on the raw text, whether the row is worth a JSON.parse. Keep it cheap: it runs
 * on every row.
 */
export async function* readJsonlRowsCheap(
  filePath: string,
  wantsParse: (text: string) => boolean
): AsyncIterable<CheapRow> {
  const stream = createReadStream(filePath);
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let tooLong = false;
  try {
    for await (const chunk of stream) {
      carry += decoder.write(chunk as Buffer);
      if (carry.length > MAX_RECORD_BYTES) {
        // 一条超长记录：跳过它，不要让它在内存里攒着。
        carry = "";
        tooLong = true;
      }
      let start = 0;
      for (;;) {
        const end = carry.indexOf("\n", start);
        if (end < 0) break;
        const line = carry.slice(start, end);
        start = end + 1;
        if (tooLong) {
          tooLong = false;
          continue;
        }
        const text = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!text.trim()) continue;
        yield { text, parsed: wantsParse(text) ? parse(text) : null };
      }
      carry = carry.slice(start);
    }
    carry += decoder.end();
    if (!tooLong && carry.trim()) {
      yield { text: carry, parsed: wantsParse(carry) ? parse(carry) : null };
    }
  } finally {
    stream.destroy();
  }
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
