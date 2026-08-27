import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type JsonObject = Record<string, unknown>;
export type OptionValue = string | boolean | string[];

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, OptionValue>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, OptionValue> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) continue;

    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (token === "-h" || token === "-v" || token === "-j") {
      const name = token === "-j" ? "json" : token.slice(1);
      const next = argv[index + 1];
      const value = token === "-j" && next && !next.startsWith("--")
        ? argv[++index] ?? ""
        : true;
      addOption(options, name, value);
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equalsIndex = raw.indexOf("=");
    const name = equalsIndex >= 0 ? raw.slice(0, equalsIndex) : raw;
    const inlineValue = equalsIndex >= 0 ? raw.slice(equalsIndex + 1) : undefined;
    const next = argv[index + 1];
    const value = inlineValue !== undefined
      ? inlineValue
      : next && !next.startsWith("--")
      ? argv[++index] ?? ""
      : true;
    addOption(options, name, value);
  }

  return { positionals, options };
}

export function hasOption(options: Record<string, OptionValue>, name: string): boolean {
  return options[name] !== undefined;
}

export function optionString(options: Record<string, OptionValue>, name: string): string | undefined {
  const value = options[name];
  if (Array.isArray(value)) {
    return value[value.length - 1];
  }
  return typeof value === "string" ? value : undefined;
}

export function optionBoolean(options: Record<string, OptionValue>, name: string): boolean | undefined {
  const value = options[name];
  if (value === undefined) return undefined;
  if (value === true) return true;
  const text = Array.isArray(value) ? value[value.length - 1] : value;
  if (text === "true" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "0" || text === "no") return false;
  throw new Error(`--${name} must be a boolean`);
}

export function optionValues(options: Record<string, OptionValue>, name: string): string[] {
  const value = options[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? [value] : [];
}

export async function readBodyObject(options: Record<string, OptionValue>): Promise<JsonObject> {
  const bodyFile = optionString(options, "body-file");
  const bodyText = optionString(options, "body") ?? optionString(options, "json") ?? optionString(options, "data");
  if (bodyFile) {
    return asObject(parseJsonText(await readTextSource(bodyFile)), `--body-file ${bodyFile}`);
  }
  if (!bodyText) {
    return {};
  }
  if (bodyText === "-") {
    return asObject(parseJsonText(await readStdin()), "--json -");
  }
  if (looksLikeJson(bodyText)) {
    return asObject(parseJsonText(bodyText), "--body/--json");
  }
  if (existsSync(bodyText)) {
    return asObject(parseJsonText(await readFile(bodyText, "utf8")), `--json ${bodyText}`);
  }
  return asObject(parseJsonText(bodyText), "--body/--json");
}

export function parseCliValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return "";
  if (looksLikeJson(value)) {
    return parseJsonText(value);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value)) {
    return Number(value);
  }
  return raw;
}

export function parseJsonOrCliValue(raw: string): unknown {
  return looksLikeJson(raw) ? parseJsonText(raw) : parseCliValue(raw);
}

export function parseStringArray(raw: string): string[] {
  const value = parseJsonOrCliValue(raw);
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isRecord(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function requireValue(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function addOption(options: Record<string, OptionValue>, name: string, value: string | boolean): void {
  const existing = options[name];
  if (existing === undefined) {
    options[name] = value;
    return;
  }
  const normalized = typeof value === "string" ? value : String(value);
  if (Array.isArray(existing)) {
    existing.push(normalized);
    return;
  }
  options[name] = [
    typeof existing === "string" ? existing : String(existing),
    normalized
  ];
}

async function readTextSource(path: string): Promise<string> {
  return path === "-" ? readStdin() : readFile(path, "utf8");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid JSON: ${message}`);
  }
}

function looksLikeJson(text: string): boolean {
  const value = text.trim();
  return (
    value.startsWith("{") ||
    value.startsWith("[") ||
    value.startsWith("\"") ||
    value === "true" ||
    value === "false" ||
    value === "null"
  );
}

function asObject(value: unknown, source: string): JsonObject {
  if (isRecord(value)) {
    return { ...value };
  }
  throw new Error(`${source} must be a JSON object`);
}
