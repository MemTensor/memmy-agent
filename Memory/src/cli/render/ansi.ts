export interface CliStyle {
  bold(text: string): string;
  dim(text: string): string;
  green(text: string): string;
  cyan(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  gray(text: string): string;
}

export function createCliStyle(options: { color?: boolean } = {}): CliStyle {
  const color = options.color ?? shouldUseColor();
  const wrap = (code: number, text: string): string => color ? `\u001b[${code}m${text}\u001b[0m` : text;

  return {
    bold: (text) => wrap(1, text),
    dim: (text) => wrap(2, text),
    green: (text) => wrap(32, text),
    cyan: (text) => wrap(36, text),
    yellow: (text) => wrap(33, text),
    red: (text) => wrap(31, text),
    gray: (text) => wrap(90, text)
  };
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.MEMMY_FORCE_COLOR === "1") return true;
  return Boolean(process.stdout.isTTY);
}
