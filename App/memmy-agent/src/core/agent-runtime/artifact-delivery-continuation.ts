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

/** Give the Agent one bounded chance to choose and send plugin-produced files. */
export function createArtifactDeliveryContinuation(getDeliveredMediaPaths: () => readonly string[]) {
  let reminded = false;
  return ({ messages }: { finalContent: string; messages: Record<string, any>[] }): string | null => {
    if (reminded) return null;
    const lastUser = messages.findLastIndex((message) => message.role === "user");
    const files = new Map<string, string>();
    for (const message of messages.slice(lastUser + 1)) {
      if (message.role !== "tool" || typeof message.name !== "string"
        || !message.name.startsWith("mcp_plugins_")) continue;
      for (const file of publishedFilesFromPluginResult(message.content)) files.set(file.path, file.name);
    }
    if (!files.size) return null;
    if (getDeliveredMediaPaths().some((path) => files.has(path))) return null;
    reminded = true;
    return "Host delivery check: The plugin produced files, but this turn has not sent a file through message(media). "
      + "The tool result's file list is an inventory, not a delivery checklist. Review the user's requested outcome, "
      + "choose the files needed for that outcome, and include any files required to use the chosen deliverables. "
      + "Do not send every generated file merely because it appears in the inventory. "
      + "Send the chosen files to this conversation with one message(media=[absolute paths]) call and a brief note. "
      + "If you already sent a text-only summary, do not repeat it when attaching the files. Do not send another summary after successful attachment delivery. "
      + "If no file should be sent, explain the specific reason; do not say an automatic delivery card will appear. "
      + "Plugin artifact events alone do not create conversation attachments.";
  };
}
