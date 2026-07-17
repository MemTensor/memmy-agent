const SUBAGENT_CHANNEL_RESULT_MAX_CHARS = 800;

export function subagentChannelDisplay(name: string): string {
  return `subagent:${name}`;
}

export function scrubSubagentAnnounceBody(content: string): string {
  const stripped = content.replace(/\r\n/g, "\n").trim();
  const lines = stripped.split(/\n/);
  const header = lines[0]?.startsWith("[Subagent") ? lines[0].trim() : "";
  const lower = stripped.toLowerCase();
  let key = "\nresult:\n";
  let index = lower.indexOf(key);
  if (index === -1) {
    key = "\nresult:";
    index = lower.indexOf(key);
  }
  if (index === -1) return header || stripped;

  let body = stripped.slice(index + key.length).trimStart();
  const summaryIndex = body.toLowerCase().indexOf("summarize this naturally");
  if (summaryIndex !== -1) body = body.slice(0, summaryIndex).trimEnd();
  body = body.trim();
  if (SUBAGENT_CHANNEL_RESULT_MAX_CHARS && body.length > SUBAGENT_CHANNEL_RESULT_MAX_CHARS) {
    body = `${body.slice(0, SUBAGENT_CHANNEL_RESULT_MAX_CHARS - 1).trimEnd()}…`;
  }
  if (header && body) return `${header}\n\n${body}`;
  return header || body || stripped;
}

export function scrubSubagentMessagesForChannel(messages: Array<Record<string, any>>): void {
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.injectedEvent !== "subagentResult") continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    message.content = scrubSubagentAnnounceBody(message.content);
  }
}
