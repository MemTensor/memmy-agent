import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextBuilder } from "../../../src/core/agent-runtime/context.js";
import {
  MODEL_PRESET_CACHE,
  SETTINGS_GETTER,
  SETTINGS_SECTION_META,
  SETTINGS_SECTIONS,
  SETTINGS_SETTER,
  configureChannels,
  configureModelPresets,
  configureProvider,
  configureDraftModel,
  formatValue,
  getChannelNames,
  getConstraintHint,
  getFieldDisplayName,
  getFieldTypeInfo,
  getQuestionary,
  getProviderInfo,
  getProviderNames,
  handleFallbackModelsField,
  handleModelPresetField,
  handleProviderField,
  hasUnsavedChanges,
  inputText,
  isStringOrNull,
  maskValue,
  syncPresetCache,
  tryAutoFillContextWindow,
  validateFieldConstraintMessage,
  runOnboard,
  setQuestionary,
} from "../../../src/entrypoints/cli/onboard.js";
import { mergeMissingDefaults } from "../../../src/entrypoints/cli/commands.js";
import {
  AgentDefaults,
  ApiConfig,
  Base,
  ChannelsConfig,
  Config,
  ContextCompactionConfig,
  GatewayConfig,
  HeartbeatConfig,
  ModelPresetConfig,
  SessionDagConfig,
} from "../../../src/config/schema.js";
import { syncWorkspaceTemplates } from "../../../src/utils/helpers.js";

class FakePrompt<T> {
  constructor(private readonly value: T) {}
  async ask(): Promise<T> {
    if (this.value instanceof Error) throw this.value;
    return this.value;
  }
}

function usePrompt(responses: any[]): void {
  const next = () => {
    if (!responses.length) throw new Error("prompt exhausted");
    return responses.shift();
  };
  const resolveChoice = (raw: any, choices: string[]) => {
    if (raw === "first") return choices[0];
    if (raw === "done") return "[Done]";
    if (raw === "back") return "<- Back";
    if (raw instanceof RegExp) return choices.find((choice) => raw.test(choice)) ?? choices[0];
    return raw;
  };
  setQuestionary({
    select(message, options) {
      const choices = Array.isArray(options) ? options : options.choices;
      return new FakePrompt(resolveChoice(next(), choices));
    },
    confirm() {
      return new FakePrompt(Boolean(next()));
    },
    text() {
      return new FakePrompt(next());
    },
    autocomplete() {
      return new FakePrompt(next());
    },
    pressAnyKeyToContinue() {
      return new FakePrompt(null);
    },
  });
}

const tempDirs: string[] = [];
const originalStdinIsTty = process.stdin.isTTY;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-onboard-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  process.stdin.isTTY = originalStdinIsTty;
  setQuestionary(null);
  MODEL_PRESET_CACHE.clear();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class SimpleDraftModel extends Base {
  apiKey = "";
}

class NestedDraftModel extends Base {
  apiKey = "";
}

class OuterDraftModel extends Base {
  nested = new NestedDraftModel();
}

describe("onboard logic", () => {
  it("exposes workspace identity without file memory locations by default", () => {
    const builder = new ContextBuilder({ workspace: "/tmp/memmy-onboard" });

    expect(builder.buildSystemPrompt()).toContain("Your workspace is at: /tmp/memmy-onboard");
    expect(builder.buildSystemPrompt()).not.toContain("memory/MEMORY.md");
    expect(builder.buildSystemPrompt()).not.toContain("memory/history.jsonl");
  });

  it("uses the default prompt answer when stdin would block", async () => {
    process.stdin.isTTY = false;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(fs, "readSync").mockImplementation(() => {
      const error = new Error("resource temporarily unavailable") as NodeJS.ErrnoException;
      error.code = "EAGAIN";
      throw error;
    });

    await expect(getQuestionary().confirm("Overwrite?", { default: false }).ask()).resolves.toBe(false);
    await expect(getQuestionary().confirm("Overwrite?", { default: true }).ask()).resolves.toBe(true);
  });

  it("formats fields, masks sensitive values, extracts types, and validates constraints", () => {
    expect(getFieldDisplayName("apiKey")).toBe("Api Key");
    expect(getFieldDisplayName("timeoutS")).toBe("Timeout (seconds)");
    expect([...getFieldTypeInfo({ annotation: "integer" })]).toEqual(["integer", null]);
    expect([...getFieldTypeInfo({ choices: ["standard", "persistent"] })]).toEqual([
      "literal",
      ["standard", "persistent"],
    ]);
    expect(maskValue("sk-abcdef")).toBe("*****cdef");
    expect(formatValue("sk-secret", { rich: false, fieldName: "apiKey" })).toBe("*****cret");
    expect(formatValue([], { rich: false })).toBe("[not set]");
    expect(validateFieldConstraintMessage("b", { choices: ["a", "b"] })).toBeNull();
    expect(validateFieldConstraintMessage(3, { min: 5 })).toBe("Value must be >= 5");
    expect(getConstraintHint({ min: 1, max: 4 })).toBe(" (1-4)");
  });

  it("parses typed input and rejects invalid constrained values", async () => {
    usePrompt(["15"]);
    await expect(inputText("Retries", 3, "integer", { min: 0, max: 10 })).resolves.toBeNull();

    usePrompt(["5"]);
    await expect(inputText("Retries", 3, "integer", { min: 0, max: 10 })).resolves.toBe(5);

    usePrompt(["a, b,, c"]);
    await expect(inputText("Items", [], "array")).resolves.toEqual(["a", "b", "c"]);

    usePrompt(['{"a":1}']);
    await expect(inputText("Data", {}, "object")).resolves.toEqual({ a: 1 });

    usePrompt([""]);
    await expect(inputText("Name", "old", "string")).resolves.toBe("");
  });

  it("configures drafts transactionally and discards edits on back", async () => {
    const model = new SimpleDraftModel();
    usePrompt(["first", "secret", "back"]);

    const discarded = await configureDraftModel(model, "Simple");

    expect(discarded).toBeNull();
    expect(model.apiKey).toBe("");

    usePrompt(["first", "secret", "done"]);
    const updated = (await configureDraftModel(model, "Simple")) as SimpleDraftModel;
    expect(updated.apiKey).toBe("secret");
    expect(model.apiKey).toBe("");
  });

  it("keeps nested draft edits isolated until the parent section is done", async () => {
    const model = new OuterDraftModel();

    usePrompt(["first", "first", "secret", "back", "done"]);
    const nestedDiscarded = (await configureDraftModel(model, "Outer")) as OuterDraftModel;
    expect(nestedDiscarded.nested.apiKey).toBe("");
    expect(model.nested.apiKey).toBe("");

    usePrompt(["first", "first", "secret", "done", "done"]);
    const nestedCommitted = (await configureDraftModel(model, "Outer")) as OuterDraftModel;
    expect(nestedCommitted.nested.apiKey).toBe("secret");
    expect(model.nested.apiKey).toBe("");
  });

  it("clears optional API strings while preserving required empty strings", async () => {
    const provider = { apiKey: "secret" };
    usePrompt(["first", "Enter new value", "", "done"]);
    expect(((await configureDraftModel(provider, "Provider")) as any).apiKey).toBeNull();

    const required = { name: "old" };
    usePrompt(["first", "Enter new value", "", "done"]);
    expect(((await configureDraftModel(required, "Required")) as any).name).toBe("");
  });

  it("registers providers, channels, channel common, API server, and gateway settings", () => {
    expect(getProviderNames()).toHaveProperty("openai");
    expect(getProviderNames()).not.toHaveProperty("openai_codex");
    expect(Object.values(getProviderInfo())[0]).toHaveLength(4);
    expect(Object.keys(getChannelNames()).length).toBeGreaterThan(0);
    expect(SETTINGS_SECTIONS).toContain("Channel Common");
    expect(SETTINGS_SECTIONS).toContain("API Server");
    expect(SETTINGS_SECTIONS).toContain("Gateway");
    expect(SETTINGS_SECTIONS).toContain("Memmy Memory");
    expect(SETTINGS_SECTIONS).toContain("Session DAG");
    expect(SETTINGS_SECTIONS).toContain("Context Compaction");
    expect(SETTINGS_SECTIONS).not.toContain("Memos Memory");

    const config = new Config();
    const channels = new ChannelsConfig();
    channels.sendToolHints = true;
    SETTINGS_SETTER["Channel Common"](config, channels);
    expect(SETTINGS_GETTER["Channel Common"](config).sendToolHints).toBe(true);

    SETTINGS_SETTER["API Server"](config, new ApiConfig({ host: "0.0.0.0", port: 9999, timeout: 90 }));
    expect(config.api.port).toBe(9999);
    expect(config.api.timeout).toBe(90);

    SETTINGS_SETTER.Gateway(config, new GatewayConfig({
      host: "127.0.0.2",
      port: 18791,
      heartbeat: { enabled: true, intervalS: 900, keepRecentMessages: 4 },
    }));
    expect(config.gateway.host).toBe("127.0.0.2");
    expect(config.gateway.port).toBe(18791);
    expect(config.gateway.heartbeat.intervalS).toBe(900);
    expect(config.gateway.heartbeat.keepRecentMessages).toBe(4);

    SETTINGS_SETTER["Session DAG"](config, new SessionDagConfig({
      enabled: true,
      maxBuilderContextNodes: 20,
    }));
    expect(SETTINGS_GETTER.sessionDag(config).maxBuilderContextNodes).toBe(20);

    SETTINGS_SETTER["Context Compaction"](config, new ContextCompactionConfig({ summaryMode: "dag" }));
    expect(SETTINGS_GETTER.contextCompaction(config).summaryMode).toBe("dag");
    expect(SETTINGS_SECTION_META["Context Compaction"].displayName).toBe("Context Compaction");
  });

  it("keeps memmy-agent service ports distinct while restoring API timeout and gateway schema", () => {
    const config = new Config();

    expect(config.api.port).toBe(18990);
    expect(config.api.timeout).toBe(120);
    expect(config.gateway.host).toBe("127.0.0.1");
    expect(config.gateway.port).toBe(18970);
    expect(config.gateway.heartbeat.enabled).toBe(true);
    expect(config.gateway.heartbeat.intervalS).toBe(30 * 60);
    expect(config.gateway.heartbeat.keepRecentMessages).toBe(8);
  });

  it("treats top-level heartbeat input as a legacy alias for gateway heartbeat", () => {
    const config = new Config({ heartbeat: { enabled: false, intervalS: 600, keepRecentMessages: 3 } });

    expect(config.gateway.heartbeat.enabled).toBe(false);
    expect(config.gateway.heartbeat.intervalS).toBe(600);
    expect(config.gateway.heartbeat.keepRecentMessages).toBe(3);
    expect(config.heartbeat).toBe(config.gateway.heartbeat);
    expect(config.toObject()).not.toHaveProperty("heartbeat");
  });

  it("manages model presets through direct actions and the interactive CRUD flow", async () => {
    const config = new Config();
    await configureModelPresets(config, [
      { type: "add", name: "fast", preset: { model: "openai/gpt-4.1", provider: "openai" } },
      { type: "edit", name: "fast", preset: new ModelPresetConfig({ model: "openai/gpt-4.1-mini", provider: "openai" }) },
    ]);
    expect(config.modelPresets.fast.model).toBe("openai/gpt-4.1-mini");
    expect(MODEL_PRESET_CACHE.has("fast")).toBe(true);

    usePrompt(["[+] Add new preset", "deep", /^Model:/, "anthropic/claude-opus", "done", "back"]);
    await configureModelPresets(config, null);
    expect(config.modelPresets.deep.model).toBe("anthropic/claude-opus");

    usePrompt(["deep (anthropic/claude-opus)", "Delete", true, "back"]);
    await configureModelPresets(config, null);
    expect(config.modelPresets.deep).toBeUndefined();
  });

  it("handles model preset, provider, and fallback-model fields", async () => {
    const defaults = new AgentDefaults();
    MODEL_PRESET_CACHE.add("fast");
    await handleModelPresetField(defaults, "modelPreset", "fast");
    expect(defaults.modelPreset).toBe("fast");
    await handleModelPresetField(defaults, "modelPreset", "(clear/unset)");
    expect(defaults.modelPreset).toBeNull();

    usePrompt(["anthropic"]);
    await handleProviderField(defaults, "provider", "Provider", "auto");
    expect(defaults.provider).toBe("anthropic");

    usePrompt(["[+] Add preset", "fast", "[Done]"]);
    await handleFallbackModelsField(defaults, "fallbackModels", "Fallback Models", []);
    expect(defaults.fallbackModels).toEqual(["fast"]);
  });

  it("pre-fills provider apiBase from the provider registry default", async () => {
    const config = new Config();

    usePrompt(["done"]);
    await configureProvider(config, "deepseek");

    expect(config.providers.deepseek.apiBase).toBe("https://api.deepseek.com");
  });

  it("uses nanobot-equivalent TS field skips for settings sections", () => {
    expect(SETTINGS_SECTION_META["Agent Settings"].skipFields.has("dream")).toBe(false);
    expect(SETTINGS_SECTION_META.Tools.skipFields.has("mcpServers")).toBe(true);
  });

  it("runs the main menu, saves committed changes, and can discard unsaved changes", async () => {
    const initial = new Config();

    usePrompt(["[H] Channel Common", /Send Tool Hints/, true, "done", "[S] Save and Exit"]);
    const saved = await runOnboard(initial);
    expect(saved.shouldSave).toBe(true);
    expect(saved.changed).toBe(true);
    expect(saved.config.channels.sendToolHints).toBe(true);

    usePrompt(["[A] Agent Settings", /Bot Name/, "Enter new value", "memmy-test", "done", "[X] Exit Without Saving"]);
    const discarded = await runOnboard(initial);
    expect(discarded.shouldSave).toBe(false);
    expect(discarded.config.toObject()).toEqual(initial.toObject());
  });

  it("views the summary, syncs preset cache, and detects dirty drafts", async () => {
    const config = new Config();
    config.modelPresets.fast = new ModelPresetConfig({ model: "gpt-test" });
    syncPresetCache(config);
    expect(MODEL_PRESET_CACHE.has("fast")).toBe(true);

    const changed = new Config();
    changed.api.port = 9999;
    expect(hasUnsavedChanges(config, changed)).toBe(true);

    usePrompt(["[V] View Configuration Summary", null, "[S] Save and Exit"]);
    await expect(runOnboard(new Config())).resolves.toMatchObject({ shouldSave: true });
  });

  it("adds missing top-level defaults", () => {
    expect(mergeMissingDefaults({ a: 1 }, { a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("preserves existing values when merging defaults", () => {
    expect(mergeMissingDefaults({ a: "custom_value" }, { a: "default_value" })).toEqual({ a: "custom_value" });
  });

  it("merges nested dictionaries recursively", () => {
    const existing = { level1: { level2: { existing: "kept" } } };
    const defaults = { level1: { level2: { existing: "replaced", added: "new" }, level2b: "also_new" } };
    expect(mergeMissingDefaults(existing, defaults)).toEqual({
      level1: { level2: { existing: "kept", added: "new" }, level2b: "also_new" },
    });
  });

  it("returns non-object existing defaults unchanged", () => {
    expect(mergeMissingDefaults("string", { a: 1 })).toBe("string");
  });

  it("returns array existing defaults unchanged", () => {
    expect(mergeMissingDefaults([1, 2, 3], { a: 1 })).toEqual([1, 2, 3]);
  });

  it("returns null existing defaults unchanged", () => {
    expect(mergeMissingDefaults(null, { a: 1 })).toBeNull();
  });

  it("returns existing object when defaults are not objects", () => {
    expect(mergeMissingDefaults({ a: 1 }, "string")).toEqual({ a: 1 });
  });

  it("handles empty dictionaries while merging defaults", () => {
    expect(mergeMissingDefaults({}, { a: 1 })).toEqual({ a: 1 });
    expect(mergeMissingDefaults({ a: 1 }, {})).toEqual({ a: 1 });
    expect(mergeMissingDefaults({}, {})).toEqual({});
  });

  it("backfills missing channel config fields", () => {
    const result = mergeMissingDefaults(
      { enabled: false, appId: "", secret: "" },
      { enabled: false, appId: "", secret: "", msgFormat: "plain", allowFrom: [] },
    );
    expect(result.msgFormat).toBe("plain");
    expect(result.allowFrom).toEqual([]);
  });

  it("extracts string field type info from String", () => {
    expect([...getFieldTypeInfo({ annotation: String })]).toEqual(["string", null]);
  });

  it("extracts integer field type info", () => {
    expect([...getFieldTypeInfo({ annotation: "integer" })]).toEqual(["integer", null]);
  });

  it("extracts boolean field type info", () => {
    expect([...getFieldTypeInfo({ annotation: Boolean })]).toEqual(["boolean", null]);
  });

  it("extracts number field type info from Number", () => {
    expect([...getFieldTypeInfo({ annotation: Number })]).toEqual(["number", null]);
  });

  it("extracts array field type info with item type", () => {
    expect([...getFieldTypeInfo({ annotation: Array, inner: String })]).toEqual(["array", String]);
  });

  it("extracts array field type info without an item type", () => {
    expect([...getFieldTypeInfo({ annotation: "array" })]).toEqual(["array", String]);
  });

  it("extracts object field type info", () => {
    expect([...getFieldTypeInfo({ annotation: Object })]).toEqual(["object", null]);
  });

  it("unwraps optional string field type info", () => {
    expect([...getFieldTypeInfo({ annotation: ["string", "null"] })]).toEqual(["string", null]);
  });

  it("extracts nested model field type info", () => {
    class Inner extends Base {
      x = 1;
    }

    expect([...getFieldTypeInfo({ annotation: Inner })]).toEqual(["model", Inner]);
  });

  it("falls back to string when field annotation is missing", () => {
    expect([...getFieldTypeInfo({ annotation: null })]).toEqual(["string", null]);
  });

  it("extracts literal field type info from choices", () => {
    expect([...getFieldTypeInfo({ annotation: "string", choices: ["standard", "persistent"] })]).toEqual([
      "literal",
      ["standard", "persistent"],
    ]);
  });

  it("extracts literal type info for the provider retry mode field", () => {
    expect([...getFieldTypeInfo({ annotation: "string", choices: ["standard", "persistent"], value: "standard" })]).toEqual([
      "literal",
      ["standard", "persistent"],
    ]);
  });

  it("uses field descriptions as display names", () => {
    expect(getFieldDisplayName("apiKey", { description: "API Key for authentication" })).toBe("API Key for authentication");
  });

  it("converts camel case field names to titles", () => {
    expect(getFieldDisplayName("userName", { description: null })).toBe("User Name");
  });

  it("adds URL suffix display names", () => {
    expect(getFieldDisplayName("apiUrl", { description: null })).toContain("URL");
  });

  it("adds path suffix display names", () => {
    expect(getFieldDisplayName("filePath", { description: null })).toContain("Path");
  });

  it("adds ID suffix display names", () => {
    expect(getFieldDisplayName("userId", { description: null })).toContain("ID");
  });

  it("adds key suffix display names", () => {
    expect(getFieldDisplayName("apiKey", { description: null })).toContain("Key");
  });

  it("adds token suffix display names", () => {
    expect(getFieldDisplayName("authToken", { description: null })).toContain("Token");
  });

  it("adds seconds suffix display names", () => {
    expect(getFieldDisplayName("timeoutS", { description: null })).toContain("(seconds)");
  });

  it("adds millisecond suffix display names", () => {
    expect(getFieldDisplayName("delayMs", { description: null })).toContain("(ms)");
  });

  it("formats null as not set", () => {
    expect(formatValue(null)).toContain("not set");
  });

  it("formats empty strings as not set", () => {
    expect(formatValue("")).toContain("not set");
  });

  it("formats empty dictionaries as not set", () => {
    expect(formatValue({})).toContain("not set");
  });

  it("formats empty lists as not set", () => {
    expect(formatValue([])).toContain("not set");
  });

  it("formats string values", () => {
    expect(formatValue("hello")).toContain("hello");
  });

  it("formats array values", () => {
    expect(formatValue(["a", "b"])).toContain("a");
  });

  it("formats object values", () => {
    expect(formatValue({ key: "value" })).toContain("key");
  });

  it("formats integer values", () => {
    expect(formatValue(42)).toContain("42");
  });

  it("formats true boolean values", () => {
    expect(formatValue(true).toLowerCase()).toContain("true");
  });

  it("formats false boolean values", () => {
    expect(formatValue(false).toLowerCase()).toContain("false");
  });

  it("creates missing workspace template files", () => {
    const workspace = makeTempDir();
    const added = syncWorkspaceTemplates(workspace);
    expect(Array.isArray(added)).toBe(true);
    expect(fs.existsSync(path.join(workspace, "memory", "MEMORY.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "memory", "history.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
  });

  it("creates file memory assets only when explicitly enabled", () => {
    const workspace = makeTempDir();
    const added = syncWorkspaceTemplates(workspace, undefined, {
      fileMemoryEnabled: true,
    });

    expect(added).toContain(path.join("memory", "MEMORY.md"));
    expect(fs.existsSync(path.join(workspace, "memory", "MEMORY.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "memory", "history.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "memory", ".dreamCursor"))).toBe(true);
  });

  it("does not overwrite existing workspace template files", () => {
    const workspace = makeTempDir();
    fs.writeFileSync(path.join(workspace, "AGENTS.md"), "existing content", "utf8");
    syncWorkspaceTemplates(workspace);
    expect(fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8")).toBe("existing content");
  });

  it("does not create TOOLS.md in workspaces", () => {
    const workspace = makeTempDir();
    const added = syncWorkspaceTemplates(workspace);
    expect(added).not.toContain("TOOLS.md");
    expect(fs.existsSync(path.join(workspace, "TOOLS.md"))).toBe(false);
  });

  it("preserves an existing TOOLS.md file", () => {
    const workspace = makeTempDir();
    fs.writeFileSync(path.join(workspace, "TOOLS.md"), "custom tool notes", "utf8");
    syncWorkspaceTemplates(workspace);
    expect(fs.readFileSync(path.join(workspace, "TOOLS.md"), "utf8")).toBe("custom tool notes");
  });

  it("creates the memory directory during workspace template sync", () => {
    const workspace = makeTempDir();
    syncWorkspaceTemplates(workspace);
    expect(fs.existsSync(path.join(workspace, "memory"))).toBe(true);
  });

  it("returns relative paths for added workspace template files", () => {
    const workspace = makeTempDir();
    const added = syncWorkspaceTemplates(workspace);
    expect(added.every((item) => !path.isAbsolute(item))).toBe(true);
  });

  it("returns provider names without oauth-only providers", () => {
    const names = getProviderNames();
    expect(names).toHaveProperty("openai");
    expect(names).toHaveProperty("anthropic");
    expect(names).not.toHaveProperty("openai_codex");
    expect(names).not.toHaveProperty("github_copilot");
  });

  it("returns channel names as an object", () => {
    expect(Object.keys(getChannelNames()).length).toBeGreaterThan(0);
  });

  it("stays in the chat channels section until back is selected", async () => {
    const config = new Config();
    const channels = Object.keys(getChannelNames()).sort();
    const responses: any[] = [channels[0], "done", channels[1], "done", "back"];
    const select = vi.fn(() => {
      const raw = responses.shift();
      if (raw === "done") return new FakePrompt("[Done]");
      if (raw === "back") return new FakePrompt("<- Back");
      return new FakePrompt(raw);
    });
    setQuestionary({
      select,
      confirm: () => new FakePrompt(false),
      text: () => new FakePrompt(""),
      autocomplete: () => new FakePrompt(""),
      pressAnyKeyToContinue: () => new FakePrompt(null),
    });

    await configureChannels(config);

    expect(responses).toEqual([]);
    expect(select).toHaveBeenCalledTimes(5);
  });

  it("returns provider info tuples with four fields", () => {
    for (const value of Object.values(getProviderInfo())) expect(value).toHaveLength(4);
  });

  it("accepts unconstrained values", () => {
    expect(validateFieldConstraintMessage("anything", {})).toBeNull();
  });

  it("rejects values below lower bounds", () => {
    expect(validateFieldConstraintMessage(-1, { ge: 0 })).toContain("0");
  });

  it("accepts values at lower bounds", () => {
    expect(validateFieldConstraintMessage(0, { ge: 0 })).toBeNull();
  });

  it("rejects values above upper bounds", () => {
    expect(validateFieldConstraintMessage(11, { le: 10 })).toContain("10");
  });

  it("accepts values at upper bounds", () => {
    expect(validateFieldConstraintMessage(10, { le: 10 })).toBeNull();
  });

  it("validates combined inclusive bounds", () => {
    expect(validateFieldConstraintMessage(5, { ge: 0, le: 10 })).toBeNull();
    expect(validateFieldConstraintMessage(-1, { ge: 0, le: 10 })).not.toBeNull();
    expect(validateFieldConstraintMessage(11, { ge: 0, le: 10 })).not.toBeNull();
  });

  it("validates strict numeric bounds", () => {
    expect(validateFieldConstraintMessage(0.5, { gt: 0, lt: 1 })).toBeNull();
    expect(validateFieldConstraintMessage(0, { gt: 0, lt: 1 })).not.toBeNull();
    expect(validateFieldConstraintMessage(1, { gt: 0, lt: 1 })).not.toBeNull();
  });

  it("validates minimum string length", () => {
    expect(validateFieldConstraintMessage("a", { minLength: 1 })).toBeNull();
    expect(validateFieldConstraintMessage("", { minLength: 1 })).not.toBeNull();
  });

  it("validates maximum string length", () => {
    expect(validateFieldConstraintMessage("abc", { maxLength: 5 })).toBeNull();
    expect(validateFieldConstraintMessage("abcdef", { maxLength: 5 })).not.toBeNull();
  });

  it("validates send max retries bounds", () => {
    expect(validateFieldConstraintMessage(3, { min: 0, max: 10 })).toBeNull();
    expect(validateFieldConstraintMessage(-1, { min: 0, max: 10 })).not.toBeNull();
    expect(validateFieldConstraintMessage(11, { min: 0, max: 10 })).not.toBeNull();
  });

  it("returns empty constraint hints when no bounds are present", () => {
    expect(getConstraintHint({})).toBe("");
  });

  it("returns range constraint hints", () => {
    expect(getConstraintHint({ ge: 0, le: 10 })).toBe(" (0-10)");
  });

  it("returns lower-bound constraint hints", () => {
    expect(getConstraintHint({ ge: 0 })).toBe(" (>= 0)");
  });

  it("returns upper-bound constraint hints", () => {
    expect(getConstraintHint({ le: 100 })).toBe(" (<= 100)");
  });

  it("returns send max retries constraint hints", () => {
    expect(getConstraintHint({ min: 0, max: 10 })).toBe(" (0-10)");
  });

  it("rejects out-of-range integer input", async () => {
    usePrompt(["15"]);
    await expect(inputText("Retries", 3, "integer", { ge: 0, le: 10 })).resolves.toBeNull();
  });

  it("accepts valid constrained integer input", async () => {
    usePrompt(["5"]);
    await expect(inputText("Retries", 3, "integer", { ge: 0, le: 10 })).resolves.toBe(5);
  });

  it("accepts integer input without field constraints", async () => {
    usePrompt(["42"]);
    await expect(inputText("Count", 0, "integer")).resolves.toBe(42);
  });

  it("keeps empty string input as an empty string", async () => {
    usePrompt([""]);
    await expect(inputText("Name", "old", "string")).resolves.toBe("");
  });

  it("keeps null prompt results as null", async () => {
    usePrompt([null]);
    await expect(inputText("Name", "old", "string")).resolves.toBeNull();
  });

  it("registers Channel Common in settings sections", () => {
    expect(SETTINGS_SECTIONS).toContain("Channel Common");
  });

  it("returns config.channels for the Channel Common getter", () => {
    const config = new Config();
    expect(SETTINGS_GETTER["Channel Common"](config)).toBe(config.channels);
  });

  it("writes config.channels from the Channel Common setter", () => {
    const config = new Config();
    const channels = new ChannelsConfig({ sendToolHints: true });
    SETTINGS_SETTER["Channel Common"](config, channels);
    expect(config.channels.sendToolHints).toBe(true);
  });

  it("preserves per-channel extras while editing Channel Common", () => {
    const config = new Config();
    const channels = new ChannelsConfig({ sendToolHints: true });
    (channels as any).feishu = { enabled: true, appId: "test123" };
    SETTINGS_SETTER["Channel Common"](config, channels);
    expect((config.channels as any).feishu.appId).toBe("test123");
  });

  it("registers API Server in settings sections", () => {
    expect(SETTINGS_SECTIONS).toContain("API Server");
  });

  it("returns config.api for the API Server getter", () => {
    const config = new Config();
    expect(SETTINGS_GETTER["API Server"](config)).toBe(config.api);
  });

  it("writes config.api from the API Server setter", () => {
    const config = new Config();
    SETTINGS_SETTER["API Server"](config, new ApiConfig({ host: "0.0.0.0", port: 9999, timeout: 45 }));
    expect(config.api.host).toBe("0.0.0.0");
    expect(config.api.port).toBe(9999);
    expect(config.api.timeout).toBe(45);
  });

  it("writes config.gateway from the Gateway setter", () => {
    const config = new Config();
    SETTINGS_SETTER.Gateway(config, new GatewayConfig({
      enabled: true,
      host: "0.0.0.0",
      port: 19999,
      heartbeat: new HeartbeatConfig({ enabled: false, intervalS: 300, keepRecentMessages: 2 }),
    }));
    expect(config.gateway.enabled).toBe(true);
    expect(config.gateway.host).toBe("0.0.0.0");
    expect(config.gateway.port).toBe(19999);
    expect(config.gateway.heartbeat.enabled).toBe(false);
    expect(config.gateway.heartbeat.intervalS).toBe(300);
    expect(config.gateway.heartbeat.keepRecentMessages).toBe(2);
  });

  it("runs the main menu API Server edit path", async () => {
    usePrompt(["[I] API Server", /Port/, "Enter new value", "9999", "done", "[S] Save and Exit"]);
    const result = await runOnboard(new Config());
    expect(result.shouldSave).toBe(true);
    expect(result.config.api.port).toBe(9999);
  });

  it("runs the main menu Memmy Memory edit path", async () => {
    usePrompt(["[R] Memmy Memory", /Enabled/, true, "done", "[S] Save and Exit"]);
    const result = await runOnboard(new Config());

    expect(result.shouldSave).toBe(true);
    expect(result.config.memmyMemory.enabled).toBe(true);
  });

  it("runs the main menu Model Presets edit path", async () => {
    usePrompt([
      "[M] Model Presets",
      "[+] Add new preset",
      "deep",
      /^Model:/,
      "anthropic/claude-opus",
      "done",
      "back",
      "[S] Save and Exit",
    ]);

    const result = await runOnboard(new Config());

    expect(result.shouldSave).toBe(true);
    expect(result.config.modelPresets.deep.model).toBe("anthropic/claude-opus");
  });

  it("detects string-or-null metadata from arrays", () => {
    expect(isStringOrNull(["string", "null"])).toBe(true);
  });

  it("detects optional string metadata from objects", () => {
    expect(isStringOrNull({ nullable: true })).toBe(true);
  });

  it("does not treat required strings as optional strings", () => {
    expect(isStringOrNull(String)).toBe(false);
  });

  it("does not treat integer-or-null as string-or-null", () => {
    expect(isStringOrNull(["integer", "null"])).toBe(false);
  });

  it("syncs all model preset names into the cache", () => {
    const config = new Config();
    config.modelPresets.fast = new ModelPresetConfig({ model: "gpt-4.1-mini" });
    config.modelPresets.power = new ModelPresetConfig({ model: "gpt-4.1" });
    syncPresetCache(config);
    expect(MODEL_PRESET_CACHE).toEqual(new Set(["fast", "power"]));
  });

  it("deletes model presets through direct actions", async () => {
    const config = new Config();
    config.modelPresets.old = new ModelPresetConfig({ model: "x" });
    await configureModelPresets(config, [{ type: "delete", name: "old" }]);
    expect(config.modelPresets.old).toBeUndefined();
  });

  it("adds fallback model presets through the field handler", async () => {
    const defaults = new AgentDefaults();
    MODEL_PRESET_CACHE.add("fast");
    usePrompt(["[+] Add preset", "fast", "[Done]"]);
    await handleFallbackModelsField(defaults, "fallbackModels", "Fallback Models", []);
    expect(defaults.fallbackModels).toEqual(["fast"]);
  });

  it("removes fallback model presets through the field handler", async () => {
    const defaults = new AgentDefaults({ fallbackModels: ["fast", "slow"] });
    usePrompt(["[-] Remove last", "[Done]"]);
    await handleFallbackModelsField(defaults, "fallbackModels", "Fallback Models", defaults.fallbackModels);
    expect(defaults.fallbackModels).toEqual(["fast"]);
  });

  it("clears fallback model presets through the field handler", async () => {
    const defaults = new AgentDefaults({ fallbackModels: ["fast", "slow"] });
    usePrompt(["[X] Clear all", "[Done]"]);
    await handleFallbackModelsField(defaults, "fallbackModels", "Fallback Models", defaults.fallbackModels);
    expect(defaults.fallbackModels).toEqual([]);
  });

  it("leaves provider unchanged when provider selection goes back", async () => {
    const defaults = new AgentDefaults({ provider: "auto" });
    usePrompt(["back"]);
    await handleProviderField(defaults, "provider", "Provider", "auto");
    expect(defaults.provider).toBe("auto");
  });

  it("auto-fills context window when the current value is the default", () => {
    const model = { provider: "openai", contextWindowTokens: 200_000 };

    const changed = tryAutoFillContextWindow(model, "openai/gpt-4.1", () => 1_000_000);

    expect(changed).toBe(true);
    expect(model.contextWindowTokens).toBe(1_000_000);
  });

  it("does not auto-fill legacy-sized explicit context window values", () => {
    const model = { provider: "openai", contextWindowTokens: 65_536 };

    const changed = tryAutoFillContextWindow(model, "openai/gpt-4.1", () => 1_000_000);

    expect(changed).toBe(false);
    expect(model.contextWindowTokens).toBe(65_536);
  });

  it("does not auto-fill non-default context window values", () => {
    const model = { provider: "openai", contextWindowTokens: 128_000 };

    const changed = tryAutoFillContextWindow(model, "openai/gpt-4.1", () => 1_000_000);

    expect(changed).toBe(false);
    expect(model.contextWindowTokens).toBe(128_000);
  });
});
