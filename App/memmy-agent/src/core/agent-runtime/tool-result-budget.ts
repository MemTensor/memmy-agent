export type ToolResultMaxCharsByName = Readonly<Record<string, number>>;

export const SESSION_TOOL_RESULT_MAX_CHARS_BY_NAME: ToolResultMaxCharsByName = Object.freeze({
  exec: 50_000,
  read_file: 128_000,
});

export function resolveToolResultMaxChars(
  toolName: unknown,
  fallback: number,
  overrides: ToolResultMaxCharsByName = {},
): number {
  const name = typeof toolName === "string" ? toolName : "";
  const override = overrides[name];
  return typeof override === "number" && Number.isInteger(override) && override > 0 ? override : fallback;
}
