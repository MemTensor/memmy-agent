export function clip(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 3)}...`;
}

export function firstLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function firstSemanticUserLine(value: string): string {
  const userQuery = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i)?.[1];
  const candidate = userQuery ?? value
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "\n")
    .replace(/<system_notification>[\s\S]*?<\/system_notification>/gi, "\n")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/gi, "\n")
    .replace(/<image_files>[\s\S]*?<\/image_files>/gi, "\n");
  return firstLine(candidate.replace(/<\/?[a-z_][^>]*>/gi, "\n"));
}
