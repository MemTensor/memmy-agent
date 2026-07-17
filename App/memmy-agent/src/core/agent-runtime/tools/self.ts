import { performance } from "node:perf_hooks";
import { SubagentStatus } from "../subagent.js";
import { Tool } from "./base.js";

export class MyToolConfig {
  enable = true;
  allowSet = false;
  constructor(init: Partial<MyToolConfig> = {}) {
    Object.assign(this, init);
    this.allowSet = init.allowSet ?? false;
  }
}

function hasRealAttr(obj: any, key: string): boolean {
  if (!obj) return false;
  if (obj instanceof Map) return obj.has(key);
  if (typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key)) return true;
  return key in obj;
}

function tsRepr(value: any): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  return String(value);
}

export class MyTool extends Tool {
  static pluginDiscoverable = false;
  static configKey = "my";
  static BLOCKED = new Set([
    "bus",
    "provider",
    "running",
    "tools",
    "runtimeVars",
    "runner",
    "sessions",
    "consolidator",
    "dream",
    "autoCompact",
    "context",
    "commands",
    "mcpServers",
    "mcpStacks",
    "pendingQueues",
    "sessionLocks",
    "activeTasks",
    "backgroundTasks",
    "restrictToWorkspace",
    "channelsConfig",
    "unifiedSession",
  ]);
  static READ_ONLY = new Set(["subagents", "currentIteration", "execConfig", "webConfig"]);
  static DENIED_ATTRS = new Set([
    "__proto__",
    "prototype",
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
  ]);
  static SENSITIVE_NAMES = new Set(["apiKey", "secret", "password", "token", "credential", "privateKey", "accessToken", "refreshToken", "auth"]);
  static RESTRICTED: Record<string, Record<string, any>> = {
    maxIterations: { type: "integer", min: 1, max: 100 },
    contextWindowTokens: { type: "integer", min: 4096, max: 1_000_000 },
    model: { type: "string", minLen: 1 },
  };
  static MAX_RUNTIME_KEYS = 64;

  runtimeState: any;
  modifyAllowed: boolean;
  channel = "";
  chatId = "";

  constructor({
    runtime = null,
    runtimeState = null,
    modifyAllowed = true,
  }: {
    runtime?: any;
    runtimeState?: any;
    modifyAllowed?: boolean;
  } = {}) {
    super();
    this.pluginDiscoverable = false;
    this.runtimeState = runtimeState ?? runtime ?? {};
    this.runtimeState.runtimeVars ??= {};
    this.modifyAllowed = modifyAllowed;
  }

  static configCls(): typeof MyToolConfig {
    return MyToolConfig;
  }

  static enabled(ctx: any): boolean {
    const cfg = ctx?.config?.my ?? ctx?.config?.tools?.my;
    return cfg?.enable ?? cfg?.enabled ?? true;
  }

  static create(ctx: any): Tool {
    const cfg = ctx?.config?.my ?? ctx?.config?.tools?.my ?? {};
    return new MyTool({
      runtimeState: ctx?.runtimeState ?? {},
      modifyAllowed: cfg.allowSet ?? false,
    });
  }

  setContext(ctx: any): void {
    this.channel = ctx.channel ?? "";
    this.chatId = ctx.chatId ?? "";
  }

  get name(): string {
    return "my";
  }

  get description(): string {
    const base =
      "Check and set your own runtime state.\n" +
      "Actions: check, set.\n" +
      "- check (no key): full config overview - start here.\n" +
      "- check (key): drill into a value. Dot-paths allowed (e.g. 'lastUsage.prompt_tokens', 'webConfig.enable').\n" +
      "- set (key, value): change config or store notes in your scratchpad. Scratchpad keys persist across turns but not restarts.\n" +
      "Key values: currentIteration (current progress), maxIterations - currentIteration = remaining iterations.\n" +
      "Note: webConfig and execConfig are readable but read-only.";
    return this.modifyAllowed
      ? `${base}\nIMPORTANT: Before setting state, predict the potential impact. If the operation could cause crashes or instability, warn the user first.`
      : `${base}\nREAD-ONLY MODE: set is disabled.`;
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        action: { type: "string", enum: ["check", "inspect", "set", "modify"] },
        key: { type: "string" },
        value: {},
      },
      required: ["action"],
    };
  }

  static isSensitiveFieldName(name: string): boolean {
    const lowered = name.toLowerCase();
    const normalized = lowered.replaceAll("_", "").replaceAll("-", "");
    const exactSensitive = ["apikey", "privatekey", "accesstoken", "refreshtoken"];
    if (exactSensitive.includes(normalized)) return true;
    const words = name
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return words.some((word) => ["secret", "password", "token", "credential", "auth"].includes(word));
  }

  private validateSegment(part: string): string | null {
    if (MyTool.DENIED_ATTRS.has(part) || part.startsWith("__")) return `'${part}' is not accessible`;
    if (MyTool.BLOCKED.has(part)) return `'${part}' is not accessible`;
    if (MyTool.isSensitiveFieldName(part)) return `'${part}' is not accessible`;
    return null;
  }

  resolvePath(path: string): [any, string | null] {
    let obj = this.runtimeState;
    for (const part of path.split(".")) {
      const blocked = this.validateSegment(part);
      if (blocked) return [null, blocked];
      if (obj instanceof Map) {
        if (!obj.has(part)) return [null, `'${part}' not found in map`];
        obj = obj.get(part);
      } else if (obj && typeof obj === "object" && part in obj) {
        obj = obj[part];
      } else {
        return [null, `'${part}' not found`];
      }
    }
    return [obj, null];
  }

  static validateKey(key?: string | null, label = "key"): string | null {
    if (!key || !key.trim()) return `Error: '${label}' cannot be empty or whitespace`;
    return null;
  }

  static formatStatus(st: SubagentStatus, indent = "  "): string {
    const elapsed = Math.max(0, performance.now() / 1000 - st.startedAt).toFixed(1);
    const tools = (st.toolEvents ?? []).slice(-5).map((event: any) => `${event.name ?? "?"}(${event.status ?? "?"})`).join(", ") || "none";
    const lines = [
      `${indent}phase: ${st.phase}, iteration: ${st.iteration}, elapsed: ${elapsed}s`,
      `${indent}tools: ${tools}`,
      `${indent}usage: ${Object.keys(st.usage ?? {}).length ? JSON.stringify(st.usage) : "n/a"}`,
    ];
    if (st.error) lines.push(`${indent}error: ${st.error}`);
    if (st.stopReason) lines.push(`${indent}stopReason: ${st.stopReason}`);
    return lines.join("\n");
  }

  static formatValue(value: any, key = ""): string {
    if (value instanceof SubagentStatus) {
      return `Subagent [${value.taskId}] '${value.label}'\n  task: ${value.taskDescription}\n${MyTool.formatStatus(value, "  ")}`;
    }
    if (value?.taskStatuses instanceof Map) return MyTool.formatValue(value.taskStatuses, key);
    if (value instanceof Map) {
      const entries = [...value.entries()];
      if (entries.length && entries.every(([, item]) => item instanceof SubagentStatus)) {
        return [`${key ? `${key}: ` : ""}${entries.length} subagent(s):`, ...entries.map(([id, st]) => `  [${id}] '${st.label}'\n${MyTool.formatStatus(st, "    ")}`)].join("\n");
      }
      value = Object.fromEntries(entries);
    }
    if (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).length && Object.values(value).every((item) => item instanceof SubagentStatus)) {
      return MyTool.formatValue(new Map(Object.entries(value)), key);
    }
    if (value?.toolNames) {
      const names = value.toolNames;
      return `tools: ${names.length} registered - ${names.join(", ")}`;
    }
    if (["string", "number", "boolean"].includes(typeof value) || value == null) return key ? `${key}: ${tsRepr(value)}` : tsRepr(value);
    if (Array.isArray(value)) return key ? `${key}: ${value.length > 20 ? `[${value.length} items]` : JSON.stringify(value)}` : JSON.stringify(value);
    if (typeof value === "object") {
      const keys = Object.keys(value).filter((name) => !MyTool.isSensitiveFieldName(name));
      if (!keys.length) return key ? `${key}: {}` : "{}";
      if (keys.length <= 5) {
        const small = Object.fromEntries(keys.map((name) => [name, value[name]]).filter(([_, item]) => ["string", "number", "boolean"].includes(typeof item) || item == null));
        const text = JSON.stringify(small);
        if (text.length <= 200) return key ? `${key}: ${text}` : text;
      }
      return `${key ? `${key}: ` : ""}<${value.constructor?.name ?? "Object"}> [${keys.slice(0, 20).join(", ")}${keys.length > 20 ? ", ..." : ""}]`;
    }
    return key ? `${key}: ${String(value)}` : String(value);
  }

  async execute(params: { action?: string; key?: string | null; value?: any } = {}): Promise<string> {
    const action = params.action;
    if (action === "inspect" || action === "check") return this.inspect(params.key ?? null);
    if (!this.modifyAllowed) return "Error: set is disabled (tools.my.allowSet is false)";
    if (action === "modify" || action === "set") return this.modify(params.key ?? null, params.value);
    return `Unknown action: ${action}`;
  }

  private inspect(key: string | null): string {
    if (!key) return this.inspectAll();
    if (key === "scratchpad") {
      const vars = this.runtimeState.runtimeVars ?? {};
      return Object.keys(vars).length ? MyTool.formatValue(vars, "scratchpad") : "scratchpad is empty";
    }
    const top = key.split(".")[0];
    if (MyTool.DENIED_ATTRS.has(top) || top.startsWith("__")) return `Error: '${top}' is not accessible`;
    const [obj, err] = this.resolvePath(key);
    if (err) {
      if (!key.includes(".") && key in (this.runtimeState.runtimeVars ?? {})) return MyTool.formatValue(this.runtimeState.runtimeVars[key], key);
      return `Error: ${err}`;
    }
    if (!key.includes(".") && !hasRealAttr(this.runtimeState, key)) return `Error: '${key}' not found`;
    return MyTool.formatValue(obj, key);
  }

  inspectAll(): string {
    const keys = ["maxIterations", "contextWindowTokens", "model", "modelPreset", "workspace", "providerRetryMode", "maxToolResultChars", "currentIteration", "webConfig", "execConfig", "subagents", "lastUsage"];
    const lines: string[] = [];
    for (const key of keys) {
      const actual = hasRealAttr(this.runtimeState, key) ? key : null;
      if (key === "lastUsage" && actual && Object.keys(this.runtimeState[actual] ?? {}).length === 0) continue;
      if (actual) lines.push(MyTool.formatValue(this.runtimeState[actual], key));
    }
    const vars = this.runtimeState.runtimeVars ?? {};
    if (Object.keys(vars).length) lines.push(MyTool.formatValue(vars, "scratchpad"));
    return lines.join("\n");
  }

  private modify(key: string | null, value: any): string {
    const keyError = MyTool.validateKey(key);
    if (keyError) return keyError;
    key = key!;
    const top = key.split(".")[0];
    if (MyTool.BLOCKED.has(top) || MyTool.DENIED_ATTRS.has(top) || top.startsWith("__") || MyTool.isSensitiveFieldName(top)) return `Error: '${key}' is protected and cannot be modified`;
    if (MyTool.READ_ONLY.has(top)) return `Error: '${key}' is read-only and cannot be modified`;
    if (key.includes(".")) {
      const [parentPath, leaf] = [key.slice(0, key.lastIndexOf(".")), key.slice(key.lastIndexOf(".") + 1)];
      if (MyTool.DENIED_ATTRS.has(leaf) || leaf.startsWith("__") || MyTool.isSensitiveFieldName(leaf)) return `Error: '${leaf}' is not accessible`;
      const [parent, err] = this.resolvePath(parentPath);
      if (err) return `Error: ${err}`;
      if (parent instanceof Map) parent.set(leaf, value);
      else parent[leaf] = value;
      return `Set ${key} = ${tsRepr(value)}`;
    }
    if (MyTool.RESTRICTED[key]) return this.modifyRestricted(key, value);
    return this.modifyFree(key, value);
  }

  private modifyRestricted(key: string, value: any): string {
    const spec = MyTool.RESTRICTED[key];
    if (spec.type === "integer") {
      if (typeof value === "boolean") return `Error: '${key}' must be integer, got boolean`;
      const coerced = typeof value === "string" && value.trim() ? Number(value) : value;
      if (!Number.isInteger(coerced)) return `Error: '${key}' must be int, got ${typeof value}`;
      if (coerced < spec.min) return `Error: '${key}' must be >= ${spec.min}`;
      if (coerced > spec.max) return `Error: '${key}' must be <= ${spec.max}`;
      value = coerced;
    }
    if (spec.type === "string") {
      if (typeof value !== "string") return `Error: '${key}' must be string, got ${typeof value}`;
      if (value.length < spec.minLen) return `Error: '${key}' must be at least ${spec.minLen} characters`;
    }
    const actual = key;
    const old = this.runtimeState[actual];
    this.runtimeState[actual] = value;
    if (key === "model") {
      this.runtimeState.modelPreset = null;
    }
    if (key === "maxIterations" && typeof this.runtimeState.syncSubagentRuntimeLimits === "function") this.runtimeState.syncSubagentRuntimeLimits();
    return `Set ${key} = ${tsRepr(value)} (was ${tsRepr(old)})`;
  }

  private modifyFree(key: string, value: any): string {
    if (hasRealAttr(this.runtimeState, key)) {
      const old = this.runtimeState[key];
      if (["string", "number", "boolean"].includes(typeof old) && typeof old !== typeof value) return `Error: '${key}' expects ${typeof old}, got ${typeof value}`;
      try {
        this.runtimeState[key] = value;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      return `Set ${key} = ${tsRepr(value)} (was ${tsRepr(old)})`;
    }
    if (typeof value === "function") return "Error: cannot store callable values";
    const err = MyTool.validateJsonSafe(value);
    if (err) return `Error: ${err}`;
    const vars = this.runtimeState.runtimeVars;
    if (!(key in vars) && Object.keys(vars).length >= MyTool.MAX_RUNTIME_KEYS) return `Error: scratchpad is full (max ${MyTool.MAX_RUNTIME_KEYS} keys). Remove unused keys first.`;
    vars[key] = value;
    return `Set scratchpad.${key} = ${tsRepr(value)}`;
  }

  static validateJsonSafe(value: any, depth = 0): string | null {
    if (depth > 10) return "value nesting too deep (max 10 levels)";
    if (value == null || ["string", "number", "boolean"].includes(typeof value)) return null;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const err = MyTool.validateJsonSafe(value[i], depth + 1);
        if (err) return `array[${i}] contains ${err}`;
      }
      return null;
    }
    if (typeof value === "object" && value.constructor === Object) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof key !== "string") return `object key must be string, got ${typeof key}`;
        const err = MyTool.validateJsonSafe(item, depth + 1);
        if (err) return `object key '${key}' contains ${err}`;
      }
      return null;
    }
    return `unsupported type ${value?.constructor?.name ?? typeof value}`;
  }

}
