import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Tool, type ToolExecutionContext } from "./base.js";
import { getMediaDir } from "../../../config/paths.js";
import { isPathInside } from "./path-utils.js";

const STATE_KEY = "outputLocation";
const PENDING_KEY = "pendingOutputDelivery";
type Destination = { workspace: string; directory: string; canonical: string };
type DeliveryEntry = { path: string; owners: Set<string> };
type Producer = { owner: string; done: () => boolean; cancel?: () => Promise<unknown> };
type DeliveryState = {
  id: string;
  destination?: Destination;
  requests: string[];
  entries: Map<string, DeliveryEntry>;
  producers: Map<string, Producer>;
  active: boolean;
  needsRegistration: boolean;
};

export const OUTPUT_PATHS_SCHEMA = {
  type: "array", items: { type: "string", minLength: 1 },
  description: "Complete or additional final files promised to the user, relative to the tool workspace or absolute. Accepted declarations accumulate even if generation fails. Omit or use [] for working files; this never clears prior declarations.",
};

/** Resolve existing parents as well as symlinks of not-yet-created files. */
export async function canonicalOutputPath(value: string): Promise<string> {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(await fs.realpath(current), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("Dangling symbolic link: " + current);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}

/** Output routing only: this is not an OS sandbox or a permission grant. */
export class OutputLocationPolicy {
  private readonly shared: DeliveryState;

  constructor(readonly workspace: string, private readonly metadata: Record<string, any> = {},
    private readonly intermediateRoots = [os.tmpdir(), getMediaDir()],
    shared?: DeliveryState, private readonly owner = "parent") {
    this.workspace = path.resolve(workspace);
    const saved = metadata[STATE_KEY] as Destination | undefined;
    this.shared = shared ?? {
      id: randomUUID(), destination: saved?.workspace === this.workspace ? saved : undefined,
      requests: [], entries: new Map(), producers: new Map(), active: true,
      needsRegistration: Boolean(metadata[PENDING_KEY]),
    };
  }

  get taskId(): string { return this.shared.id; }
  get active(): boolean { return this.shared.active; }
  get directory(): string { return this.shared.destination?.directory ?? this.workspace; }
  get hasOutputs(): boolean { return this.shared.entries.size > 0; }
  get hasWork(): boolean { return this.shared.needsRegistration || this.hasOutputs || this.shared.producers.size > 0; }

  /** Only live human input is supplied here, never a summary or recalled memory. */
  addUserRequest(text: string): void { if (text.trim()) this.shared.requests.push(text); }

  fork(): OutputLocationPolicy {
    return new OutputLocationPolicy(this.workspace, this.metadata, this.intermediateRoots, this.shared, randomUUID());
  }

  /** Preflight the whole declaration before accepting any obligations. */
  async declareOutputs(values: unknown, cwd = this.workspace, context?: ToolExecutionContext): Promise<string | null> {
    if (values === undefined) return null;
    if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())) {
      return "Error: output_paths must be an array of non-empty file paths.";
    }
    const targets = values.map(value => path.resolve(cwd, value));
    for (const target of targets) {
      const error = await this.checkWrite(target, context, true);
      if (error) return error;
    }
    for (const target of targets) this.recordFile(target, true);
    return null;
  }

  trackProducer(id: string, done: () => boolean, cancel?: () => Promise<unknown>): void {
    if (this.active) this.shared.producers.set(id, { owner: this.owner, done, cancel });
  }

  trackDelegation(id: string, done: () => boolean, cancel: () => Promise<unknown>): void {
    // A child checks its own commands, but must not wait on its own delegation.
    if (this.active) {
      this.metadata[PENDING_KEY] = true;
      this.shared.producers.set(id, { owner: "parent", done, cancel });
    }
  }

  pendingProducers(): string[] {
    if (this.shared.needsRegistration) return ["原交付清单不可用，请先通过 output_paths 重新登记完整最终产物清单"];
    return [...this.shared.producers].filter(([, producer]) => {
      if (this.owner !== "parent" && producer.owner !== this.owner) return false;
      try { return !producer.done(); } catch { return true; }
    }).map(([id]) => id);
  }

  async cancel(): Promise<void> {
    this.shared.active = false;
    delete this.metadata[PENDING_KEY];
    await Promise.allSettled([...this.shared.producers.values()].map(producer => producer.cancel?.()));
    this.shared.producers.clear();
    this.shared.entries.clear();
  }

  retire(): void {
    this.shared.active = false;
    delete this.metadata[PENDING_KEY];
    this.shared.producers.clear();
    this.shared.entries.clear();
  }

  pendingMessage(): string {
    return `相关生成任务尚未确认结束，尚未确认交付：${this.pendingProducers().join(", ")}。请继续查询或等待受管理任务结束，再核验完整产物清单。`;
  }

  async selectDirectory(value: string, userInstruction: string): Promise<string> {
    if (!this.active) return "Error: this delivery task has ended; its output directory cannot change.";
    if (!userInstruction.trim() || !this.shared.requests.some(request => request.includes(userInstruction))) {
      return "Error: output directory must come from the current user's destination instruction, not recalled history. " + this.recovery();
    }
    const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
    const directory = path.resolve(this.workspace, expanded);
    // Natural-language interpretation remains the model's job. Bind its choice to
    // literal live input (or a standard named folder), without another model call.
    const names: [string, string[]][] = [
      [this.workspace, ["workspace", "工作区"]],
      [path.join(os.homedir(), "Desktop"), ["desktop", "桌面"]],
      [path.join(os.homedir(), "Downloads"), ["downloads", "下载"]],
      [path.join(os.homedir(), "Documents"), ["documents", "文稿"]],
    ];
    const literal = userInstruction.includes(value) && value.trim().length > 1;
    const named = names.some(([folder, aliases]) => directory === folder && aliases.some(alias => userInstruction.toLowerCase().includes(alias)));
    if (!literal && !named) return "Error: destination does not match the quoted user instruction. " + this.recovery();
    const destination = { workspace: this.workspace, directory, canonical: await canonicalOutputPath(directory) };
    const previous = this.directory;
    // Changing obligations does not copy files or rewrite already running commands.
    if (directory !== previous) {
      for (const entry of this.shared.entries.values()) {
        entry.path = path.join(directory, path.relative(previous, entry.path));
      }
    }
    this.shared.destination = destination;
    this.metadata[STATE_KEY] = destination;
    return `Output directory: ${directory}. No additional confirmation is required. Save deliverables here; source locations do not change this choice.`;
  }

  private recovery(): string { return `Save outputs in ${this.directory}. Do not retry the rejected source-directory path; only change the destination when the current user explicitly requests it.`; }

  private async destinationCanonical(): Promise<string> {
    const destination = this.shared.destination;
    const canonical = await canonicalOutputPath(this.directory);
    if (destination && canonical !== destination.canonical) throw new Error("Output directory symlink destination changed");
    return canonical;
  }

  async checkWrite(value: string, context?: ToolExecutionContext, deliverable = false): Promise<string | null> {
    if (context?.abortSignal?.aborted) throw Object.assign(new Error("task cancelled"), { name: "AbortError" });
    const target = path.resolve(value);
    if (!this.active) return "Error: this delivery task has ended; late writes cannot reactivate it.";
    deliverable ||= [...this.shared.entries.values()].some(entry => entry.path === target);
    try {
      const canonical = await canonicalOutputPath(target);
      const roots = deliverable ? [await this.destinationCanonical()]
        : [await canonicalOutputPath(this.workspace), await this.destinationCanonical(),
          ...await Promise.all(this.intermediateRoots.map(root => canonicalOutputPath(root)))];
      if (roots.some(root => isPathInside(canonical, root))) return null;
    } catch (error) { return `Error: output path could not be resolved: ${(error as Error).message}. ${this.recovery()}`; }
    return `Error: output path outside allowed directory: ${target}. ${this.recovery()}`;
  }

  recordFile(value: string, deliverable = false): void {
    if (!deliverable || !this.active) return;
    this.shared.needsRegistration = false;
    this.metadata[PENDING_KEY] = true;
    const target = path.resolve(value);
    const existing = [...this.shared.entries.values()].find(entry => entry.path === target);
    if (existing) existing.owners.add(this.owner);
    else this.shared.entries.set(target, { path: target, owners: new Set([this.owner]) });
  }

  instruction(): string {
    return `Output location: ${this.directory}. Default: current workspace (${this.workspace}). Reading external files is allowed and never changes the output destination. If the current user explicitly requests another output directory, call set_output_directory with that directory and an exact quote of the live user instruction; it takes effect directly without a permission question. Declare all planned final files in output_paths before generation, including files not created yet. exec requires [] for commands without deliverables; write_file, edit_file and apply_patch accept optional output_paths. A later declaration adds obligations and never removes previous ones. Do not declare internal scripts or working README files; do declare README files intended for the user. Working directory and reference-file paths are not output destinations. Write intermediates in the workspace, temporary or media directories. Deliver files from the selected output directory. On a rejected path, use the output directory stated in the error instead of repeatedly retrying. Do not present an input/reference link as a newly generated output.`;
  }

  async checkDelivery(_content?: string): Promise<string[]> {
    void _content; // Backwards-compatible argument; never used to select paths.
    const invalid: string[] = [];
    // Check literal registered paths. Final prose and Markdown never select a subset.
    for (const entry of this.shared.entries.values()) {
      if (this.owner !== "parent" && !entry.owners.has(this.owner)) continue;
      const target = entry.path;
      try {
        if (!isPathInside(await canonicalOutputPath(target), await this.destinationCanonical()) || !(await fs.stat(target)).isFile()) invalid.push(target);
      } catch { invalid.push(target); }
    }
    return invalid;
  }

  rejection(paths: string[]): string {
    return `输出文件位置核验未通过，尚未确认交付：\n${paths.join("\n")}\n当前输出目录：${this.directory}。请在此目录生成文件后再交付。`;
  }
}

export class SetOutputDirectoryTool extends Tool {
  static scopes = new Set(["core", "subagent"]);
  get name(): string { return "set_output_directory"; }
  get description(): string { return "Use the current user's explicitly requested output directory, without an extra confirmation. Quote the user's destination instruction, not a remembered task or a source path."; }
  get exclusive(): boolean { return true; }
  get parameters() { return { type: "object", properties: {
    directory: { type: "string", minLength: 1 }, user_instruction: { type: "string", minLength: 1 },
  }, required: ["directory", "user_instruction"] }; }
  async execute(params: Record<string, any>, context?: ToolExecutionContext): Promise<string> {
    if (!context?.outputLocation) return "Error: output location is unavailable.";
    return context.outputLocation.selectDirectory(params.directory, params.user_instruction);
  }
}
