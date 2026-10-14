import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Tool, type ToolExecutionContext } from "./base.js";
import { getMediaDir } from "../../../config/paths.js";
import { isPathInside } from "./path-utils.js";

const STATE_KEY = "outputLocation";
type Destination = { workspace: string; directory: string; canonical: string };

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
  private requests: string[] = [];
  private readonly files = new Map<string, boolean>();
  private readonly attempted = new Set<string>();
  private readonly shared: { destination?: Destination };

  constructor(readonly workspace: string, private readonly metadata: Record<string, any> = {},
    private readonly intermediateRoots = [os.tmpdir(), getMediaDir()],
    shared?: { destination?: Destination }) {
    this.workspace = path.resolve(workspace);
    const saved = metadata[STATE_KEY] as Destination | undefined;
    this.shared = shared ?? { destination: saved?.workspace === this.workspace ? saved : undefined };
  }

  get directory(): string { return this.shared.destination?.directory ?? this.workspace; }
  get hasOutputs(): boolean { return this.files.size > 0 || this.attempted.size > 0; }

  /** Only live human input is supplied here, never a summary or recalled memory. */
  addUserRequest(text: string): void { if (text.trim()) this.requests.push(text); }

  fork(): OutputLocationPolicy {
    const child = new OutputLocationPolicy(this.workspace, this.metadata, this.intermediateRoots, this.shared);
    child.requests = [...this.requests];
    return child;
  }

  async selectDirectory(value: string, userInstruction: string): Promise<string> {
    if (!userInstruction.trim() || !this.requests.some(request => request.includes(userInstruction))) {
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
    this.attempted.add(target);
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
    const target = path.resolve(value);
    this.files.set(target, deliverable || (this.files.get(target) ?? false));
    this.attempted.delete(target);
  }

  instruction(): string {
    return `Output location: ${this.directory}. Default: current workspace (${this.workspace}). Reading external files is allowed and never changes the output destination. If the current user explicitly requests another output directory, call set_output_directory with that directory and an exact quote of the live user instruction; it takes effect directly without a permission question. Declare every file to be delivered by exec in output_paths (use [] for commands without deliverables). Working directory and reference-file paths are not output destinations. Write intermediates in the workspace, temporary or media directories. Deliver files from the selected output directory. On a rejected path, use the output directory stated in the error instead of repeatedly retrying. Do not present an input/reference link as a newly generated output.`;
  }

  async checkDelivery(content: string): Promise<string[]> {
    const selected = new Set<string>();
    // Only links to tracked writes/attempts identify file-tool deliveries. Other
    // links are references; neither document contents nor source links are scanned.
    for (const match of content.matchAll(/\[[^\]]*\]\(<?([^\n]+?)>?(?:\s+"[^"\n]*")?\)/g)) {
      let value = match[1].replace(/:\d+$/, "");
      if (value.startsWith("file://")) {
        try { value = fileURLToPath(value); } catch { continue; }
      } else {
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^(?:sandbox:|[a-z]:[\\/])/i.test(value)) continue;
        value = value.replace(/^sandbox:/, "");
        try { value = decodeURIComponent(value); } catch { /* Literal filesystem name. */ }
      }
      const target = path.resolve(this.workspace, value);
      if (this.files.has(target) || this.attempted.has(target)) selected.add(target);
    }
    // A corrected delivery can replace an earlier failed attempt. When the final
    // reply has no tracked links, still check the command's declared outputs.
    if (!selected.size) {
      for (const [target, deliverable] of this.files) if (deliverable) selected.add(target);
    }
    const invalid: string[] = [];
    for (const target of selected) {
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
