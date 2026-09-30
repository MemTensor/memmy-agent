import { basename } from "node:path";
import {
  loadDeepseekHarnessEvents,
  readDeepseekHarnessEvents,
  type RawSourceMessage
} from "@memmy/agent-source-core";

export { loadDeepseekHarnessEvents } from "@memmy/agent-source-core";

export interface RawDeepseekHarnessMessage extends RawSourceMessage {
  workspacePath: string | null;
}

export async function readDeepseekHarnessSession(
  filePath: string,
  signal?: AbortSignal
): Promise<RawDeepseekHarnessMessage[]> {
  const events = await loadDeepseekHarnessEvents(filePath, signal);
  return (await collect(readDeepseekHarnessEvents(events, signal))).map(withWorkspace);
}

/** Streams one session as staged native turns. Compressed files are decoded first. */
export async function* streamDeepseekHarnessSession(
  filePath: string,
  signal?: AbortSignal
): AsyncIterable<RawDeepseekHarnessMessage> {
  const events = await loadDeepseekHarnessEvents(filePath, signal);
  if (!events.some((event) => event.type === "session")) {
    const fallbackId = basename(filePath).replace(/\.jsonl(?:\.zstd)?$/u, "");
    for await (const message of readDeepseekHarnessEvents([{ type: "session", id: fallbackId }, ...events], signal)) {
      yield withWorkspace(message);
    }
    return;
  }
  for await (const message of readDeepseekHarnessEvents(events, signal)) {
    yield withWorkspace(message);
  }
}

function withWorkspace(message: RawSourceMessage): RawDeepseekHarnessMessage {
  return {
    ...message,
    workspacePath: typeof message.rawMeta.workspacePath === "string" ? message.rawMeta.workspacePath : null
  };
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const value of values) items.push(value);
  return items;
}
