/** Reads a Windsurf conversation JSON file.
 *
 * Windsurf stores each conversation as a JSON array of turn objects
 * with ``role`` (``"user"`` / ``"assistant"``) and ``content`` fields.
 */

import { readFile } from "node:fs/promises";

export interface RawWindsurfMessage {
  messageId: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  workspacePath: string | null;
  gitRoot: string | null;
}

interface WindsurfTurn {
  id?: string;
  role?: string;
  content?: string | { type: string; text?: string }[];
  timestamp?: number | string;
}

export async function* readWindsurfConversation(
  filePath: string,
  signal?: AbortSignal,
): AsyncIterable<RawWindsurfMessage> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return;
  }

  let turns: WindsurfTurn[];
  try {
    const parsed = JSON.parse(raw);
    turns = Array.isArray(parsed) ? parsed : parsed.messages ?? [];
  } catch {
    return;
  }

  const conversationId = filePath.split("/").pop()?.replace(".json", "") ?? "unknown";

  for (let i = 0; i < turns.length; i++) {
    if (signal?.aborted) return;
    const turn = turns[i];

    const role = normalizeRole(turn.role);
    if (!role) continue;

    const content = extractContent(turn.content);
    if (!content || content.length === 0) continue;

    yield {
      messageId: turn.id ?? `${conversationId}:${i}`,
      conversationId,
      role,
      content,
      createdAt: normalizeDate(turn.timestamp),
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

function extractContent(content: WindsurfTurn["content"]): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c): c is { type: string; text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("\n");
  }
  return null;
}

function normalizeDate(ts: number | string | undefined): string {
  if (typeof ts === "number") return new Date(ts).toISOString();
  if (typeof ts === "string") return new Date(ts).toISOString();
  return new Date().toISOString();
}
