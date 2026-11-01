/** Avatar tint, stable per member name so a member keeps one colour across the board and the @ menu. */
export function memberColor(name: string): string {
  const palette = ["#7c6bd6", "#4b9fd0", "#d98b4a", "#3f9c8a", "#c2698f", "#5b8f4e", "#b0793f", "#5f7bd0"];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) % 100_000;
  return palette[hash % palette.length]!;
}
