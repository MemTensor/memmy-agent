/** Reads a Cline task JSON file.
 *
 * Cline stores each task as a JSON object with a ``messages`` array
 * containing turns with ``role`` and ``content`` fields.
 */

import { readFile } from "node:fs/promises";

export interface RawClineMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

interface ClineTaskFile {
  taskId?: string;
  messages?: ClineTurn[];
  history?: ClineTurn[];
}

interface ClineTurn {
  id?: string | number;
  ts?: number;
  role?: string;
  say?: string;
  text?: string;
  content?: string;
}

export async function* readClineConversation(
  filePath: string,
  signal?: AbortSignal,
): AsyncIterable<RawClineMessage> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return;
  }

  let task: ClineTaskFile;
  try {
    task = JSON.parse(raw);
  } catch {
    return;
  }

  const messages = task.messages ?? task.history ?? [];
  const conversationId = task.taskId ?? filePath.split("/").pop()?.replace(".json", "") ?? "unknown";

  for (let i = 0; i < messages.length; i++) {
    if (signal?.aborted) return;
    const msg = messages[i];

    const role = normalizeRole(msg.role);
    if (!role) continue;

    const content = msg.say ?? msg.text ?? msg.content ?? "";
    if (!content) continue;

    yield {
      messageId: typeof msg.id === "number" ? String(msg.id) : (msg.id as string) ?? `${conversationId}:${i}`,
      conversationId,
      role,
      content,
      createdAt: msg.ts ? new Date(msg.ts).toISOString() : new Date().toISOString(),
      workspacePath: null,
      gitRoot: null,
    };
  }
}

function normalizeRole(role: string | undefined): "user" | "assistant" | null {
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "ai" || role === "bot") return "assistant";
  return null;
}
