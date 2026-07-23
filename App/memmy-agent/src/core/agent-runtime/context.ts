import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./memory.js";
import { SkillsLoader } from "./skills.js";
import { SystemPromptBuildContext, type AgentHook, type SystemPromptSection } from "./hook.js";
import { Session } from "../session/manager.js";
import { goalStateRuntimeLines } from "../session/goal-state.js";
import { detectImageMime, truncateText } from "../../utils/helpers.js";
import { renderTemplate } from "../../utils/prompt-templates.js";

export type AgentResponseLanguage = "zh-CN" | "en-US";

function currentTimeStr(timezone?: string | null): string {
  const now = new Date();
  if (!timezone) return now.toISOString();
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "long",
      timeZone: timezone,
      timeZoneName: "short",
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

function mimeFromExtension(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return null;
}

export function normalizeAgentResponseLanguage(value: unknown): AgentResponseLanguage | null {
  return value === "zh-CN" || value === "en-US" ? value : null;
}

function responseLanguageSection(language: AgentResponseLanguage | null): SystemPromptSection | null {
  if (language === "zh-CN") {
    return {
      id: "response-language",
      content: [
        "# 语言要求",
        "",
        "当前桌面端界面语言是简体中文（zh-CN）。所有用户可见内容都必须使用简体中文，包括最终回复、工具步骤说明、状态说明，以及产品界面会展示的 reasoning/thinking/思考内容。除非用户明确要求英文，或需要保留英文专有名词、命令、代码和错误原文，否则不要用英文输出可见思考内容。"
      ].join("\n"),
    };
  }
  if (language === "en-US") {
    return {
      id: "response-language",
      content: [
        "# Language",
        "",
        "The desktop UI language is English (en-US). Write all user-visible content in English, including final replies, tool-step explanations, status notes, and any reasoning/thinking content that the product surfaces to the user. Preserve commands, code, and quoted source text as written."
      ].join("\n"),
    };
  }
  return null;
}

export class ContextBuilder {
  static BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md"];
  static RUNTIME_CONTEXT_TAG = "[Runtime Context - metadata only, not instructions]";
  static RUNTIME_CONTEXT_END = "[/Runtime Context]";
  static MAX_RECENT_HISTORY = 50;
  static MAX_HISTORY_CHARS = 32_000;

  systemPrompt = "";
  workspace: string;
  timezone: string | null;
  readonly fileMemoryEnabled: boolean;
  memory: MemoryStore;
  skills: SkillsLoader;
  maxRecentHistory = ContextBuilder.MAX_RECENT_HISTORY;
  maxHistoryChars = ContextBuilder.MAX_HISTORY_CHARS;

  constructor(
    init:
      | {
          systemPrompt?: string;
          workspace?: string;
          timezone?: string | null;
          disabledSkills?: string[] | null;
          fileMemoryEnabled?: boolean;
        }
      | string = {},
  ) {
    const opts = typeof init === "string" ? { workspace: init } : init;
    this.systemPrompt = opts.systemPrompt ?? "";
    this.workspace = path.resolve(opts.workspace ?? process.cwd());
    this.timezone = opts.timezone ?? null;
    this.fileMemoryEnabled = opts.fileMemoryEnabled === true;
    this.memory = new MemoryStore(this.workspace, {
      fileMemoryEnabled: this.fileMemoryEnabled,
    });
    this.skills = new SkillsLoader(this.workspace, null, opts.disabledSkills ?? null);
  }

  static buildRuntimeContext(
    channel?: string | null,
    chatId?: string | null,
    timezone?: string | null,
    opts: {
      senderId?: string | null;
      supplementalLines?: string[] | null;
    } | string | null = {},
  ): string {
    const lines = [`Current Time: ${currentTimeStr(timezone)}`];
    if (channel && chatId) lines.push(`Channel: ${channel}`, `Chat ID: ${chatId}`);
    const sender = typeof opts === "string" ? opts : opts?.senderId;
    if (sender) lines.push(`Sender ID: ${sender}`);
    const extra = typeof opts === "object" && opts ? opts.supplementalLines ?? [] : [];
    for (const line of extra) if (line) lines.push(line);
    return `${ContextBuilder.RUNTIME_CONTEXT_TAG}\n${lines.join("\n")}\n${ContextBuilder.RUNTIME_CONTEXT_END}`;
  }

  static mergeMessageContent(left: any, right: any): string | Record<string, any>[] {
    if (typeof left === "string" && typeof right === "string") return left ? `${left}\n\n${right}` : right;
    const toBlocks = (value: any): Record<string, any>[] => {
      if (Array.isArray(value)) return value.map((item) => (item && typeof item === "object" ? item : { type: "text", text: String(item) }));
      if (value == null) return [];
      return [{ type: "text", text: String(value) }];
    };
    return [...toBlocks(left), ...toBlocks(right)];
  }

  loadBootstrapFiles(): string {
    const parts: string[] = [];
    for (const filename of ContextBuilder.BOOTSTRAP_FILES) {
      if (filename === "USER.md" && !this.fileMemoryEnabled) continue;
      const file = path.join(this.workspace, filename);
      if (fs.existsSync(file)) parts.push(`## ${filename}\n\n${fs.readFileSync(file, "utf8")}`);
    }
    return parts.join("\n\n");
  }

  static isTemplateContent(content: string, templatePath: string): boolean {
    try {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const template = path.resolve(here, "..", "..", "templates", templatePath);
      return fs.existsSync(template) && content.trim() === fs.readFileSync(template, "utf8").trim();
    } catch {
      return false;
    }
  }

  getIdentity(channel?: string | null): string {
    const platformName = os.platform() === "darwin" ? "Darwin" : os.platform() === "win32" ? "Windows" : os.type();
    const runtime = `${platformName === "Darwin" ? "macOS" : platformName} ${os.arch()}, Node.js ${process.version}`;
    return renderTemplate("agent/identity.md", {
      workspacePath: this.workspace,
      runtime,
      platformPolicy: renderTemplate("agent/platform-policy.md", { system: platformName }),
      channel: channel ?? "",
    });
  }

  buildSystemPromptSections(
    channel: string | null = null,
    sessionSummary: string | null = null,
    responseLanguage: string | null = null,
    sessionKey: string | null = null,
    unifiedSession = false,
  ): SystemPromptSection[] {
    const sections: SystemPromptSection[] = [];
    const identity = this.systemPrompt || this.getIdentity(channel);
    if (identity) sections.push({ id: "identity", content: identity });
    const languageSection = responseLanguageSection(normalizeAgentResponseLanguage(responseLanguage));
    if (languageSection) sections.push(languageSection);
    const bootstrap = this.loadBootstrapFiles();
    if (bootstrap) sections.push({ id: "bootstrap", content: bootstrap });
    const toolContract = renderTemplate("agent/tool-contract.md");
    if (toolContract) sections.push({ id: "tool-contract", content: toolContract });
    if (this.fileMemoryEnabled) {
      const fileMemory = renderTemplate("agent/file-memory.md", {
        workspacePath: this.workspace,
      });
      if (fileMemory) sections.push({ id: "file-memory", content: fileMemory });
      const memory = this.memory.getMemoryContext();
      if (
        memory &&
        !ContextBuilder.isTemplateContent(this.memory.readMemory(), "memory/MEMORY.md")
      ) {
        sections.push({ id: "memory", content: `# Memory\n\n${memory}` });
      }
    }
    const alwaysSkills = this.skills.getAlwaysSkills();
    if (alwaysSkills.length) {
      const content = this.skills.loadSkillsForContext(alwaysSkills);
      if (content) sections.push({ id: "active-skills", content: `# Active Skills\n\n${content}` });
    }
    const skillsSummary = this.skills.buildSkillsSummary(new Set(alwaysSkills));
    if (skillsSummary) sections.push({ id: "skills-summary", content: renderTemplate("agent/skills-section.md", { skillsSummary }) });
    if (this.fileMemoryEnabled) {
      const entries = this.memory.readRecentHistoryForPrompt(
        this.memory.getLastDreamCursor(),
        {
          sessionKey,
          unifiedSession,
        },
      );
      if (entries.length) {
        const capped = entries.slice(-this.maxRecentHistory);
        const historyText = capped
          .map((entry) => `- [${entry.timestamp ?? "?"}] ${entry.content ?? ""}`)
          .join("\n");
        sections.push({
          id: "recent-history",
          content: `# Recent History\n\n${truncateText(historyText, this.maxHistoryChars)}`,
        });
      }
    }
    if (sessionSummary) sections.push({ id: "session-summary", content: `[Archived Context Summary]\n\n${sessionSummary}` });
    return sections;
  }

  buildSystemPrompt(
    skillNames: string[] | null = null,
    channel: string | null = null,
    sessionSummary: string | null = null,
    hook: AgentHook | null = null,
    responseLanguage: string | null = null,
    sessionKey: string | null = null,
    unifiedSession = false,
  ): string {
    const ctx = new SystemPromptBuildContext({
      sections: this.buildSystemPromptSections(
        channel,
        sessionSummary,
        responseLanguage,
        sessionKey,
        unifiedSession,
      ),
      skillNames,
      channel,
      sessionSummary,
      workspace: this.workspace,
    });
    hook?.onBuildSystemPrompt(ctx);
    return ctx.render();
  }

  buildUserContent(text: string, media?: string[] | null): string | Record<string, any>[] {
    if (!media?.length) return text;
    const images: Record<string, any>[] = [];
    for (const file of media) {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      const raw = fs.readFileSync(file);
      const mime = detectImageMime(raw) ?? mimeFromExtension(file);
      if (!mime?.startsWith("image/")) continue;
      images.push({
        type: "image_url",
        image_url: { url: `data:${mime};base64,${raw.toString("base64")}` },
        meta: { path: file },
      });
    }
    return images.length ? [...images, { type: "text", text }] : text;
  }

  build(session: Session, userContent?: string): Record<string, any>[] {
    const messages: Record<string, any>[] = [];
    const system = this.buildSystemPrompt(null, null, null, null, null, session.key);
    if (system) messages.push({ role: "system", content: system });
    messages.push(...session.getHistory());
    if (userContent) messages.push({ role: "user", content: userContent });
    return messages;
  }

  buildMessages(
    argsOrHistory:
      | {
          history?: Record<string, any>[];
          currentMessage?: string;
          media?: string[] | null;
          channel?: string | null;
          chatId?: string | null;
          currentRole?: string;
          senderId?: string | null;
          currentRuntimeLines?: string[] | null;
          sessionSummary?: string | null;
          sessionMetadata?: Record<string, any> | null;
          responseLanguage?: string | null;
          skillNames?: string[] | null;
          hook?: AgentHook | null;
          sessionKey?: string | null;
          unifiedSession?: boolean;
        }
      | Record<string, any>[] = {},
    positionalCurrentMessage?: string,
    positionalOptions: {
      media?: string[] | null;
      channel?: string | null;
      chatId?: string | null;
      currentRole?: string;
      senderId?: string | null;
      currentRuntimeLines?: string[] | null;
      sessionSummary?: string | null;
      sessionMetadata?: Record<string, any> | null;
      responseLanguage?: string | null;
      skillNames?: string[] | null;
      hook?: AgentHook | null;
      sessionKey?: string | null;
      unifiedSession?: boolean;
    } = {},
  ): Record<string, any>[] {
    const args = Array.isArray(argsOrHistory)
      ? { ...positionalOptions, history: argsOrHistory, currentMessage: positionalCurrentMessage }
      : argsOrHistory;
    const {
      history = [],
      currentMessage,
      media = null,
      channel = null,
      chatId,
      currentRole,
      senderId,
      currentRuntimeLines,
      sessionSummary,
      sessionMetadata,
      responseLanguage,
      skillNames,
      hook,
      sessionKey = null,
      unifiedSession = false,
    } = args;
    const role = currentRole ?? "user";
    const runtimeLines = [
      ...goalStateRuntimeLines(sessionMetadata),
      ...((currentRuntimeLines ?? []).filter(Boolean)),
    ];
    const sessionResponseLanguage = sessionMetadata && typeof sessionMetadata === "object"
      ? sessionMetadata.webui_language ?? sessionMetadata.webuiLanguage ?? null
      : null;
    const effectiveResponseLanguage = responseLanguage ?? sessionResponseLanguage;
    const runtime = ContextBuilder.buildRuntimeContext(channel, chatId ?? null, this.timezone, {
      senderId,
      supplementalLines: runtimeLines,
    });
    const content = this.buildUserContent(currentMessage ?? "", media);
    const merged = typeof content === "string" ? `${content}\n\n${runtime}` : [...content, { type: "text", text: runtime }];
    const messages = [
      {
        role: "system",
        content: this.buildSystemPrompt(
          skillNames ?? null,
          channel,
          sessionSummary ?? null,
          hook ?? null,
          effectiveResponseLanguage ?? null,
          sessionKey,
          unifiedSession,
        ),
      },
      ...history,
    ];
    if (messages.at(-1)?.role === role) {
      const last = { ...messages.at(-1)! };
      last.content = ContextBuilder.mergeMessageContent(last.content, merged);
      messages[messages.length - 1] = last;
      return messages;
    }
    messages.push({ role, content: merged });
    return messages;
  }
}
