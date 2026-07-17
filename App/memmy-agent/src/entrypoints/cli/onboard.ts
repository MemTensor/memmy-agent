import fs from "node:fs";
import { styleText } from "node:util";
import { SelectPrompt, settings as clackSettings, wrapTextWithPrefix } from "@clack/core";
import {
  autocomplete as clackAutocomplete,
  cancel as clackCancel,
  confirm as clackConfirm,
  formatInstructionFooter,
  intro as clackIntro,
  isCancel as clackIsCancel,
  limitOptions,
  log as clackLog,
  note as clackNote,
  outro as clackOutro,
  select as clackSelect,
  SELECT_INSTRUCTIONS,
  S_BAR,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  symbol as clackSymbol,
  symbolBar as clackSymbolBar,
  text as clackText,
} from "@clack/prompts";
import {
  AgentDefaults,
  ApiConfig,
  Base,
  ChannelsConfig,
  Config,
  ContextCompactionConfig,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  GatewayConfig,
  MemmyMemoryConfig,
  ModelPresetConfig,
  ProviderConfig,
  SessionDagConfig,
  ToolsConfig,
} from "../../config/schema.js";
import { discoverAll, getChannel } from "../../integrations/channels/registry.js";
import { PROVIDERS } from "../../providers/registry.js";
import { getModelContextLimit, getModelSuggestions } from "./models.js";

type PromptAnswer<T> = { ask(): Promise<T | null> };
type Choice = string;
type SelectOptions = { choices: Choice[]; default?: Choice | null; qmark?: string };
type PromptBackend = {
  select(message: string, options: SelectOptions | Choice[]): PromptAnswer<Choice>;
  confirm(message: string, options?: { default?: boolean }): PromptAnswer<boolean>;
  text(message: string, options?: { default?: string; validate?: (value: string) => true | string }): PromptAnswer<string>;
  autocomplete(message: string, options?: { choices?: Choice[]; default?: string }): PromptAnswer<string>;
  pressAnyKeyToContinue(): PromptAnswer<null>;
};

type Dict = Record<string, any>;

export class OnboardResult {
  config: Config;
  shouldSave: boolean;
  changed: boolean;

  constructor(init: Config | { config?: Config; shouldSave?: boolean; changed?: boolean } = new Config(), changed = false) {
    if (init instanceof Config) {
      this.config = init;
      this.shouldSave = true;
      this.changed = changed;
    } else {
      this.config = init.config ?? new Config();
      this.shouldSave = init.shouldSave ?? true;
      this.changed = init.changed ?? this.shouldSave;
    }
  }
}

export type FieldTypeName = "boolean" | "integer" | "number" | "array" | "object" | "model" | "literal" | "string";

export class FieldTypeInfo {
  typeName: FieldTypeName;
  innerType: any;

  constructor(typeName: FieldTypeName, innerType: any = null) {
    this.typeName = typeName;
    this.innerType = innerType;
  }

  [Symbol.iterator](): Iterator<any> {
    return [this.typeName, this.innerType][Symbol.iterator]();
  }
}

export const SELECT_FIELD_HINTS: Record<string, [string[], string]> = {
  reasoningEffort: [["low", "medium", "high"], "low / medium / high - enables LLM thinking mode"],
  providerRetryMode: [["standard", "persistent"], "standard / persistent"],
  summaryMode: [["text", "dag"], "text / dag"],
};

export const BACK_PRESSED = Symbol("BACK_PRESSED");
export const MODEL_PRESET_CACHE = new Set<string>();

const SENSITIVE_KEYWORDS = new Set(["apiKey", "token", "secret", "password", "credentials"]);
const OPTIONAL_STRING_FIELDS = new Set(["apiKey", "apiBase"]);

let promptBackend: PromptBackend | null = null;
let clackPromptBackend: PromptBackend | null = null;

function isWouldBlockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

function readLineFromFd(fd: number, returnNullOnWouldBlock = false): string | null {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(1);
  while (true) {
    try {
      const read = fs.readSync(fd, buf, 0, 1, null);
      if (!read) break;
      if (buf[0] === 10 || buf[0] === 13) break;
      chunks.push(Buffer.from(buf));
    } catch (error) {
      if (returnNullOnWouldBlock && isWouldBlockError(error)) return null;
      throw error;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function readLineFromTty(): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync("/dev/tty", "r");
    return readLineFromFd(fd);
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function readLineSync(prompt: string, defaultValue = ""): string {
  process.stdout.write(prompt);
  const ttyValue = process.stdin.isTTY ? readLineFromTty() : null;
  const value = ttyValue ?? readLineFromFd(0, true);
  return value || defaultValue;
}

function normalizeChoices(options: SelectOptions | Choice[]): SelectOptions {
  return Array.isArray(options) ? { choices: options } : options;
}

function canUseClackPromptBackend(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function shouldUseClackPromptUi(): boolean {
  return promptBackend == null && canUseClackPromptBackend();
}

function normalizeClackResult<T>(result: T | symbol): T | null {
  if (clackIsCancel(result)) {
    clackCancel("Canceled");
    return null;
  }
  return result;
}

function clackOptions(choices: Choice[]): Array<{ value: Choice; label: Choice }> {
  return choices.map((choice) => ({ value: choice, label: choice }));
}

type ClackChoiceOption = { value: Choice; label: Choice; hint?: string; disabled?: boolean };
type ChoiceState = "disabled" | "selected" | "active" | "cancelled" | "inactive";

function styleLines(value: string, styler: (line: string) => string): string {
  return value.includes("\n") ? value.split("\n").map((line) => styler(line)).join("\n") : styler(value);
}

function formatChoiceOption(option: ClackChoiceOption, state: ChoiceState): string {
  const label = option.label ?? String(option.value);
  if (state === "disabled") {
    return `${styleText("gray", S_RADIO_INACTIVE)} ${styleLines(label, (line) => styleText("gray", line))}${option.hint ? ` ${styleText("dim", `(${option.hint ?? "disabled"})`)}` : ""}`;
  }
  if (state === "selected") return styleLines(label, (line) => styleText("dim", line));
  if (state === "active") {
    return `${styleText("green", S_RADIO_ACTIVE)} ${label}${option.hint ? ` ${styleText("dim", `(${option.hint})`)}` : ""}`;
  }
  if (state === "cancelled") return styleLines(label, (line) => styleText(["strikethrough", "dim"], line));
  return `${styleText("dim", S_RADIO_INACTIVE)} ${styleLines(label, (line) => styleText("dim", line))}`;
}

function shortcutChoices(choices: Choice[]): Map<string, Choice> {
  const shortcuts = new Map<string, Choice>();
  const seen = new Set<string>();
  for (const choice of choices) {
    const shortcut = choice.match(/^\[([A-Za-z])\]/)?.[1].toLowerCase();
    if (!shortcut || seen.has(shortcut)) continue;
    seen.add(shortcut);
    shortcuts.set(shortcut, choice);
  }
  return shortcuts;
}

function keyName(input: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }): string | null {
  if (key.ctrl || key.meta) return null;
  const name = key.name ?? input;
  return name?.length === 1 && /^[a-z]$/i.test(name) ? name.toLowerCase() : null;
}

async function selectWithShortcutKeys(message: string, choices: Choice[], defaultChoice: Choice | null = null): Promise<Choice | null> {
  if (!shouldUseClackPromptUi()) {
    return getQuestionary().select(message, { choices, default: defaultChoice ?? choices[0] }).ask();
  }
  const shortcuts = shortcutChoices(choices);
  if (!shortcuts.size) {
    return getQuestionary().select(message, { choices, default: defaultChoice ?? choices[0] }).ask();
  }
  const options = clackOptions(choices);
  const prompt = new SelectPrompt<ClackChoiceOption>({
    options,
    input: process.stdin,
    output: process.stdout,
    initialValue: defaultChoice ?? choices[0],
    render() {
      const withGuide = clackSettings.withGuide;
      const messagePrefix = `${clackSymbol(this.state)}  `;
      const linePrefix = `${clackSymbolBar(this.state)}  `;
      const promptMessage = wrapTextWithPrefix(process.stdout, message, linePrefix, messagePrefix);
      const header = `${withGuide ? `${styleText("gray", S_BAR)}\n` : ""}${promptMessage}\n`;
      if (this.state === "submit") {
        const selectedPrefix = withGuide ? `${styleText("gray", S_BAR)}  ` : "";
        return `${header}${wrapTextWithPrefix(process.stdout, formatChoiceOption(this.options[this.cursor], "selected"), selectedPrefix)}`;
      }
      if (this.state === "cancel") {
        const selectedPrefix = withGuide ? `${styleText("gray", S_BAR)}  ` : "";
        return `${header}${wrapTextWithPrefix(process.stdout, formatChoiceOption(this.options[this.cursor], "cancelled"), selectedPrefix)}${withGuide ? `\n${styleText("gray", S_BAR)}` : ""}`;
      }
      const optionPrefix = withGuide ? `${styleText("cyan", S_BAR)}  ` : "";
      const messageRows = header.split("\n").length;
      const footer = formatInstructionFooter(SELECT_INSTRUCTIONS, withGuide);
      return `${header}${optionPrefix}${limitOptions({
        output: process.stdout,
        cursor: this.cursor,
        options: this.options,
        columnPadding: optionPrefix.length,
        rowPadding: messageRows + footer.length + 1,
        style: (option, active) => formatChoiceOption(option, option.disabled ? "disabled" : active ? "active" : "inactive"),
      }).join(`\n${optionPrefix}`)}
${footer.join("\n")}
`;
    },
  });
  prompt.on("key", (input, key) => {
    const shortcut = keyName(input, key);
    const choice = shortcut ? shortcuts.get(shortcut) : null;
    if (!choice) return;
    const index = options.findIndex((option) => option.value === choice);
    if (index < 0) return;
    prompt.cursor = index;
    prompt.value = choice;
    prompt.state = "submit";
  });
  const value = await prompt.prompt();
  return value == null ? null : normalizeClackResult(value);
}

function createClackPromptBackend(): PromptBackend {
  return {
    select(message, options) {
      const { choices, default: defaultChoice = null } = normalizeChoices(options);
      return {
        async ask() {
          const value = await clackSelect({
            message,
            options: clackOptions(choices),
            initialValue: defaultChoice ?? undefined,
          });
          return normalizeClackResult(value);
        },
      };
    },
    confirm(message, options = {}) {
      return {
        async ask() {
          const value = await clackConfirm({ message, initialValue: options.default ?? false });
          return normalizeClackResult(value);
        },
      };
    },
    text(message, options = {}) {
      return {
        async ask() {
          const value = await clackText({
            message,
            defaultValue: options.default ?? "",
            initialValue: options.default ?? "",
            validate: options.validate
              ? (input) => {
                  const validation = options.validate?.(input ?? "");
                  return validation === true ? undefined : validation;
                }
              : undefined,
          });
          return normalizeClackResult(value);
        },
      };
    },
    autocomplete(message, options = {}) {
      return {
        async ask() {
          if (!options.choices?.length) {
            const value = await clackText({
              message,
              defaultValue: options.default ?? "",
              initialValue: options.default ?? "",
            });
            return normalizeClackResult(value);
          }
          const value = await clackAutocomplete({
            message,
            options: clackOptions(options.choices),
            initialValue: options.default || undefined,
            initialUserInput: options.default || undefined,
          });
          return normalizeClackResult(value);
        },
      };
    },
    pressAnyKeyToContinue() {
      return {
        async ask() {
          const value = await clackText({ message: "Press Enter to continue...", defaultValue: "", initialValue: "" });
          normalizeClackResult(value);
          return null;
        },
      };
    },
  };
}

function createConsolePromptBackend(): PromptBackend {
  return {
    select(message, options) {
      const { choices, default: defaultChoice = null } = normalizeChoices(options);
      return {
        async ask() {
          process.stdout.write(`${message}\n`);
          choices.forEach((choice, index) => process.stdout.write(`  ${index + 1}. ${choice}\n`));
          const defaultIndex = defaultChoice ? choices.indexOf(defaultChoice) + 1 : 1;
          const raw = readLineSync(`> [${defaultIndex}] `, String(defaultIndex));
          const idx = Number.parseInt(raw, 10);
          if (Number.isFinite(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1];
          return choices.includes(raw) ? raw : choices[defaultIndex - 1] ?? choices[0] ?? null;
        },
      };
    },
    confirm(message, options = {}) {
      return {
        async ask() {
          const yes = options.default ?? false;
          const raw = readLineSync(`${message} ${yes ? "[Y/n]" : "[y/N]"} `, yes ? "y" : "n").trim().toLowerCase();
          return ["y", "yes", "true", "1"].includes(raw);
        },
      };
    },
    text(message, options = {}) {
      return {
        async ask() {
          while (true) {
            const value = readLineSync(`${message} `, options.default ?? "");
            const validation = options.validate?.(value);
            if (validation === true || validation == null) return value;
            process.stderr.write(`${validation}\n`);
          }
        },
      };
    },
    autocomplete(message, options = {}) {
      return {
        async ask() {
          return readLineSync(`${message} `, options.default ?? "");
        },
      };
    },
    pressAnyKeyToContinue() {
      return {
        async ask() {
          readLineSync("Press Enter to continue...");
          return null;
        },
      };
    },
  };
}

export function setQuestionary(backend: PromptBackend | null): void {
  promptBackend = backend;
}

export function getQuestionary(): PromptBackend {
  if (promptBackend) return promptBackend;
  if (!canUseClackPromptBackend()) return createConsolePromptBackend();
  clackPromptBackend ??= createClackPromptBackend();
  return clackPromptBackend;
}

function shouldRenderPromptUi(): boolean {
  return promptBackend == null || Boolean(process.stdin.isTTY);
}

function setField(model: any, fieldName: string, value: any): void {
  model[fieldName] = value;
}

function cloneValue<T>(value: T): T {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  const clone = Object.create(Object.getPrototypeOf(value));
  for (const [key, item] of Object.entries(value as Dict)) clone[key] = cloneValue(item);
  return clone;
}

function dumpComparable(value: any): any {
  if (value && typeof value.toObject === "function") return value.toObject();
  if (Array.isArray(value)) return value.map(dumpComparable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, dumpComparable(item)]));
  }
  return value;
}

function valueTypeInfo(value: any): FieldTypeInfo {
  if (typeof value === "boolean") return new FieldTypeInfo("boolean");
  if (typeof value === "number") return new FieldTypeInfo(Number.isInteger(value) ? "integer" : "number");
  if (Array.isArray(value)) return new FieldTypeInfo("array", String);
  if (value instanceof Base || value instanceof Config) return new FieldTypeInfo("model", value.constructor);
  if (value && typeof value === "object") return new FieldTypeInfo("object");
  return new FieldTypeInfo("string");
}

function fieldInfoFor(model: any, key: string): any {
  const typeInfo = valueTypeInfo(model[key]);
  return {
    annotation: typeInfo.typeName === "model" ? typeInfo.innerType : typeInfo.typeName,
    inner: typeInfo.innerType,
    value: model[key],
    nullable: model[key] == null || OPTIONAL_STRING_FIELDS.has(key),
    min: key === "sendMaxRetries" ? 0 : undefined,
    max: key === "sendMaxRetries" ? 10 : undefined,
    choices: SELECT_FIELD_HINTS[key]?.[0],
  };
}

function editableFields(model: any, skipFields: Set<string> = new Set()): Array<[string, any]> {
  const keys = Object.keys(model).filter((key) => {
    if (skipFields.has(key)) return false;
    if (key.startsWith("_")) return false;
    if (typeof model[key] === "function") return false;
    return true;
  });
  return keys.map((key) => [key, fieldInfoFor(model, key)]);
}

export function syncPresetCache(config: Config): void {
  MODEL_PRESET_CACHE.clear();
  for (const name of Object.keys(config.modelPresets)) MODEL_PRESET_CACHE.add(name);
}

export function getFieldTypeInfo(fieldInfo: any): FieldTypeInfo {
  if (fieldInfo instanceof FieldTypeInfo) return fieldInfo;
  if (fieldInfo?.value !== undefined && !fieldInfo.annotation && !fieldInfo.type) return valueTypeInfo(fieldInfo.value);
  const annotation = fieldInfo?.annotation ?? fieldInfo?.type ?? fieldInfo;
  if (annotation instanceof FieldTypeInfo) return annotation;
  if (fieldInfo?.choices || Array.isArray(annotation?.choices)) return new FieldTypeInfo("literal", fieldInfo?.choices ?? annotation.choices);
  if (annotation === String || annotation === "string") return new FieldTypeInfo("string");
  if (annotation === Boolean || annotation === "boolean") return new FieldTypeInfo("boolean");
  if (annotation === "integer" || annotation === BigInt || fieldInfo?.integer) return new FieldTypeInfo("integer");
  if (annotation === Number || annotation === "number") return new FieldTypeInfo(fieldInfo?.integer ? "integer" : "number");
  if (annotation === Array || annotation === "array") return new FieldTypeInfo("array", fieldInfo?.inner ?? String);
  if (annotation === Object || annotation === "object") return new FieldTypeInfo("object");
  if (typeof annotation === "function" && annotation.prototype) return new FieldTypeInfo("model", annotation);
  if (Array.isArray(annotation) && annotation.includes("null")) return new FieldTypeInfo(annotation.find((item) => item !== "null") ?? "string");
  return new FieldTypeInfo("string");
}

export function getFieldDisplayName(fieldKey: string, fieldInfo: any = null): string {
  if (fieldInfo?.description) return fieldInfo.description;
  const suffixMap: Array<[RegExp, string]> = [
    [/S$/, " (seconds)"],
    [/Ms$/, " (ms)"],
    [/Url$/, " URL"],
    [/Path$/, " Path"],
    [/Id$/, " ID"],
    [/Key$/, " Key"],
    [/Token$/, " Token"],
  ];
  let name = fieldKey;
  for (const [suffix, replacement] of suffixMap) {
    if (suffix.test(name)) {
      name = name.replace(suffix, replacement);
      break;
    }
  }
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(" ")
    .map((part) => (part ? `${part[0].toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

export function isSensitiveField(fieldName: string): boolean {
  const lower = fieldName.toLowerCase();
  return [...SENSITIVE_KEYWORDS].some((keyword) => lower.includes(keyword.toLowerCase()));
}

export function maskValue(value: string): string {
  return value.length <= 4 ? "****" : `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

export function formatValue(value: any, { rich = true, fieldName = "" }: { rich?: boolean; fieldName?: string } = {}): string {
  const effectiveField = fieldName;
  if (value == null || value === "" || (Array.isArray(value) && !value.length) || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length)) {
    return rich ? "[dim]not set[/dim]" : "[not set]";
  }
  if (isSensitiveField(effectiveField) && typeof value === "string") {
    const masked = maskValue(value);
    return rich ? `[dim]${masked}[/dim]` : masked;
  }
  if (Array.isArray(value)) return value.map((item) => (typeof item === "string" ? item : JSON.stringify(dumpComparable(item)))).join(", ");
  if (value instanceof ModelPresetConfig) return `model=${value.model}, provider=${value.provider}, maxTokens=${value.maxTokens}`;
  if (value instanceof ProviderConfig) return `apiKey=${formatValue(value.apiKey, { rich: false, fieldName: "apiKey" })}, apiBase=${value.apiBase ?? "[not set]"}`;
  if (value instanceof Config) return `model=${value.resolvePreset().model}`;
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, val]) => `${key}: ${formatValue(val, { rich: false, fieldName: key })}`)
      .join(", ");
  }
  return String(value);
}

export function formatValueForInput(value: any, fieldType: string): string {
  if (value == null || value === "") return "";
  if (fieldType === "array" && Array.isArray(value)) return value.map(String).join(",");
  if (fieldType === "object" && typeof value === "object") return JSON.stringify(dumpComparable(value));
  return String(value);
}

export function validateFieldConstraintMessage(
  value: unknown,
  constraint?: { choices?: unknown[]; min?: number; max?: number; ge?: number; le?: number; gt?: number; lt?: number; minLength?: number; maxLength?: number; min_length?: number; max_length?: number } | null,
): string | null {
  if (!constraint) return null;
  if (constraint.choices && !constraint.choices.includes(value)) return `Value must be one of: ${constraint.choices.join(", ")}`;
  if (typeof value === "number") {
    const ge = constraint.ge ?? constraint.min;
    const le = constraint.le ?? constraint.max;
    if (ge != null && value < ge) return `Value must be >= ${ge}`;
    if (constraint.gt != null && value <= constraint.gt) return `Value must be > ${constraint.gt}`;
    if (le != null && value > le) return `Value must be <= ${le}`;
    if (constraint.lt != null && value >= constraint.lt) return `Value must be < ${constraint.lt}`;
  }
  const length = typeof value === "string" || Array.isArray(value) ? value.length : null;
  if (length != null) {
    const minLength = constraint.minLength ?? constraint.min_length;
    const maxLength = constraint.maxLength ?? constraint.max_length;
    if (minLength != null && length < minLength) return `Length must be >= ${minLength}`;
    if (maxLength != null && length > maxLength) return `Length must be <= ${maxLength}`;
  }
  return null;
}

export function validateFieldConstraint(value: unknown, constraint?: Parameters<typeof validateFieldConstraintMessage>[1]): boolean {
  return validateFieldConstraintMessage(value, constraint) == null;
}

export function getConstraintHint(constraint?: { min?: number; max?: number; ge?: number; le?: number } | null): string {
  if (!constraint) return "";
  const ge = constraint.ge ?? constraint.min;
  const le = constraint.le ?? constraint.max;
  if (ge != null && le != null) return ` (${ge}-${le})`;
  if (ge != null) return ` (>= ${ge})`;
  if (le != null) return ` (<= ${le})`;
  return "";
}

export function isStringOrNull(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.includes("| null") || value.includes("Optional");
  if (Array.isArray(value)) return value.includes("string") && value.includes("null");
  if (typeof value === "object") return Boolean((value as Dict).nullable || (value as Dict).optional);
  return false;
}

export async function inputText(displayName: string, current: any, fieldType: string, fieldInfo: any = null): Promise<any> {
  const value = await getQuestionary().text(`${displayName}:`, { default: formatValueForInput(current, fieldType) }).ask();
  if (value == null) return null;
  if (fieldType === "integer") {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) return null;
    return validateFieldConstraintMessage(parsed, fieldInfo) ? null : parsed;
  }
  if (fieldType === "number") {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return null;
    return validateFieldConstraintMessage(parsed, fieldInfo) ? null : parsed;
  }
  if (fieldType === "array") return value.split(",").map((item) => item.trim()).filter(Boolean);
  if (fieldType === "object") {
    try {
      return JSON.parse(value || "{}");
    } catch {
      return null;
    }
  }
  return validateFieldConstraintMessage(value, fieldInfo) ? null : value;
}

export async function inputBool(displayName: string, current: boolean | null | undefined): Promise<boolean | null> {
  return getQuestionary().confirm(displayName, { default: current == null ? false : Boolean(current) }).ask();
}

export async function inputWithExisting(displayName: string, current: any, fieldType: string, fieldInfo: any = null): Promise<any> {
  const hasExisting = current != null && current !== "" && !(Array.isArray(current) && current.length === 0) && !(typeof current === "object" && !Array.isArray(current) && Object.keys(current).length === 0);
  if (hasExisting && !Array.isArray(current)) {
    const choice = await getQuestionary().select(displayName, { choices: ["Enter new value", "Keep existing value"], default: "Keep existing value" }).ask();
    if (choice === "Keep existing value" || choice == null) return null;
  }
  return inputText(displayName, current, fieldType, fieldInfo);
}

export async function selectWithBack(message: string, choices: string[], defaultChoice: string | null = null): Promise<string | typeof BACK_PRESSED | null> {
  if (!choices.length) return null;
  const fullChoices = choices.includes("<- Back") ? choices : [...choices, "<- Back"];
  const answer = await getQuestionary().select(message, { choices: fullChoices, default: defaultChoice && fullChoices.includes(defaultChoice) ? defaultChoice : fullChoices[0] }).ask();
  if (answer == null || answer === "<- Back") return BACK_PRESSED;
  return answer;
}

export function getCurrentProvider(model: any): string {
  return model?.provider || "auto";
}

export async function inputModelWithAutocomplete(displayName: string, current: any, provider: string): Promise<string | null> {
  const suggestions = getModelSuggestions(String(current ?? ""), provider, 50);
  return getQuestionary().autocomplete(`${displayName}:`, { choices: suggestions, default: current ? String(current) : "" }).ask();
}

export async function inputContextWindowWithRecommendation(displayName: string, current: any, modelObj: any): Promise<number | null> {
  const choices = ["Enter new value"];
  if (current) choices.push("Keep existing value");
  choices.push("[?] Get recommended value");
  const choice = await getQuestionary().select(displayName, { choices, default: "Enter new value" }).ask();
  if (choice == null || choice === "Keep existing value") return null;
  if (choice === "[?] Get recommended value") {
    const modelName = modelObj?.model;
    if (modelName) {
      const limit = getModelContextLimit(modelName, getCurrentProvider(modelObj));
      if (limit) return limit;
    }
  }
  const raw = await getQuestionary().text(`${displayName}:`, { default: current ? String(current) : "" }).ask();
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function tryAutoFillContextWindow(model: any, newModelName: string, lookup: (model: string, provider: string) => number | null = getModelContextLimit): boolean {
  if (!model || !("contextWindowTokens" in model)) return false;
  const current = model.contextWindowTokens;
  if (current !== DEFAULT_CONTEXT_WINDOW_TOKENS) return false;
  const limit = lookup(newModelName, getCurrentProvider(model));
  if (!limit) return false;
  setField(model, "contextWindowTokens", limit);
  return true;
}

export async function handleModelField(workingModel: any, fieldName: string, fieldDisplay: string, currentValue: any): Promise<void> {
  const value = await inputModelWithAutocomplete(fieldDisplay, currentValue, getCurrentProvider(workingModel));
  if (value != null && value !== currentValue) {
    setField(workingModel, fieldName, value);
    tryAutoFillContextWindow(workingModel, value);
  }
}

export async function handleContextWindowField(workingModel: any, fieldName: string, fieldDisplay: string, currentValue: any): Promise<void> {
  const value = await inputContextWindowWithRecommendation(fieldDisplay, currentValue, workingModel);
  if (value != null) setField(workingModel, fieldName, value);
}

export async function handleModelPresetField(
  workingModel: any,
  fieldName = "modelPreset",
  fieldDisplayOrSelected = "Model Preset",
  currentValue: any = null,
  selected?: string | null | typeof BACK_PRESSED,
): Promise<void> {
  let fieldDisplay = fieldDisplayOrSelected;
  let chosen = selected;
  if (arguments.length <= 3 && (fieldDisplayOrSelected === "(clear/unset)" || MODEL_PRESET_CACHE.has(String(fieldDisplayOrSelected)))) {
    fieldDisplay = "Model Preset";
    chosen = fieldDisplayOrSelected;
  }
  if (chosen === undefined) {
    const choices = ["(clear/unset)", ...[...MODEL_PRESET_CACHE].sort()];
    chosen = await selectWithBack(fieldDisplay, choices, currentValue ? String(currentValue) : "(clear/unset)");
  }
  if (chosen === BACK_PRESSED) return;
  if (chosen === "(clear/unset)" || chosen === "") setField(workingModel, fieldName, null);
  else if (chosen != null && MODEL_PRESET_CACHE.has(String(chosen))) setField(workingModel, fieldName, chosen);
}

export async function handleProviderField(workingModel: any, fieldName: string, fieldDisplay: string, currentValue: any): Promise<void> {
  const choices = ["auto", ...Object.keys(getProviderNames()).sort()];
  const selected = await selectWithBack(fieldDisplay, choices, currentValue ? String(currentValue) : "auto");
  if (selected !== BACK_PRESSED && selected != null) setField(workingModel, fieldName, selected);
}

export async function handleFallbackModelsField(workingModel: any, fieldName: string, fieldDisplay: string, currentValue: any): Promise<void> {
  const items = Array.isArray(currentValue) ? [...currentValue] : [];
  while (true) {
    const choices = ["[+] Add preset"];
    if (items.length) choices.push("[-] Remove last", "[X] Clear all");
    choices.push("[Done]", "<- Back");
    const answer = await getQuestionary().select("Manage fallback models:", { choices, default: "[Done]" }).ask();
    if (answer == null || answer === "<- Back") return;
    if (answer === "[Done]") {
      setField(workingModel, fieldName, items);
      return;
    }
    if (answer === "[+] Add preset") {
      const addChoices = [...MODEL_PRESET_CACHE].sort().filter((name) => !items.includes(name));
      if (!addChoices.length) {
        await getQuestionary().pressAnyKeyToContinue().ask();
        continue;
      }
      const picked = await selectWithBack("Select preset:", addChoices);
      if (picked !== BACK_PRESSED && picked != null) items.push(picked);
    } else if (answer === "[-] Remove last") {
      items.pop();
    } else if (answer === "[X] Clear all") {
      items.splice(0);
    }
  }
}

const FIELD_HANDLERS: Record<string, (workingModel: any, fieldName: string, fieldDisplay: string, currentValue: any) => Promise<void>> = {
  model: handleModelField,
  contextWindowTokens: handleContextWindowField,
  modelPreset: handleModelPresetField,
  provider: handleProviderField,
  fallbackModels: handleFallbackModelsField,
};

export async function configureDraftModel(model: any, displayName: string, { skipFields = new Set<string>() }: { skipFields?: Set<string> } = {}): Promise<any | null> {
  const workingModel = cloneValue(model);
  const fields = editableFields(workingModel, skipFields);
  if (!fields.length) return workingModel;
  let lastFieldName: string | null = null;
  while (true) {
    showConfigPanel(displayName, workingModel, fields);
    const choices = fields.map(([name, info]) => {
      const display = getFieldDisplayName(name, info);
      return `${display}: ${formatValue(workingModel[name], { rich: false, fieldName: name })}`;
    }).concat("[Done]");
    const defaultChoice = lastFieldName ? choices[fields.findIndex(([name]) => name === lastFieldName)] : null;
    const answer = await selectWithBack("Select field to configure:", choices, defaultChoice ?? undefined);
    if (answer === BACK_PRESSED || answer == null) return null;
    if (answer === "[Done]") return workingModel;
    const fieldIdx = choices.indexOf(answer);
    if (fieldIdx < 0 || fieldIdx >= fields.length) return null;
    const [fieldName, fieldInfo] = fields[fieldIdx];
    lastFieldName = fieldName;
    const currentValue = workingModel[fieldName];
    const typeInfo = getFieldTypeInfo(fieldInfo);
    const fieldDisplay = getFieldDisplayName(fieldName, fieldInfo) + getConstraintHint(fieldInfo);
    if (typeInfo.typeName === "model") {
      const nested = currentValue ?? new typeInfo.innerType();
      const updated = await configureDraftModel(nested, fieldDisplay);
      if (updated != null) setField(workingModel, fieldName, updated);
      continue;
    }
    const handler = FIELD_HANDLERS[fieldName];
    if (handler) {
      await handler(workingModel, fieldName, fieldDisplay, currentValue);
      continue;
    }
    if (fieldName in SELECT_FIELD_HINTS) {
      const [hintChoices] = SELECT_FIELD_HINTS[fieldName];
      const selected = await selectWithBack(fieldDisplay, [...hintChoices, "(clear/unset)"], currentValue ? String(currentValue) : hintChoices[0]);
      if (selected === BACK_PRESSED) continue;
      setField(workingModel, fieldName, selected === "(clear/unset)" ? null : selected);
      continue;
    }
    if (typeInfo.typeName === "literal" && typeInfo.innerType?.length) {
      const selected = await selectWithBack(fieldDisplay, typeInfo.innerType.map(String), currentValue ? String(currentValue) : String(typeInfo.innerType[0]));
      if (selected !== BACK_PRESSED && selected != null) setField(workingModel, fieldName, selected);
      continue;
    }
    const newValue = typeInfo.typeName === "boolean" ? await inputBool(fieldDisplay, currentValue) : await inputWithExisting(fieldDisplay, currentValue, typeInfo.typeName, fieldInfo);
    if (newValue != null) setField(workingModel, fieldName, newValue === "" && isStringOrNull(fieldInfo) ? null : newValue);
  }
}

export type PresetAction =
  | { type: "add"; name: string; preset: ModelPresetConfig | Record<string, any> }
  | { type: "edit"; name: string; preset: ModelPresetConfig | Record<string, any> }
  | { type: "delete"; name: string };

export async function configureModelPresets(config: Config, actions: PresetAction[] | null = null): Promise<Config> {
  syncPresetCache(config);
  if (actions) {
    for (const action of actions) {
      if (action.type === "delete") {
        delete config.modelPresets[action.name];
      } else {
        if (!action.name || action.name === "default") throw new Error("model preset name is invalid or reserved");
        config.modelPresets[action.name] =
          action.preset instanceof ModelPresetConfig ? action.preset : new ModelPresetConfig(action.preset);
      }
      syncPresetCache(config);
    }
    return config;
  }

  while (true) {
    showSectionHeader("Model Presets", "Create, edit or delete named model presets for quick switching");
    const choices = Object.entries(config.modelPresets).map(([name, preset]) => `${name} (${preset.model})`);
    choices.push("[+] Add new preset", "<- Back");
    const answer = await selectWithBack("Select preset:", choices);
    if (answer === BACK_PRESSED || answer == null || answer === "<- Back") break;
    if (answer === "[+] Add new preset") {
      const name = (await getQuestionary().text("Preset name:", { validate: (value) => (value.trim() ? true : "Name cannot be empty") }).ask())?.trim();
      if (!name) continue;
      if (name === "default" || name in config.modelPresets) continue;
      const updated = await configureDraftModel(
        new ModelPresetConfig({
          model: config.agents.defaults.model,
          provider: config.agents.defaults.provider,
        }),
        `New Preset: ${name}`,
      );
      if (updated) {
        config.modelPresets[name] = updated;
        syncPresetCache(config);
      }
      continue;
    }
    const presetName = answer.split(" (", 1)[0];
    const preset = config.modelPresets[presetName];
    if (!preset) continue;
    const actionChoices = presetName === "default" ? ["Edit", "Cancel"] : ["Edit", "Delete", "Cancel"];
    const action = await selectWithBack(`Preset: ${presetName}`, actionChoices, "Edit");
    if (action === "Delete") {
      if (await getQuestionary().confirm(`Delete preset '${presetName}'?`, { default: false }).ask()) {
        delete config.modelPresets[presetName];
        syncPresetCache(config);
      }
    } else if (action === "Edit") {
      const updated = await configureDraftModel(preset, `Edit Preset: ${presetName}`);
      if (updated) config.modelPresets[presetName] = updated;
    }
  }
  return config;
}

export function getProviderInfo(): Record<string, [string, boolean, boolean, string]> {
  return Object.fromEntries(
    PROVIDERS.filter((spec) => !spec.isOauth).map((spec) => [
      spec.name,
      [spec.displayName || spec.name, spec.isGateway, spec.isLocal, spec.defaultApiBase],
    ]),
  );
}

export function getProviderNames(): Record<string, string> {
  return Object.fromEntries(Object.entries(getProviderInfo()).map(([name, info]) => [name, info[0]]));
}

export async function configureProvider(config: Config, providerName: string): Promise<void> {
  const provider = (config.providers as any)[providerName] ?? new ProviderConfig();
  const info = getProviderInfo()[providerName];
  const displayName = info?.[0] ?? providerName;
  const defaultApiBase = info?.[3];
  if (defaultApiBase && !provider.apiBase) provider.apiBase = defaultApiBase;
  const updated = await configureDraftModel(provider, displayName);
  if (updated) (config.providers as any)[providerName] = updated;
}

export async function configureProviders(config: Config): Promise<void> {
  const names = getProviderNames();
  const entries = Object.entries(names).sort((left, right) => left[1].localeCompare(right[1]));
  while (true) {
    showSectionHeader("LLM Providers", "Select a provider to configure API key and endpoint");
    const choices = entries.map(([name, display]) => {
      const provider = (config.providers as any)[name];
      return provider?.apiKey ? `${display} *` : display;
    });
    const answer = await selectWithBack("Select provider:", choices);
    if (answer === BACK_PRESSED || answer == null) break;
    const display = answer.replace(/ \*$/, "");
    const found = entries.find(([, providerDisplay]) => providerDisplay === display);
    if (found) await configureProvider(config, found[0]);
  }
}

export function getChannelInfo(): Record<string, [string, any]> {
  return Object.fromEntries(
    Object.entries(discoverAll()).map(([name, cls]) => [
      name,
      [(cls as any).displayName ?? cls.name ?? name, (cls as any).defaultConfig?.() ?? {}],
    ]),
  );
}

export function getChannelNames(): Record<string, string> {
  return Object.fromEntries(Object.entries(getChannelInfo()).map(([name, info]) => [name, info[0]]));
}

export function getChannelConfigClass(channel: string): any | null {
  return getChannel(channel) ?? null;
}

export async function configureChannel(config: Config, channelName: string): Promise<void> {
  const cls = getChannel(channelName);
  const defaults = (cls as any)?.defaultConfig?.() ?? { enabled: false };
  const current = (config.channels as any)[channelName] ?? defaults;
  const updated = await configureDraftModel({ ...defaults, ...current }, `Channel: ${channelName}`);
  if (updated) (config.channels as any)[channelName] = updated;
}

export async function configureChannels(config: Config): Promise<void> {
  const choices = Object.keys(getChannelNames()).sort();
  let defaultChoice: string | null = null;
  while (true) {
    const answer = await selectWithBack("Select channel:", choices, defaultChoice);
    if (answer === BACK_PRESSED || answer == null) break;
    defaultChoice = answer;
    await configureChannel(config, answer);
  }
}

export const SETTINGS_SECTIONS = [
  "Agent Settings",
  "LLM Providers",
  "Model Presets",
  "Tools",
  "Channels",
  "Channel Common",
  "API Server",
  "Gateway",
  "Memmy Memory",
  "Session DAG",
  "Context Compaction",
];

export const SETTINGS_GETTER: Record<string, (config: Config) => any> = {
  "Agent Settings": (config) => config.agents.defaults,
  "agents.defaults": (config) => config.agents.defaults,
  "LLM Providers": (config) => config.providers,
  providers: (config) => config.providers,
  "Model Presets": (config) => config.modelPresets,
  modelPresets: (config) => config.modelPresets,
  Tools: (config) => config.tools,
  tools: (config) => config.tools,
  Channels: (config) => config.channels,
  channels: (config) => config.channels,
  "Channel Common": (config) => config.channels,
  "API Server": (config) => config.api,
  api: (config) => config.api,
  Gateway: (config) => config.gateway,
  gateway: (config) => config.gateway,
  "Memmy Memory": (config) => config.memmyMemory,
  "Memos Memory": (config) => config.memmyMemory,
  memmyMemory: (config) => config.memmyMemory,
  "Session DAG": (config) => config.sessionDag,
  sessionDag: (config) => config.sessionDag,
  "Context Compaction": (config) => config.contextCompaction,
  contextCompaction: (config) => config.contextCompaction,
};

function setMemmyMemoryConfig(config: Config, value: any): void {
  config.memmyMemory = value instanceof MemmyMemoryConfig ? value : new MemmyMemoryConfig(value);
  config.memmyMemory.userId = typeof config.app.userId === "string" && config.app.userId.trim() ? config.app.userId.trim() : "local-user";
}

export const SETTINGS_SETTER: Record<string, (config: Config, value: any) => void> = {
  "Agent Settings": (config, value) => { config.agents.defaults = value instanceof AgentDefaults ? value : new AgentDefaults(value); },
  "agents.defaults": (config, value) => { config.agents.defaults = value instanceof AgentDefaults ? value : new AgentDefaults(value); },
  "LLM Providers": (config, value) => { config.providers = value; },
  providers: (config, value) => { config.providers = value; },
  "Model Presets": (config, value) => { config.modelPresets = value; syncPresetCache(config); },
  modelPresets: (config, value) => { config.modelPresets = value; syncPresetCache(config); },
  Tools: (config, value) => { config.tools = value instanceof ToolsConfig ? value : new ToolsConfig(value); },
  tools: (config, value) => { config.tools = value instanceof ToolsConfig ? value : new ToolsConfig(value); },
  Channels: (config, value) => { config.channels = value instanceof ChannelsConfig ? value : new ChannelsConfig(value); },
  channels: (config, value) => { config.channels = value instanceof ChannelsConfig ? value : new ChannelsConfig(value); },
  "Channel Common": (config, value) => { config.channels = value instanceof ChannelsConfig ? value : new ChannelsConfig(value); },
  "API Server": (config, value) => { config.api = value instanceof ApiConfig ? value : new ApiConfig(value); },
  api: (config, value) => { config.api = value instanceof ApiConfig ? value : new ApiConfig(value); },
  Gateway: (config, value) => { config.gateway = value instanceof GatewayConfig ? value : new GatewayConfig(value); },
  gateway: (config, value) => { config.gateway = value instanceof GatewayConfig ? value : new GatewayConfig(value); },
  "Memmy Memory": setMemmyMemoryConfig,
  "Memos Memory": setMemmyMemoryConfig,
  memmyMemory: setMemmyMemoryConfig,
  "Session DAG": (config, value) => { config.sessionDag = value instanceof SessionDagConfig ? value : new SessionDagConfig(value); },
  sessionDag: (config, value) => { config.sessionDag = value instanceof SessionDagConfig ? value : new SessionDagConfig(value); },
  "Context Compaction": (config, value) => { config.contextCompaction = value instanceof ContextCompactionConfig ? value : new ContextCompactionConfig(value); },
  contextCompaction: (config, value) => { config.contextCompaction = value instanceof ContextCompactionConfig ? value : new ContextCompactionConfig(value); },
};

export const SETTINGS_SECTION_META: Record<string, { displayName: string; subtitle: string; skipFields: Set<string> }> = {
  "Agent Settings": {
    displayName: "Agent Defaults",
    subtitle: "Configure default model, temperature, and behavior",
    skipFields: new Set(),
  },
  "agents.defaults": {
    displayName: "Agent Defaults",
    subtitle: "Configure default model, temperature, and behavior",
    skipFields: new Set(),
  },
  "Channel Common": {
    displayName: "Channel Common",
    subtitle: "Configure cross-channel behavior: progress, tool hints, retries",
    skipFields: new Set(),
  },
  "API Server": {
    displayName: "API Server",
    subtitle: "Configure OpenAI-compatible API endpoint",
    skipFields: new Set(),
  },
  api: {
    displayName: "API Server",
    subtitle: "Configure OpenAI-compatible API endpoint",
    skipFields: new Set(),
  },
  Gateway: {
    displayName: "Gateway Settings",
    subtitle: "Configure server host, port, and heartbeat",
    skipFields: new Set(),
  },
  gateway: {
    displayName: "Gateway Settings",
    subtitle: "Configure server host, port, and heartbeat",
    skipFields: new Set(),
  },
  "Memos Memory": {
    displayName: "Memmy Memory",
    subtitle: "Configure local Memory integration",
    skipFields: new Set(),
  },
  "Memmy Memory": {
    displayName: "Memmy Memory",
    subtitle: "Configure local Memory integration",
    skipFields: new Set(),
  },
  memmyMemory: {
    displayName: "Memmy Memory",
    subtitle: "Configure local Memory integration",
    skipFields: new Set(),
  },
  "Session DAG": {
    displayName: "Session DAG",
    subtitle: "Configure session-level history DAG building and retries",
    skipFields: new Set(),
  },
  sessionDag: {
    displayName: "Session DAG",
    subtitle: "Configure session-level history DAG building and retries",
    skipFields: new Set(),
  },
  "Context Compaction": {
    displayName: "Context Compaction",
    subtitle: "Choose text or DAG summary mode",
    skipFields: new Set(),
  },
  contextCompaction: {
    displayName: "Context Compaction",
    subtitle: "Choose text or DAG summary mode",
    skipFields: new Set(),
  },
  Tools: {
    displayName: "Tools Settings",
    subtitle: "Configure web search, shell exec, and other tools",
    skipFields: new Set(["mcpServers"]),
  },
  tools: {
    displayName: "Tools Settings",
    subtitle: "Configure web search, shell exec, and other tools",
    skipFields: new Set(["mcpServers"]),
  },
};

export async function configureGeneralSettings(config: Config, section: string): Promise<void> {
  const getter = SETTINGS_GETTER[section];
  const setter = SETTINGS_SETTER[section];
  if (!getter || !setter) return;
  const meta = SETTINGS_SECTION_META[section] ?? { displayName: section, subtitle: "", skipFields: new Set<string>() };
  showSectionHeader(meta.displayName, meta.subtitle);
  const updated = await configureDraftModel(getter(config), meta.displayName, { skipFields: meta.skipFields });
  if (updated) setter(config, updated);
}

export function summarizeModel(obj: any): Array<[string, string]> {
  return editableFields(obj).map(([name]) => [getFieldDisplayName(name), formatValue(obj[name], { rich: false, fieldName: name })]);
}

export function printSummaryPanel(rows: Array<[string, string]>, title: string): void {
  if (!shouldRenderPromptUi()) return;
  if (shouldUseClackPromptUi()) {
    clackNote(rows.map(([key, value]) => `${key}: ${value}`).join("\n"), title);
    return;
  }
  process.stdout.write(`${title}\n`);
  for (const [key, value] of rows) process.stdout.write(`  ${key}: ${value}\n`);
}

export async function showSummary(config: Config): Promise<void> {
  printSummaryPanel(summarizeModel(config.agents.defaults), "Agent Settings");
  printSummaryPanel(Object.entries(getProviderNames()).map(([name, display]) => [display, (config.providers as any)[name]?.apiKey ? "configured" : "not configured"]), "LLM Providers");
  printSummaryPanel(Object.entries(getChannelNames()).map(([name, display]) => [display, (config.channels as any)[name]?.enabled ? "enabled" : "not configured"]), "Chat Channels");
  await pause();
}

export async function pause(): Promise<void> {
  await getQuestionary().pressAnyKeyToContinue().ask();
}

export function showConfigPanel(displayName: string, model: any, fields: Array<[string, any]> = editableFields(model)): void {
  if (!shouldRenderPromptUi()) return;
  if (shouldUseClackPromptUi()) {
    clackNote(
      fields.map(([name, info]) => `${getFieldDisplayName(name, info)}: ${formatValue(model[name], { rich: false, fieldName: name })}`).join("\n"),
      displayName,
    );
    return;
  }
  process.stdout.write(`\n${displayName}\n`);
  for (const [name, info] of fields) {
    process.stdout.write(`  ${getFieldDisplayName(name, info)}: ${formatValue(model[name], { rich: false, fieldName: name })}\n`);
  }
}

export function showMainMenuHeader(): void {
  if (!shouldRenderPromptUi()) return;
  if (shouldUseClackPromptUi()) {
    clackIntro("memmy onboarding");
    return;
  }
  process.stdout.write("\nmemmy onboarding\n\n");
}

export function showSectionHeader(title: string, subtitle = ""): void {
  if (!shouldRenderPromptUi()) return;
  if (shouldUseClackPromptUi()) {
    clackLog.step(title);
    if (subtitle) clackLog.info(subtitle);
    return;
  }
  process.stdout.write(`\n${title}\n`);
  if (subtitle) process.stdout.write(`${subtitle}\n`);
}

export function hasUnsavedChanges(original: Config, current: Config): boolean {
  return JSON.stringify(dumpComparable(original)) !== JSON.stringify(dumpComparable(current));
}

export async function promptMainMenuExit(hasChanges: boolean): Promise<string> {
  const choices = hasChanges ? ["[S] Save and Exit", "[X] Exit Without Saving", "[C] Continue Editing"] : ["[X] Exit", "[C] Continue Editing"];
  return (await getQuestionary().select("Exit onboarding?", { choices, default: choices[0] }).ask()) ?? choices[0];
}

function finishExit(original: Config, current: Config, answer: string): OnboardResult | null {
  if (answer === "[S] Save and Exit") {
    if (shouldUseClackPromptUi()) clackOutro("Configuration saved.");
    return new OnboardResult({ config: current, shouldSave: true, changed: hasUnsavedChanges(original, current) });
  }
  if (answer === "[X] Exit Without Saving") {
    if (shouldUseClackPromptUi()) clackOutro("Configuration discarded.");
    return new OnboardResult({ config: original, shouldSave: false, changed: false });
  }
  if (answer === "[X] Exit") {
    if (shouldUseClackPromptUi()) clackOutro("Exited onboarding.");
    return new OnboardResult({ config: current, shouldSave: false, changed: false });
  }
  return null;
}

export async function runOnboard(
  opts: Config | { initialConfig?: Config; actions?: PresetAction[]; shouldSave?: boolean } = {},
): Promise<OnboardResult> {
  const options = opts instanceof Config ? { initialConfig: opts } : opts;
  const original = cloneValue(options.initialConfig ?? new Config());
  const config = cloneValue(options.initialConfig ?? new Config());
  if (options.actions) {
    await configureModelPresets(config, options.actions);
    return new OnboardResult({ config, shouldSave: options.shouldSave ?? true, changed: options.actions.length > 0 });
  }
  syncPresetCache(config);
  const menuChoices = [
    "[P] LLM Provider",
    "[M] Model Presets",
    "[C] Chat Channel",
    "[H] Channel Common",
    "[A] Agent Settings",
    "[I] API Server",
    "[G] Gateway",
    "[R] Memmy Memory",
    "[D] Session DAG",
    "[O] Context Compaction",
    "[T] Tools",
    "[V] View Configuration Summary",
    "[S] Save and Exit",
    "[X] Exit Without Saving",
  ];
  while (true) {
    try {
      showMainMenuHeader();
      const answer = await selectWithShortcutKeys("What would you like to configure?", menuChoices, menuChoices[0]);
      if (answer == null) {
        const exit = finishExit(original, config, await promptMainMenuExit(hasUnsavedChanges(original, config)));
        if (exit) return exit;
        continue;
      }
      if (answer === "[P] LLM Provider") await configureProviders(config);
      else if (answer === "[M] Model Presets") await configureModelPresets(config, null);
      else if (answer === "[C] Chat Channel") await configureChannels(config);
      else if (answer === "[H] Channel Common") await configureGeneralSettings(config, "Channel Common");
      else if (answer === "[A] Agent Settings") await configureGeneralSettings(config, "Agent Settings");
      else if (answer === "[I] API Server") await configureGeneralSettings(config, "API Server");
      else if (answer === "[G] Gateway") await configureGeneralSettings(config, "Gateway");
      else if (answer === "[R] Memmy Memory") await configureGeneralSettings(config, "Memmy Memory");
      else if (answer === "[D] Session DAG") await configureGeneralSettings(config, "Session DAG");
      else if (answer === "[O] Context Compaction") await configureGeneralSettings(config, "Context Compaction");
      else if (answer === "[T] Tools") await configureGeneralSettings(config, "Tools");
      else if (answer === "[V] View Configuration Summary") await showSummary(config);
      else {
        const exit = finishExit(original, config, answer);
        if (exit) return exit;
      }
    } catch {
      const exit = finishExit(original, config, await promptMainMenuExit(hasUnsavedChanges(original, config)));
      if (exit) return exit;
    }
  }
}
