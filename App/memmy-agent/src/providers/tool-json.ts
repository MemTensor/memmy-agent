import { jsonrepair } from "jsonrepair";

export function parseToolArguments(value: any): Record<string, any> {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;

  const text = String(value).trim();
  if (!text) return {};

  for (const candidate of [text, repairPythonLiterals(text)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next repair strategy.
    }
  }

  try {
    const repaired = jsonrepair(text);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (error: any) {
    return { raw: text, parse_error: String(error?.message ?? error).slice(0, 200) };
  }

  return { raw: text, parse_error: "Tool arguments did not parse to an object" };
}

export function normalizeToolArgumentsString(value: any): string {
  return JSON.stringify(parseToolArguments(value));
}

function repairPythonLiterals(text: string): string {
  return text
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false");
}
