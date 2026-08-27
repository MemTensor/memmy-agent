import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "mime-types";
import { OutboundMessage } from "../../core/runtime-messages/index.js";
import { getBridgeInstallDir, getRuntimeSubdir } from "../../config/paths.js";
import { BaseChannel } from "./base.js";

function coalesce<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function jidLocalPart(value: string): string {
  const raw = String(value || "");
  return raw.includes("@") ? raw.split("@", 1)[0] : raw;
}

function guessMime(filePath: string): string {
  return lookup(filePath) || "application/octet-stream";
}

function findExecutable(name: string): string | null {
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the rest of PATH.
      }
    }
  }
  return null;
}

function walkFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function sourceHash(root: string): string {
  const digest = crypto.createHash("sha256");
  for (const filePath of walkFiles(root).sort()) {
    const rel = path.relative(root, filePath).split(path.sep).join("/");
    digest.update(rel);
    digest.update("\0");
    digest.update(fs.readFileSync(filePath));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function bridgeSourceCandidates(): string[] {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(currentDir, "..", "bridge"),
    path.resolve(currentDir, "..", "..", "bridge"),
    path.resolve(currentDir, "..", "..", "..", "bridge"),
  ];
}

function copyBridgeSource(source: string, destination: string): void {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(source, src);
      const first = rel.split(path.sep)[0];
      return first !== "node_modules" && first !== "dist";
    },
  });
}

export class WhatsappConfig {
  enabled = false;
  bridgeUrl = "ws://localhost:3001";
  bridgeToken = "";
  allowFrom: string[] = [];
  groupPolicy = "open";
  bridgeSetup?: () => string | Promise<string>;
  bridgeRunner?: (call: Record<string, any>) => any;
  websocketConnector?: (url: string) => Promise<any> | any;

  constructor(init: Partial<WhatsappConfig> & Record<string, any> = {}) {
    this.enabled = Boolean(coalesce(init.enabled, this.enabled));
    this.bridgeUrl = coalesce(init.bridgeUrl, this.bridgeUrl) ?? "ws://localhost:3001";
    this.bridgeToken = coalesce(init.bridgeToken, this.bridgeToken) ?? "";
    this.allowFrom = asArray(coalesce(init.allowFrom, this.allowFrom));
    this.groupPolicy = coalesce(init.groupPolicy, this.groupPolicy) ?? "open";
    this.bridgeSetup = init.bridgeSetup;
    this.bridgeRunner = init.bridgeRunner;
    this.websocketConnector = init.websocketConnector;
  }
}

export const WhatsAppConfig = WhatsappConfig;

export function bridgeTokenPath(): string {
  return path.join(getRuntimeSubdir("whatsapp-auth"), "bridge-token");
}

export function loadOrCreateBridgeToken(tokenPath: string): string {
  if (fs.existsSync(tokenPath)) {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  }
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(tokenPath, 0o600);
  } catch {
    // Windows and constrained filesystems may reject chmod; the token is still persisted.
  }
  return token;
}

export function ensureBridgeSetup(): string {
  const userBridge = getBridgeInstallDir();
  const stampFile = path.join(userBridge, ".memmy-bridge-source-hash");
  const source = bridgeSourceCandidates().find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
  if (!source) {
    throw new Error("WhatsApp bridge source not found. Try reinstalling memmy-agent.");
  }

  const expectedHash = sourceHash(source);
  const currentHash = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8").trim() : null;
  if (fs.existsSync(path.join(userBridge, "dist", "index.js")) && currentHash === expectedHash) {
    return userBridge;
  }

  const npmPath = findExecutable("npm");
  if (!npmPath) throw new Error("npm not found. Please install Node.js >= 18.");

  fs.mkdirSync(path.dirname(userBridge), { recursive: true });
  copyBridgeSource(source, userBridge);

  let result = spawnSync(npmPath, ["install"], { cwd: userBridge, stdio: "pipe" });
  if (result.error || result.status !== 0) throw result.error ?? new Error("WhatsApp bridge npm install failed.");
  result = spawnSync(npmPath, ["run", "build"], { cwd: userBridge, stdio: "pipe" });
  if (result.error || result.status !== 0) throw result.error ?? new Error("WhatsApp bridge build failed.");
  fs.writeFileSync(stampFile, `${expectedHash}\n`, "utf8");
  return userBridge;
}

function bridgeRunSucceeded(result: any): boolean {
  if (result === false) return false;
  if (typeof result === "number") return result === 0;
  if (result && typeof result === "object") {
    if (result.error) return false;
    if (typeof result.status === "number") return result.status === 0;
  }
  return true;
}

async function createDefaultWhatsappWebsocketConnector(url: string): Promise<any> {
  const { WebSocket } = await import("ws");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WhatsApp bridge websocket connection timed out"));
    }, 30_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve({
        raw: ws,
        on: (...args: any[]) => (ws as any).on(...args),
        close: () =>
          new Promise<void>((done) => {
            ws.once("close", () => done());
            ws.close();
          }),
        send: (raw: string) =>
          new Promise<void>((done, fail) => {
            ws.send(raw, (error) => (error ? fail(error) : done()));
          }),
      });
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export class WhatsappChannel extends BaseChannel {
  override name = "whatsapp";
  override displayName = "WhatsApp";
  override config: WhatsappConfig;
  ws: any = null;
  connected = false;
  processedMessageIds = new Map<string, null>();
  lidToPhone: Record<string, string> = {};
  bridgeAuthToken: string | null = null;

  static override defaultConfig(): Record<string, any> {
    return new WhatsappConfig() as any;
  }

  constructor(config: Partial<WhatsappConfig> & Record<string, any> = {}, bus?: any) {
    const normalized = config instanceof WhatsappConfig ? config : new WhatsappConfig(config);
    super("whatsapp", normalized, bus);
    this.config = normalized;
  }

  effectiveBridgeToken(): string {
    if (this.bridgeAuthToken) return this.bridgeAuthToken;
    const configured = this.config.bridgeToken.trim();
    this.bridgeAuthToken = configured || loadOrCreateBridgeToken(bridgeTokenPath());
    return this.bridgeAuthToken;
  }

  override async login(force = false): Promise<boolean> {
    let bridgeDir: string;
    try {
      const setup = this.config.bridgeSetup ?? ensureBridgeSetup;
      bridgeDir = String(await setup());
    } catch {
      return false;
    }

    const tokenPath = bridgeTokenPath();
    const env = {
      ...process.env,
      BRIDGE_TOKEN: this.effectiveBridgeToken(),
      AUTH_DIR: path.dirname(tokenPath),
    };
    const npmPath = findExecutable("npm") ?? "npm";
    try {
      const runner = this.config.bridgeRunner;
      if (runner) {
        const result = await runner({ npmPath, args: ["start"], cwd: bridgeDir, bridgeDir, env });
        return bridgeRunSucceeded(result);
      }
      const result = spawnSync(npmPath, ["start"], { cwd: bridgeDir, env, stdio: "inherit" });
      return bridgeRunSucceeded(result);
    } catch {
      return false;
    }
  }

  override async start(): Promise<void> {
    const connector = this.config.websocketConnector ?? createDefaultWhatsappWebsocketConnector;
    this.running = true;
    const ws = await connector(this.config.bridgeUrl);
    this.ws = ws;
    this.attachBridgeSocketHandlers(ws);
    await ws.send(JSON.stringify({ type: "auth", token: this.effectiveBridgeToken() }));
    this.connected = true;
    if (Symbol.asyncIterator in Object(ws)) {
      for await (const raw of ws) {
        if (!this.running) break;
        await this.handleBridgeMessage(String(raw));
      }
    }
  }

  attachBridgeSocketHandlers(ws: any): void {
    ws.on?.("message", (raw: any) => {
      void this.handleBridgeMessage(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw));
    });
    ws.on?.("close", () => {
      this.connected = false;
    });
    ws.on?.("error", () => {
      this.connected = false;
    });
  }

  override async stop(): Promise<void> {
    this.running = false;
    this.connected = false;
    await this.ws?.close?.();
    this.ws = null;
  }

  override async send(msg: OutboundMessage): Promise<void> {
    if (!this.ws || !this.connected) return;
    if (msg.content) {
      await this.ws.send(JSON.stringify({ type: "send", to: msg.chatId, text: msg.content }));
    }
    for (const mediaPath of msg.media ?? []) {
      await this.ws.send(
        JSON.stringify({
          type: "send_media",
          to: msg.chatId,
          filePath: mediaPath,
          mimetype: guessMime(mediaPath),
          fileName: path.basename(mediaPath),
        }),
      );
    }
  }

  async handleBridgeMessage(raw: string): Promise<void> {
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const msgType = data.type;
    if (msgType === "status") {
      if (data.status === "connected") this.connected = true;
      if (data.status === "disconnected") this.connected = false;
      return;
    }
    if (msgType !== "message") return;

    const isGroup = Boolean(data.isGroup);
    if (isGroup && this.config.groupPolicy === "mention" && !data.wasMentioned) return;

    const rawPn = String(data.pn || "");
    const rawSender = String(data.sender || "");
    const idPn = jidLocalPart(rawPn);
    const idSender = jidLocalPart(rawSender);
    let phoneId = "";
    let lidId = "";
    for (const [rawId, extracted] of [
      [rawPn, idPn],
      [rawSender, idSender],
    ]) {
      if (!extracted) continue;
      if (rawId.includes("@s.whatsapp.net")) phoneId = extracted;
      else if (rawId.includes("@lid.whatsapp.net")) lidId = extracted;
      else if (!phoneId) phoneId = extracted;
    }
    const senderId = phoneId || this.lidToPhone[lidId] || lidId || idPn || idSender;
    if (!this.isAllowed(senderId)) return;

    const messageId = String(data.id || "");
    if (messageId) {
      if (this.processedMessageIds.has(messageId)) return;
      this.processedMessageIds.set(messageId, null);
      while (this.processedMessageIds.size > 1000) {
        const first = this.processedMessageIds.keys().next().value;
        if (first === undefined) break;
        this.processedMessageIds.delete(first);
      }
    }
    if (phoneId && lidId) this.lidToPhone[lidId] = phoneId;

    let content = String(data.content || "");
    let mediaPaths = Array.isArray(data.media) ? data.media.map(String) : [];
    if (content === "[Voice Message]") {
      if (mediaPaths.length) {
        const transcription = await this.transcribeAudio(mediaPaths[0]);
        content = transcription || "[Voice Message: Transcription failed]";
        if (transcription) mediaPaths = [];
      } else {
        content = "[Voice Message: Audio not available]";
      }
    }
    if (mediaPaths.length) {
      for (const mediaPath of mediaPaths) {
        const mime = guessMime(mediaPath);
        const kind = mime.startsWith("image/") ? "image" : "file";
        const marker = `[${kind}: ${mediaPath}]`;
        content = content ? `${content}\n${marker}` : marker;
      }
    }

    await this.handleMessage({
      senderId,
      chatId: rawSender,
      content,
      media: mediaPaths,
      metadata: {
        messageId,
        timestamp: data.timestamp,
        isGroup,
      },
    });
  }
}

export const WhatsAppChannel = WhatsappChannel;
