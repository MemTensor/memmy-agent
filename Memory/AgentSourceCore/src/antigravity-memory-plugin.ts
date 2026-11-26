import { lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ANTIGRAVITY_FULL_TRANSCRIPT_NAME,
  ANTIGRAVITY_MEMORY_CONTEXT_TAG,
  ANTIGRAVITY_RESUME_CONTEXT_TAG,
  ANTIGRAVITY_SOURCE_ID,
  ANTIGRAVITY_TRANSCRIPT_NAME
} from "./antigravity-source-turn.js";

const PLUGIN_ID = "memmy-memory";
const HOOK_FILE = "memmy-antigravity-hook.mjs";
const BRIDGE_FILE = "memmy-workspace-bridge.mjs";
const CONFIG_FILE = "memmy-memory-config.json";
const LOGO_FILE = "assets/memmy-app-icon.png";
const SKILL_FILE = "skills/memmy-memory/SKILL.md";
const RESUME_SKILL = "skills/memmy-resume/SKILL.md";
const RESUME_HOOK = "memmy-resume-hook.mjs";

export function createAntigravityHookCommand(hookPath: string, nodeCommand: (path: string) => string): string {
  if (!process.versions.electron) return nodeCommand(hookPath);
  // The packaged app provides a Node runtime through Electron.
  if (process.platform === "win32") {
    return `set "ELECTRON_RUN_AS_NODE=1" && "${process.execPath}" "${hookPath}"`;
  }
  const quote = (path: string) => `'${path.replace(/'/g, "'\\''")}'`;
  return `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(hookPath)}`;
}

interface AntigravityMemoryPluginOptions {
  appDirectory: string;
  configDirectory: string;
  hookCommand(hookPath: string): string;
  loadBridge(): Promise<string>;
  loadConfig(): Promise<object>;
  loadLogo(): Promise<Buffer>;
  skillContent: string;
  resumeSkill: string;
  resumeHook: string;
}

export function createAntigravityMemoryPlugin(options: AntigravityMemoryPluginOptions) {
  const plugins = join(options.configDirectory, "plugins");
  const directory = join(plugins, PLUGIN_ID);
  const skills = join(options.configDirectory, "skills");
  const standaloneDirectory = join(skills, PLUGIN_ID);
  const standaloneFile = join(standaloneDirectory, "SKILL.md");
  const manifest = json({
    name: PLUGIN_ID,
    displayName: "Memmy Memory",
    version: "1.0.1",
    description: "Recall Memmy memories and save completed Antigravity turns.",
    logo: LOGO_FILE,
    author: "MemTensor"
  });
  const hookSource = renderHook();
  const hooks = json({
    [PLUGIN_ID]: {
      SessionStart: [{ type: "command", command: options.hookCommand(join(directory, HOOK_FILE)) + " session-start", timeout: 8 }],
      PreInvocation: [{ type: "command", command: options.hookCommand(join(directory, HOOK_FILE)) + " pre-invocation", timeout: 60 }],
      Stop: [{ type: "command", command: options.hookCommand(join(directory, HOOK_FILE)) + " stop", timeout: 15 }]
    }
  });
  const skill = "---\nname: memmy-memory\ndescription: Search Memmy when a task needs earlier decisions, preferences, or context.\n---\n\n"
    + options.skillContent + "\n";

  async function isPluginInstalled(): Promise<boolean> {
    if (await antigravityDirectoryState(plugins, PLUGIN_ID) !== "directory") return false;
    const hookFile = join(directory, HOOK_FILE);
    return (await lstat(hookFile).catch(ignoreMissingPath))?.isFile() === true
      && (await optionalText(hookFile))?.startsWith(HOOK_HEADER) === true;
  }

  async function standaloneSkillState(): Promise<"missing" | "owned" | "unmanaged"> {
    const directoryState = await antigravityDirectoryState(skills, PLUGIN_ID);
    if (directoryState !== "directory") return directoryState;
    const file = await lstat(standaloneFile).catch(ignoreMissingPath);
    if (!file) return "missing";
    if (!file.isFile()) return "unmanaged";
    const content = await optionalText(standaloneFile);
    return content?.replaceAll("\r\n", "\n").startsWith(STANDALONE_SKILL_HEADER) ? "owned" : "unmanaged";
  }

  async function isStandaloneSkillInstalled(): Promise<boolean> {
    return await standaloneSkillState() === "owned";
  }

  async function isPluginComplete(): Promise<boolean> {
    if (!await isPluginInstalled()) return false;
    const files = await Promise.all(["plugin.json", "hooks.json", BRIDGE_FILE, CONFIG_FILE, LOGO_FILE, SKILL_FILE, RESUME_SKILL, RESUME_HOOK]
      .map((file) => stat(join(directory, file)).catch(ignoreMissingPath)));
    return files.every((file) => file?.isFile() && file.size > 0);
  }

  async function resolveRootDirectory(): Promise<string | null> {
    return (await stat(options.appDirectory).catch(ignoreMissingPath))?.isDirectory() ? options.configDirectory : null;
  }

  return {
    resolveRootDirectory,
    async isInstalled() {
      return await isPluginComplete() || await isStandaloneSkillInstalled();
    },
    isPluginInstalled,
    isStandaloneSkillInstalled,
    async install(manifest: { content: string }) {
      if (await standaloneSkillState() === "unmanaged") {
        throw new Error("The Antigravity memmy-memory skill directory is already in use");
      }
      await mkdir(standaloneDirectory, { recursive: true });
      const staging = await mkdtemp(join(options.configDirectory, ".memmy-skill-"));
      try {
        const file = join(staging, "SKILL.md");
        await writeFile(file, STANDALONE_SKILL_HEADER + "\n" + manifest.content.trimEnd() + "\n");
        await rename(file, standaloneFile);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },

    async uninstall() {
      if (!await isStandaloneSkillInstalled()) return;
      await rm(standaloneFile, { force: true });
      // Users may keep other files alongside the generated skill.
      await rmdir(standaloneDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error;
      });
    },

    async isInstalledHookCurrent() {
      if (!await isPluginComplete()) return false;
      const files = await Promise.all(["plugin.json", "hooks.json", HOOK_FILE, BRIDGE_FILE, SKILL_FILE, RESUME_SKILL, RESUME_HOOK]
        .map((file) => optionalText(join(directory, file))));
      const logo = await readFile(join(directory, LOGO_FILE)).catch(ignoreMissingPath);
      return files[0] === manifest && files[1] === hooks && files[2] === hookSource
        && files[3] === await options.loadBridge() && files[4] === skill
        && files[5] === options.resumeSkill && files[6] === options.resumeHook
        && logo?.equals(await options.loadLogo()) === true;
    },

    async installPlugin() {
      if (!await resolveRootDirectory()) throw new Error("Antigravity App is unavailable");
      const existing = await antigravityDirectoryState(plugins, PLUGIN_ID);
      if (existing !== "missing" && !await isPluginInstalled()) throw new Error("The Antigravity memmy-memory plugin directory is already in use");
      const [bridge, config, logo] = await Promise.all([options.loadBridge(), options.loadConfig(), options.loadLogo()]);
      await mkdir(plugins, { recursive: true });
      // Stage outside plugins, so Antigravity can only discover a complete plugin.
      const staging = await mkdtemp(join(options.configDirectory, ".memmy-install-"));
      const pending = join(staging, "pending");
      const previous = join(staging, "previous");
      let keepPrevious = false;
      try {
        await Promise.all([mkdir(join(pending, "skills", PLUGIN_ID), { recursive: true }),
          mkdir(join(pending, "skills", "memmy-resume"), { recursive: true }),
          mkdir(join(pending, "assets"), { recursive: true })]);
        await Promise.all([
          writeFile(join(pending, "plugin.json"), manifest),
          writeFile(join(pending, LOGO_FILE), logo),
          writeFile(join(pending, "hooks.json"), hooks),
          writeFile(join(pending, HOOK_FILE), hookSource),
          writeFile(join(pending, BRIDGE_FILE), bridge),
          writeFile(join(pending, SKILL_FILE), skill),
          writeFile(join(pending, RESUME_SKILL), options.resumeSkill),
          writeFile(join(pending, RESUME_HOOK), options.resumeHook),
          writeFile(join(pending, CONFIG_FILE), json(config), { mode: 0o600 })
        ]);
        if (existing === "directory") {
          await rename(directory, previous);
          keepPrevious = true;
        }
        try {
          await rename(pending, directory);
        } catch (error) {
          if (keepPrevious) {
            await rename(previous, directory);
            keepPrevious = false;
          }
          throw error;
        }
        keepPrevious = false;
      } finally {
        if (!keepPrevious) await rm(staging, { recursive: true, force: true });
      }
    },

    async uninstallPlugin() {
      if (await isPluginInstalled()) await rm(directory, { recursive: true, force: true });
    }
  };
}

/** The configured root is authoritative. Links below it belong to their external manager. */
export async function antigravityDirectoryState(collection: string, name: string): Promise<"missing" | "directory" | "unmanaged"> {
  const parent = await lstat(collection).catch(ignoreMissingPath);
  if (!parent) return "missing";
  if (!parent.isDirectory()) return "unmanaged";
  const child = await lstat(join(collection, name)).catch(ignoreMissingPath);
  if (!child) return "missing";
  return child.isDirectory() ? "directory" : "unmanaged";
}

function json(value: object): string {
  return JSON.stringify(value, null, 2) + "\n";
}

async function optionalText(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(ignoreMissingPath);
}

function ignoreMissingPath(error: unknown): undefined {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
  throw error;
}

// Keep the frontmatter shared by existing backend and Memory installations.
const STANDALONE_SKILL_HEADER = "---\nname: memmy-memory\ndescription: Use shared Memmy memory when prior context may be relevant.\n---\n";
const HOOK_HEADER = "// Memmy-owned Antigravity memory hook\n";
function renderHook(): string {
  return HOOK_HEADER + String.raw`import { basename, dirname, isAbsolute } from "node:path";
import { stdin, stdout } from "node:process";
import { handleAntigravityResume } from "./${RESUME_HOOK}";
import {
  antigravityConversationId,
  antigravityUserText,
  completeSourceTurn,
  findAntigravityTranscript,
  loadRuntimeL3,
  openRuntimeSession,
  readAntigravityHookTurn,
  startRuntimeTurn
} from "./memmy-workspace-bridge.mjs";

const configUrl = new URL("./${CONFIG_FILE}", import.meta.url);
const source = "${ANTIGRAVITY_SOURCE_ID}";
const contextTag = ${JSON.stringify(ANTIGRAVITY_MEMORY_CONTEXT_TAG)};
const resumeTag = ${JSON.stringify(ANTIGRAVITY_RESUME_CONTEXT_TAG)};
const timeoutMs = 1500;

async function main(event, payload) {
  const { conversationId, transcriptPath, workspacePaths, lastUserInput, fullyIdle, terminationReason } = payload;
  if (typeof conversationId !== "string" || !conversationId.trim()) return {};
  const workspacePath = Array.isArray(workspacePaths)
    ? workspacePaths.find(path => typeof path === "string" && isAbsolute(path))
    : undefined;
  const open = (transition) => openRuntimeSession({
    configUrl, source, adapterId: "memmy-antigravity-hook", sessionKey: conversationId,
    workspaceRoot: workspacePath, transition, pinnedOwner: true
  }, { timeoutMs });
  if (event === "session-start") {
    const session = await open("allow_legacy_rollover");
    const loaded = session && await loadRuntimeL3(session, { timeoutMs });
    return context(loaded?.additionalContext, "l3");
  }
  if (event === "stop" && (fullyIdle !== true || !["NO_TOOL_CALL", "model_stop"].includes(terminationReason))) return {};
  if (event === "pre-invocation" && payload.invocationNum > 0) return {};
  if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)
    || ![${JSON.stringify(ANTIGRAVITY_FULL_TRANSCRIPT_NAME)}, ${JSON.stringify(ANTIGRAVITY_TRANSCRIPT_NAME)}].includes(basename(transcriptPath))
    || antigravityConversationId(transcriptPath) !== conversationId) return {};
  const file = await findAntigravityTranscript(dirname(transcriptPath));
  if (!file) return {};
  const current = await readAntigravityHookTurn({
    transcriptPath: file.path, conversationId, workspacePath, signal: AbortSignal.timeout(timeoutMs)
  });
  const latestPrompt = antigravityUserText(lastUserInput);
  if (!current || (latestPrompt && current.prompt !== latestPrompt)) return {};

  if (event === "pre-invocation" && current.canRecall) {
    const resume = await handleAntigravityResume(conversationId, current.prompt);
    if (resume) {
      const instruction = resume.kind === "result"
        ? "For this turn, show the following Memmy result to the user and wait for their selection. Do not call tools or start a task."
        : "For this turn, continue the task selected by the user using the following Memmy context.";
      return inject(resumeTag + "\n" + instruction + "\n\n" + resume.text + "\n</memmy_resume>");
    }
    const session = await open("resume_only");
    const result = session && await startRuntimeTurn(session, current.id, current.query);
    return context(result?.injectedContext?.markdown ?? result?.injectedContext, "recall");
  }
  if (event === "stop" && current.completed) {
    await completeSourceTurn({ configUrl, turn: current.completed });
  }
  return {};
}

function context(markdown, kind) {
  if (typeof markdown !== "string" || !markdown.trim()) return {};
  const opening = kind === "recall" ? contextTag : '<memmy_memory_context source="antigravity_l3">';
  return inject(opening + "\nUse relevant historical context to support the current task.\n\n"
    + markdown.slice(0, 24000) + "\n</memmy_memory_context>");
}

function inject(text) {
  return { injectSteps: [{ systemMessage: { systemMessage: text } }] };
}

let output = {};
try {
  let input = "";
  for await (const chunk of stdin) input += chunk;
  output = await main(process.argv[2], JSON.parse(input));
} catch {
  // An unavailable memory service or transcript must let the Antigravity turn proceed.
}
stdout.write(JSON.stringify(output));
`;
}
