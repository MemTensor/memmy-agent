import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { Tool } from "./base.js";
import { ToolContext } from "./context.js";
import { ToolRegistry } from "./registry.js";
import { ApplyPatchTool } from "./apply-patch.js";
import { AgentSourceTool } from "./agent-source.js";
import { CronTool } from "./cron.js";
import { ListExecSessionsTool, WriteStdinTool } from "./exec-session.js";
import { ReadFileTool, WriteFileTool, EditFileTool, ListDirTool } from "./filesystem.js";
import { ImageGenerationTool } from "./image-generation.js";
import { CompleteGoalTool, LongTaskTool } from "./long-task.js";
import { MessageTool } from "./message.js";
import { FindFilesTool, GrepTool } from "./search.js";
import { ExecTool } from "./shell.js";
import { SpawnTool } from "./spawn.js";
import { WebFetchTool, WebSearchTool } from "./web.js";

export const SKIP_MODULES = new Set([
  "base",
  "schema",
  "registry",
  "context",
  "loader",
  "config",
  "file-state",
  "sandbox",
  "mcp",
  "index",
]);

type ToolClass = (new (...args: any[]) => Tool) & {
  enabled?: (ctx: any) => boolean;
  create?: (ctx: any) => Tool;
  pluginDiscoverable?: boolean;
  scopes?: Set<string> | string[];
};

const BUILTIN_TOOL_CLASSES: ToolClass[] = [
  AgentSourceTool,
  ApplyPatchTool,
  CompleteGoalTool,
  CronTool,
  EditFileTool,
  ExecTool,
  FindFilesTool,
  GrepTool,
  ImageGenerationTool,
  ListDirTool,
  ListExecSessionsTool,
  LongTaskTool,
  MessageTool,
  ReadFileTool,
  SpawnTool,
  WebFetchTool,
  WebSearchTool,
  WriteFileTool,
  WriteStdinTool,
];

function scopesFor(cls: ToolClass): Set<string> {
  const raw = cls.scopes ?? new Set(["core"]);
  return raw instanceof Set ? raw : new Set(raw);
}

function isDiscoverable(cls: ToolClass): boolean {
  return cls.pluginDiscoverable ?? true;
}

function hasPrototypeMember(cls: ToolClass, key: string): boolean {
  let proto = cls.prototype;
  while (proto && proto !== Tool.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, key)) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

function isConcreteToolClass(cls: ToolClass): boolean {
  return (
    hasPrototypeMember(cls, "name") &&
    hasPrototypeMember(cls, "description") &&
    hasPrototypeMember(cls, "parameters") &&
    hasPrototypeMember(cls, "execute")
  );
}

type ToolLoaderInit = {
  workspace?: string;
  ctx?: Partial<ToolContext>;
  context?: Partial<ToolContext>;
  testClasses?: ToolClass[] | null;
};

type PackageToolSpec = string | { module?: string; export?: string } | Array<string | { module?: string; export?: string }>;

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function packageToolSpec(pkg: Record<string, any>): PackageToolSpec | null {
  return pkg.memmyAgent?.tools ?? pkg["memmy-agent"]?.tools ?? null;
}

function nearestNodeModulesRoots(workspace: string): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  let current = path.resolve(workspace);
  while (true) {
    const nodeModules = path.join(current, "node_modules");
    if (!seen.has(nodeModules)) {
      roots.push(nodeModules);
      seen.add(nodeModules);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const cwdModules = path.resolve(process.cwd(), "node_modules");
  if (!seen.has(cwdModules)) roots.push(cwdModules);
  return roots;
}

function packageDirs(nodeModules: string): string[] {
  if (!fs.existsSync(nodeModules)) return [];
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const full = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
        if (scoped.isDirectory() && !scoped.name.startsWith(".")) dirs.push(path.join(full, scoped.name));
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

function flattenExports(value: any): any[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(flattenExports);
  if (typeof value === "object" && !(value.prototype instanceof Tool)) {
    return Object.values(value).flatMap(flattenExports);
  }
  return [value];
}

function exportedToolClasses(moduleExports: any, exportName?: string): ToolClass[] {
  const candidates =
    exportName
      ? [moduleExports?.[exportName]]
      : [
          moduleExports?.default,
          moduleExports?.tool,
          moduleExports?.tools,
          moduleExports?.toolClasses,
          moduleExports,
        ];
  return candidates
    .flatMap(flattenExports)
    .filter((item): item is ToolClass => typeof item === "function" && isDiscoverable(item) && isConcreteToolClass(item));
}

export class ToolLoader {
  workspace: string;
  context: ToolContext;
  private testClasses: ToolClass[] | null;
  private discovered: ToolClass[] | null = null;
  private pluginClasses = new WeakSet<ToolClass>();

  constructor({ workspace = process.cwd(), ctx, context, testClasses = null }: ToolLoaderInit = {}) {
    this.workspace = workspace;
    this.context = new ToolContext({ workspace, ...(context ?? ctx ?? {}) });
    this.testClasses = testClasses;
  }

  discover(): ToolClass[] {
    if (this.testClasses)
      return this.testClasses
        .filter((cls) => isDiscoverable(cls) && isConcreteToolClass(cls))
        .sort((a, b) => a.name.localeCompare(b.name));
    if (this.discovered) return this.discovered;
    const seen = new Set<ToolClass>();
    const builtins: ToolClass[] = [];
    for (const cls of BUILTIN_TOOL_CLASSES) {
      if (seen.has(cls) || !isDiscoverable(cls) || !isConcreteToolClass(cls)) continue;
      seen.add(cls);
      builtins.push(cls);
    }
    builtins.sort((a, b) => a.name.localeCompare(b.name));

    const plugins = this.discoverPlugins().filter((cls) => {
      if (seen.has(cls)) return false;
      seen.add(cls);
      this.pluginClasses.add(cls);
      return true;
    });
    plugins.sort((a, b) => a.name.localeCompare(b.name));
    this.discovered = [...builtins, ...plugins];
    return this.discovered;
  }

  discoverPlugins(): ToolClass[] {
    const out: ToolClass[] = [];
    const seenPackages = new Set<string>();
    for (const nodeModules of nearestNodeModulesRoots(this.workspace)) {
      for (const dir of packageDirs(nodeModules)) {
        const pkgPath = path.join(dir, "package.json");
        if (!fs.existsSync(pkgPath) || seenPackages.has(dir)) continue;
        seenPackages.add(dir);
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          const spec = packageToolSpec(pkg);
          if (!spec) continue;
          const pkgRequire = createRequire(pkgPath);
          for (const entry of asArray(spec)) {
            const moduleName = typeof entry === "string" ? entry : (entry.module ?? ".");
            const exportName = typeof entry === "string" ? undefined : entry.export;
            const loaded = pkgRequire(moduleName);
            out.push(...exportedToolClasses(loaded, exportName));
          }
        } catch (error) {
          console.warn(`Tool plugin discovery skipped ${dir}: ${(error as Error).message}`);
        }
      }
    }
    return out;
  }

  instantiate(cls: ToolClass, ctx: ToolContext = this.context): Tool {
    if (typeof cls.create === "function") return cls.create(ctx);
    return new cls();
  }

  load(ctx: Partial<ToolContext> | null, registry: ToolRegistry, { scope = "core" }: { scope?: string } = {}): string[] {
    const effectiveCtx = new ToolContext({ workspace: this.workspace, ...(ctx ?? this.context) });
    const registered: string[] = [];
    const builtinNames = new Set<string>();
    for (const cls of this.discover()) {
      if (!scopesFor(cls).has(scope)) continue;
      if (typeof cls.enabled === "function" && !cls.enabled(effectiveCtx)) continue;
      const tool = this.instantiate(cls, effectiveCtx);
      const isPlugin = this.pluginClasses.has(cls);
      if (isPlugin && builtinNames.has(tool.name)) {
        console.warn(`Plugin tool '${tool.name}' skipped because it conflicts with a built-in tool.`);
        continue;
      }
      registry.register(tool);
      registered.push(tool.name);
      if (!isPlugin) builtinNames.add(tool.name);
    }
    return registered;
  }

  loadRegistry(ctx: Partial<ToolContext> | null = null, { scope = "core" }: { scope?: string } = {}): ToolRegistry {
    const registry = new ToolRegistry();
    this.load(ctx, registry, { scope });
    return registry;
  }
}
