import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Tool, type ToolExecutionContext } from "./base.js";
import { isPathInside } from "./path-utils.js";

const STATE_KEY = "outputDelivery";
/** Runner feedback messages carrying this key are sent to the model but never persisted. */
export const OUTPUT_FEEDBACK_KEY = "output_delivery_feedback";
/** Every delivery rejection starts with this text, so a message-tool turn still shows it. */
export const DELIVERY_NOT_CONFIRMED = "尚未确认交付";
const OUTPUT_PATH_TOOLS = new Set(["exec", "write_file", "edit_file", "apply_patch"]);
const OUTPUT_PATHS_SCHEMA = {
  type: "array",
  items: { type: "string", minLength: 1 },
  description: "Final files this call creates for the user, relative to the workspace or absolute. Omit for scripts, drafts and other working files. Declarations accumulate and are verified before the final reply.",
};

/** Persisted in session metadata so system turns, subagent results and later turns see the same list. */
type DeliveryState = {
  directory?: string;
  /** The user picked the directory, so it outlives one delivery. */
  chosen?: boolean;
  /** Declared paths (symlinks unresolved) relative to `directory`, so a directory change retargets every declared file. */
  files?: string[];
  producers?: string[];
};

// Liveness of background commands and subagents is known only to this process.
// An id left in metadata by a process that is gone counts as finished.
const runningProducers = new Map<string, () => boolean>();

function producerRunning(id: string): boolean {
  const running = runningProducers.get(id);
  if (running?.()) return true;
  runningProducers.delete(id);
  return false;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** Resolve symlinks of the existing part of a path that may not exist yet. */
export async function canonicalPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function hasOutputObligations(metadata: Record<string, any> | null | undefined): boolean {
  const state = metadata?.[STATE_KEY] as DeliveryState | undefined;
  return Boolean(state?.files?.length || state?.producers?.length);
}

/**
 * Ends the delivery task (success or explicit cancel); a user-chosen directory is
 * kept unless the whole conversation is reset.
 */
export function clearOutputDelivery(metadata: Record<string, any> | null | undefined, { keepDirectory = true } = {}): void {
  const state = metadata?.[STATE_KEY] as DeliveryState | undefined;
  if (!metadata || !state) return;
  for (const id of state.producers ?? []) runningProducers.delete(id);
  if (keepDirectory && state.chosen && state.directory) metadata[STATE_KEY] = { directory: state.directory, chosen: true };
  else delete metadata[STATE_KEY];
}

/**
 * Where the list lives. Sessions can be reloaded and Goal mutations replace
 * `session.metadata`, so a long-lived holder (a subagent) must read the
 * current object on every access and save what it changes.
 */
export type DeliveryStore = { metadata(): Record<string, any>; save?(): void };

/** Adds `output_paths` to the file-producing tools offered to the model. */
export function withOutputPaths(definitions: Record<string, any>[]): Record<string, any>[] {
  return definitions.map((definition) => {
    const fn = definition?.function;
    if (!fn || !OUTPUT_PATH_TOOLS.has(fn.name)) return definition;
    const parameters = fn.parameters ?? { type: "object", properties: {} };
    return {
      ...definition,
      function: { ...fn, parameters: { ...parameters, properties: { ...parameters.properties, output_paths: OUTPUT_PATHS_SCHEMA } } },
    };
  });
}

/** Splits `output_paths` off a tool call; the tool itself never sees it. */
export function takeOutputPaths(toolName: string, args: any): { args: any; outputPaths?: unknown } {
  if (!OUTPUT_PATH_TOOLS.has(toolName) || !args || typeof args !== "object" || Array.isArray(args) || !("output_paths" in args)) {
    return { args };
  }
  const { output_paths: outputPaths, ...rest } = args;
  return { args: rest, outputPaths };
}

/**
 * The list of final files promised to the user, and the check that they all
 * exist in the output directory before the final reply. Output routing only:
 * this is not a sandbox and does not restrict working files.
 */
export class OutputDelivery {
  /** A subagent checks only what it declared or started itself. */
  private readonly own: Set<string> | null;
  private readonly userTexts: string[] = [];
  private readonly store: DeliveryStore;

  constructor(
    store: DeliveryStore | Record<string, any>,
    readonly workspace: string,
    userText: string | null = null,
    child = false,
  ) {
    this.store = typeof store.metadata === "function" ? store as DeliveryStore : { metadata: () => store };
    this.workspace = path.resolve(workspace);
    this.own = child ? new Set() : null;
    if (userText) this.addUserText(userText);
  }

  private get state(): DeliveryState {
    return (this.store.metadata()[STATE_KEY] as DeliveryState | undefined) ?? {};
  }

  private update(changes: DeliveryState): void {
    this.store.metadata()[STATE_KEY] = { ...this.state, ...changes };
    this.store.save?.();
  }

  get directory(): string {
    return this.state.directory ?? this.workspace;
  }

  get hasFiles(): boolean {
    return Boolean(this.state.files?.length);
  }

  /** Live user input of this turn, including steers; never system or subagent notices. */
  addUserText(text: string): void {
    if (text.trim()) this.userTexts.push(text);
  }

  forChild(): OutputDelivery {
    return new OutputDelivery(this.store, this.workspace, null, true);
  }

  async declare(values: unknown): Promise<string | null> {
    const outputs = await this.resolveOutputs(values);
    if (typeof outputs === "string") return outputs;
    this.record(outputs);
    return null;
  }

  /** Checks output_paths without recording them; the caller records them once its tool call succeeded. */
  async resolveOutputs(values: unknown): Promise<string | string[]> {
    if (!Array.isArray(values) || values.some((value) => typeof value !== "string" || !value.trim())) {
      return "Error: output_paths must be an array of file paths.";
    }
    if (!values.length) return [];
    const directory = this.directory;
    const relative: string[] = [];
    try {
      const root = await canonicalPath(directory);
      for (const value of values) {
        const target = path.resolve(this.workspace, expandHome(value));
        const real = await canonicalPath(target);
        if (real === root || !isPathInside(real, root)) {
          return `Error: output path ${target} is outside the output directory ${directory}. Save final files there; call set_output_directory only if the user explicitly asked for another directory.`;
        }
        // Keep the declared path, not its symlink target: verify() resolves it again every time.
        const base = isPathInside(target, directory) ? directory : isPathInside(target, root) ? root : null;
        if (!base) {
          return `Error: output path ${target} reaches the output directory ${directory} only through another link. Declare it by its path inside that directory.`;
        }
        relative.push(path.relative(base, target));
      }
    } catch (error) {
      return `Error: output path could not be resolved: ${(error as Error).message}`;
    }
    // The directory may have changed while paths were resolved; never record against the new one.
    if (this.directory !== directory) return `Error: the output directory changed to ${this.directory}; declare the files again there.`;
    return relative;
  }

  /** Adds resolved files; after a directory change they are expected in the new directory, like every declared file. */
  record(files: string[]): void {
    if (!files.length) return;
    for (const file of files) this.own?.add(`file:${file}`);
    this.update({ directory: this.directory, files: [...new Set([...(this.state.files ?? []), ...files])] });
  }

  /** Register a background command or subagent that may still be writing deliverables. */
  track(isRunning: () => boolean): void {
    const id = randomUUID();
    runningProducers.set(id, isRunning);
    this.own?.add(`producer:${id}`);
    this.update({ directory: this.directory, producers: [...(this.state.producers ?? []), id] });
  }

  /** Returns a rejection to show the model or the user, or null when every declared file is delivered. */
  async verify(): Promise<string | null> {
    const state = this.state;
    const mine = (key: string) => !this.own || this.own.has(key);
    const producers = (state.producers ?? []).filter((id) => mine(`producer:${id}`));
    const running = producers.filter((id) => producerRunning(id));
    // Forget finished producers so the persisted state no longer reports an obligation for them.
    if (running.length < producers.length) {
      this.update({ producers: (state.producers ?? []).filter((id) => !producers.includes(id) || running.includes(id)) });
    }
    if (running.length) {
      return `${DELIVERY_NOT_CONFIRMED}：还有 ${running.length} 个后台命令或子任务在运行。请等待其结束或查询状态，再核验交付。`;
    }
    const files = (state.files ?? []).filter((file) => mine(`file:${file}`));
    if (!files.length) return null;
    const directory = this.directory;
    const root = await canonicalPath(directory).catch(() => null);
    const missing: string[] = [];
    for (const file of files) {
      const target = path.join(directory, file);
      try {
        const real = await fs.realpath(target);
        if (!root || !isPathInside(real, root) || !(await fs.stat(real)).isFile()) missing.push(target);
      } catch {
        missing.push(target);
      }
    }
    if (!missing.length) return null;
    return `${DELIVERY_NOT_CONFIRMED}：以下文件不存在或不在输出目录 ${directory} 中：\n${missing.join("\n")}\n请在该目录生成这些文件后再交付；无法生成时如实告知用户。`;
  }

  /** Successful delivery ends the task; a subagent leaves that to its parent. */
  complete(): void {
    if (this.own) return;
    clearOutputDelivery(this.store.metadata());
    this.store.save?.();
  }

  instruction(): string {
    // Kept stable within a task: it is appended to the system prompt on every request.
    return `Output directory for final files: ${this.directory}${this.state.chosen ? " (chosen by the user)" : " (the current workspace, by default)"}. `
      + "Declare each final file for the user in output_paths of exec, write_file, edit_file or apply_patch; do not declare scripts, drafts or other working files. "
      + "Declarations accumulate, and all of them are checked before your final reply. "
      + "Reading files elsewhere never changes the output directory. Only when the user explicitly asks for another output directory, call set_output_directory with it and an exact quote of the user's message.";
  }

  async selectDirectory(directory: string, quote: string): Promise<string> {
    if (this.own) return "Error: only the main task can change the output directory.";
    const instruction = quote.trim();
    if (!instruction || !this.userTexts.some((text) => text.includes(instruction))) {
      return "Error: user_instruction must exactly quote the current user's message that asks for this directory.";
    }
    const resolved = path.resolve(this.workspace, expandHome(directory.trim()));
    const named: [string, string[]][] = [
      [this.workspace, ["workspace", "工作区"]],
      [path.join(os.homedir(), "Desktop"), ["desktop", "桌面"]],
      [path.join(os.homedir(), "Downloads"), ["downloads", "下载"]],
      [path.join(os.homedir(), "Documents"), ["documents", "文稿", "文档"]],
    ];
    const literal = directory.trim().length > 1 && instruction.includes(directory.trim());
    const alias = named.some(([folder, words]) => folder === resolved && words.some((word) => instruction.toLowerCase().includes(word)));
    if (!literal && !alias) return "Error: the directory does not appear in the quoted user instruction.";
    // Declared files keep their relative paths and must now be produced in the new directory.
    this.update({ directory: resolved, chosen: true });
    return `Output directory: ${resolved}. Save final files here.`;
  }
}

export class SetOutputDirectoryTool extends Tool {
  get name(): string {
    return "set_output_directory";
  }

  get description(): string {
    return "Use the output directory the current user explicitly asked for. Quote the user's own words; never use a source file's location or a remembered task.";
  }

  get exclusive(): boolean {
    return true;
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        directory: { type: "string", minLength: 1 },
        user_instruction: { type: "string", minLength: 1, description: "Exact quote of the user's request for this directory." },
      },
      required: ["directory", "user_instruction"],
    };
  }

  async execute(params: Record<string, any> = {}, context?: ToolExecutionContext): Promise<string> {
    if (!context?.outputLocation) return "Error: output location is unavailable.";
    return context.outputLocation.selectDirectory(String(params.directory ?? ""), String(params.user_instruction ?? ""));
  }
}
