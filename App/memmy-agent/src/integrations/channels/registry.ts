import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { BaseChannel } from "./base.js";
import { DingtalkChannel } from "./dingtalk.js";
import { DiscordChannel } from "./discord.js";
import { EmailChannel } from "./email.js";
import { FeishuChannel } from "./feishu.js";
import { IMessageChannel } from "./imessage.js";
import { MatrixChannel } from "./matrix.js";
import { MochatChannel } from "./mochat.js";
import { MSTeamsChannel } from "./msteams.js";
import { QQChannel } from "./qq.js";
import { SignalChannel } from "./signal.js";
import { SlackChannel } from "./slack.js";
import { TelegramChannel } from "./telegram.js";
import { WebSocketChannel } from "./websocket.js";
import { WecomChannel } from "./wecom.js";
import { WeixinChannel } from "./weixin.js";
import { WhatsappChannel } from "./whatsapp.js";

export type ChannelClass = new (...args: any[]) => BaseChannel;

const BUILTIN_CHANNELS: Record<string, ChannelClass> = {
  dingtalk: DingtalkChannel,
  discord: DiscordChannel,
  email: EmailChannel,
  feishu: FeishuChannel,
  imessage: IMessageChannel,
  matrix: MatrixChannel,
  mochat: MochatChannel,
  msteams: MSTeamsChannel,
  qq: QQChannel,
  signal: SignalChannel,
  slack: SlackChannel,
  telegram: TelegramChannel,
  websocket: WebSocketChannel,
  wecom: WecomChannel,
  weixin: WeixinChannel,
  whatsapp: WhatsappChannel,
};

const pluginRegistry = new Map<string, ChannelClass>();

type PluginDescriptor = {
  name: string;
  module: string;
  exportName?: string;
};

export function registerChannel(name: string, cls: ChannelClass): void {
  const normalized = normalizeChannelName(name);
  if (!normalized) throw new Error("channel name is required");
  pluginRegistry.set(normalized, cls);
}

export function normalizeChannelName(name: string): string {
  return String(name).trim().toLowerCase().replaceAll("-", "_");
}

export function discoverChannelNames(): string[] {
  return Object.keys(BUILTIN_CHANNELS).sort();
}

export function loadChannelClass(moduleName: string): ChannelClass {
  const normalized = normalizeChannelName(moduleName);
  const cls = BUILTIN_CHANNELS[normalized];
  if (!cls) throw new Error(`No BaseChannel subclass in memmy-agent channels.${moduleName}`);
  return cls;
}

export function discoverPlugins(enabledNames: Set<string> | string[] | null = null): Record<string, ChannelClass> {
  const enabled = enabledNames == null ? null : new Set([...enabledNames].map(normalizeChannelName));
  const out: Record<string, ChannelClass> = {};
  for (const [name, cls] of discoverPackagePlugins(enabled).entries()) {
    out[name] = cls;
  }
  for (const [name, cls] of pluginRegistry.entries()) {
    if (enabled && !enabled.has(name)) continue;
    out[name] = cls;
  }
  return out;
}

function packageSearchRoots(): string[] {
  const envRoots = String(process.env.MEMMY_AGENT_CHANNEL_PLUGIN_PATHS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const roots = [
    ...envRoots,
    path.join(process.cwd(), "node_modules"),
    path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "node_modules"),
  ];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function packageJsonPaths(root: string): string[] {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith(".")) continue;
    const entryPath = path.join(root, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;
    if (entry.startsWith("@")) {
      for (const scoped of fs.readdirSync(entryPath)) {
        const scopedPath = path.join(entryPath, scoped, "package.json");
        if (fs.existsSync(scopedPath) && fs.statSync(scopedPath).isFile()) out.push(scopedPath);
      }
      continue;
    }
    const packageJson = path.join(entryPath, "package.json");
    if (fs.existsSync(packageJson) && fs.statSync(packageJson).isFile()) out.push(packageJson);
  }
  return out;
}

function channelDescriptors(pkg: Record<string, any>): PluginDescriptor[] {
  const channels = pkg.memmyAgent?.channels ?? pkg["memmy-agent"]?.channels;
  if (!channels || typeof channels !== "object") return [];
  const out: PluginDescriptor[] = [];
  if (Array.isArray(channels)) {
    for (const item of channels) {
      if (typeof item === "string") {
        const [moduleName, exportName] = item.split("#", 2);
        const name = normalizeChannelName(path.basename(moduleName).replace(/\.[cm]?js$/i, ""));
        if (name && moduleName) out.push({ name, module: moduleName, exportName });
      } else if (item && typeof item === "object") {
        const name = normalizeChannelName(String(item.name ?? ""));
        const moduleName = String(item.module ?? item.entry ?? item.import ?? "");
        if (name && moduleName) out.push({ name, module: moduleName, exportName: item.export ?? item.exportName });
      }
    }
    return out;
  }
  for (const [rawName, rawValue] of Object.entries(channels)) {
    const name = normalizeChannelName(rawName);
    if (!name) continue;
    if (typeof rawValue === "string") {
      const [moduleName, exportName] = rawValue.split("#", 2);
      if (moduleName) out.push({ name, module: moduleName, exportName });
    } else if (rawValue && typeof rawValue === "object") {
      const moduleName = String((rawValue as any).module ?? (rawValue as any).entry ?? (rawValue as any).import ?? "");
      if (moduleName) out.push({ name, module: moduleName, exportName: (rawValue as any).export ?? (rawValue as any).exportName });
    }
  }
  return out;
}

function loadPackagePlugin(packageJson: string, descriptor: PluginDescriptor): ChannelClass | null {
  try {
    const localRequire = createRequire(packageJson);
    const mod = localRequire(descriptor.module);
    const exportName = descriptor.exportName || "default";
    const cls = mod?.[exportName] ?? mod?.default ?? mod;
    return typeof cls === "function" ? cls as ChannelClass : null;
  } catch {
    return null;
  }
}

export function discoverPackagePlugins(enabled: Set<string> | null = null): Map<string, ChannelClass> {
  const out = new Map<string, ChannelClass>();
  for (const root of packageSearchRoots()) {
    for (const packageJson of packageJsonPaths(root)) {
      let pkg: Record<string, any>;
      try {
        pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
      } catch {
        continue;
      }
      for (const descriptor of channelDescriptors(pkg)) {
        if (enabled && !enabled.has(descriptor.name)) continue;
        if (out.has(descriptor.name)) continue;
        const cls = loadPackagePlugin(packageJson, descriptor);
        if (cls) out.set(descriptor.name, cls);
      }
    }
  }
  return out;
}

export function discoverEnabled(
  enabledNames: Set<string> | string[],
  {
    names = null,
    includeAllExternal = false,
  }: {
    names?: string[] | null;
    includeAllExternal?: boolean;
  } = {},
): Record<string, ChannelClass> {
  const enabled = new Set([...enabledNames].map(normalizeChannelName));
  const sourceNames = names ?? discoverChannelNames();
  const out: Record<string, ChannelClass> = {};
  for (const name of sourceNames) {
    const normalized = normalizeChannelName(name);
    if (!enabled.has(normalized)) continue;
    const cls = BUILTIN_CHANNELS[normalized];
    if (cls) out[normalized] = cls;
  }
  const plugins = discoverPlugins(includeAllExternal ? null : enabled);
  for (const [name, cls] of Object.entries(plugins)) {
    if (name in out) continue;
    if (includeAllExternal || enabled.has(name)) out[name] = cls;
  }
  return out;
}

export function discoverAll(): Record<string, ChannelClass> {
  return discoverEnabled(new Set(discoverChannelNames()), { includeAllExternal: true });
}

export function getChannel(name: string): ChannelClass | undefined {
  const normalized = normalizeChannelName(name);
  return BUILTIN_CHANNELS[normalized] ?? pluginRegistry.get(normalized);
}

export function channelMetadata(): Array<Record<string, any>> {
  return Object.entries(discoverAll()).map(([name, cls]) => ({
    name,
    className: cls.name,
    builtin: name in BUILTIN_CHANNELS,
  }));
}
