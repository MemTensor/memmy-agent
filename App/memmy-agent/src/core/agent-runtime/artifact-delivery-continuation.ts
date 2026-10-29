type PublishedFile = { name: string; path: string };

/** Reads file inventory from the text or MCP content blocks returned by a plugin tool. */
export function publishedFilesFromPluginResult(result: unknown): PublishedFile[] {
  const texts = typeof result === "string" ? [result] : Array.isArray(result)
    ? result.filter((block): block is { type: "text"; text: string } =>
      block?.type === "text" && typeof block.text === "string").map((block) => block.text)
    : [];
  for (const text of texts) {
    try {
      const parsed = JSON.parse(text.startsWith("[structuredContent]\n")
        ? text.slice("[structuredContent]\n".length) : text) as { publishedFiles?: unknown };
      if (!Array.isArray(parsed.publishedFiles)) continue;
      return parsed.publishedFiles.flatMap((file): PublishedFile[] => file && typeof file === "object"
        && typeof file.name === "string" && file.name && typeof file.path === "string" && file.path
        ? [{ name: file.name, path: file.path }] : []);
    } catch { /* Other text blocks are not file inventories. */ }
  }
  return [];
}

const WRITTEN_FILE_TOOLS = new Set(["write_file", "write", "create_file", "save_file", "new_file"]);

const DELIVERABLE_EXTENSIONS = new Set([
  "html", "htm", "pdf",
  "doc", "docx", "rtf",
  "xls", "xlsx", "csv",
  "ppt", "pptx",
  "md", "markdown",
  "png", "jpg", "jpeg", "gif", "webp", "svg",
]);

function isDeliverableWrittenPath(filePath: string): boolean {
  const base = filePath.split(/[/\\]/).filter(Boolean).pop() ?? filePath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return DELIVERABLE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** Latest assistant prose in this turn. Tool-call messages are not an answer. */
export function assistantAnswerBeforeDelivery(messages: readonly Record<string, any>[]): string | null {
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  for (let index = messages.length - 1; index > lastUser; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) continue;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (content) return content;
  }
  return null;
}

/** Absolute paths from a successful write_file result. Editing tools are not an inventory. */
export function writtenFilesFromToolResult(result: unknown): PublishedFile[] {
  const texts = typeof result === "string" ? [result] : Array.isArray(result)
    ? result.filter((block): block is { type: "text"; text: string } =>
      block?.type === "text" && typeof block.text === "string").map((block) => block.text)
    : [];
  const files: PublishedFile[] = [];
  for (const text of texts) {
    const line = text.split("\n", 1)[0] ?? "";
    const marker = "Successfully wrote ";
    if (!line.startsWith(marker)) continue;
    const path = line.slice(marker.length).trim();
    if (!path.startsWith("/") && !path.startsWith("\\\\") && !/^[a-zA-Z]:[\\/]/.test(path)) continue;
    if (!isDeliverableWrittenPath(path)) continue;
    const name = path.split(/[/\\]/).filter(Boolean).pop() || path;
    files.push({ name, path });
  }
  return files;
}

/** Give the Agent one bounded chance to attach files from this turn through message(media). */
export function createArtifactDeliveryContinuation(getDeliveredMediaPaths: () => readonly string[]) {
  let reminded = false;
  return ({ messages }: { finalContent: string; messages: Record<string, any>[] }): string | null => {
    if (reminded) return null;
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const files = new Map<string, string>();
    for (const message of messages.slice(lastUser + 1)) {
      if (message.role !== "tool" || typeof message.name !== "string") continue;
      const found = message.name.startsWith("mcp_plugins_")
        ? publishedFilesFromPluginResult(message.content)
        : WRITTEN_FILE_TOOLS.has(message.name)
          ? writtenFilesFromToolResult(message.content)
          : [];
      for (const file of found) files.set(file.path, file.name);
    }
    if (!files.size) return null;
    if (getDeliveredMediaPaths().some((path) => files.has(path))) return null;
    reminded = true;
    return "Host delivery check: This turn produced files, but has not sent one through message(media). "
      + "The file list is an inventory, not a delivery checklist. Review the user's requested outcome, "
      + "choose the files the user should open or download, and include any files required to use them. "
      + "Do not send incidental source edits, scratch files, or every generated file merely because it was written. "
      + "The answer already written is the reply. Send the chosen files with one message(media=[absolute paths]) call and omit content. "
      + "The card attaches to that answer. Do not write another summary after the tool returns. "
      + "If no file should be sent, explain the specific reason; do not say an automatic delivery card will appear. "
      + "Writing a file or emitting a plugin artifact does not by itself create a conversation attachment.";
  };
}
