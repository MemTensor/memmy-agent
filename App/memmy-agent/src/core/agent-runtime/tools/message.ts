import path from "node:path";
import { OutboundMessage } from "../../runtime-messages/events.js";
import { getWorkspacePath } from "../../../config/paths.js";
import { stripThink } from "../../../utils/helpers.js";
import { isPathInside } from "./path-utils.js";
import { RequestContext, RequestContextStore } from "./context.js";
import { Tool } from "./base.js";

export type MessageSendCallback = (message: OutboundMessage) => Promise<void> | void;

function isUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function validateButtons(buttons: any): boolean {
  return Array.isArray(buttons) && buttons.every((row) => Array.isArray(row) && row.every((label) => typeof label === "string"));
}

export class MessageTool extends Tool {
  static scopes = new Set(["core"]);
  suppress = false;
  messages: string[] = [];
  private sendCallback?: MessageSendCallback;
  private workspace: string;
  private restrictToWorkspace: boolean;
  private defaultChannel = "";
  private defaultChatId = "";
  private defaultMessageId: string | null = null;
  private defaultMetadata: Record<string, any> = {};
  private readonly requestContext = new RequestContextStore();
  sentInTurn = false;
  private turnMedia: string[] = [];
  private recordChannelDelivery = false;

  constructor({
    suppress = false,
    sendCallback,
    defaultChannel = "",
    defaultChatId = "",
    defaultMessageId = null,
    workspace = null,
    restrictToWorkspace = false,
  }: {
    suppress?: boolean;
    sendCallback?: MessageSendCallback;
    defaultChannel?: string;
    defaultChatId?: string;
    defaultMessageId?: string | null;
    workspace?: string | null;
    restrictToWorkspace?: boolean;
  } = {}) {
    super();
    this.suppress = suppress;
    this.sendCallback = sendCallback;
    this.workspace = path.resolve(getWorkspacePath(workspace));
    this.restrictToWorkspace = restrictToWorkspace;
    this.defaultChannel = defaultChannel;
    this.defaultChatId = defaultChatId;
    this.defaultMessageId = defaultMessageId;
  }

  static create(ctx: any): Tool {
    return new MessageTool({
      sendCallback: ctx.messageSendCallback ?? ctx.bus?.publishOutbound?.bind(ctx.bus),
      workspace: ctx.workspace,
      restrictToWorkspace: ctx.config?.restrictToWorkspace ?? false,
    });
  }

  get name(): string {
    return "message";
  }

  get description(): string {
    return (
      "Proactively send a message to a user/channel, optionally with file attachments. " +
      "Use this for reminders, cross-channel delivery, or explicit proactive sends. " +
      "Do not use this for the normal reply in the current chat: answer naturally instead. " +
      "If channel/chat_id would target the current runtime conversation, do not call this tool " +
      "unless the user explicitly asked you to proactively send an existing file attachment. " +
      "When generate_image creates images in the current chat, use the message tool " +
      "with the artifact paths in the media parameter to deliver the images to the user. " +
      "For proactive attachment delivery, use the 'media' parameter with file paths. " +
      "Do NOT use read_file to send files - that only reads content for your own analysis."
    );
  }

  get parameters() {
    return {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Message content for proactive or cross-channel delivery. Do not use this for a normal reply in the current chat.",
        },
        text: { type: "string" },
        channel: {
          type: "string",
          description: "Optional target channel for cross-channel/proactive delivery. Do not set this to the current runtime channel for a normal reply.",
        },
        chat_id: {
          type: "string",
          description:
            "Optional target chat/user ID for cross-channel/proactive delivery. On WebSocket/WebUI turns: omit chat_id to use the server's conversation id (never pass client_id values like anon-...). Do not set this to the current runtime chat for a normal reply.",
        },
        media: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of existing file paths to attach. Use artifact paths returned by generate_image here when delivering generated images.",
        },
        buttons: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "Optional: inline keyboard buttons as list of rows, each row is list of button labels.",
        },
      },
      required: ["content"],
    };
  }

  setContext(ctx: RequestContext): void {
    this.requestContext.set(ctx);
    this.defaultChannel = ctx.channel ?? "";
    this.defaultChatId = ctx.chatId ?? "";
    this.defaultMessageId = ctx.messageId ?? null;
    this.defaultMetadata = { ...(ctx.metadata ?? {}) };
  }

  setSendCallback(callback: MessageSendCallback): void {
    this.sendCallback = callback;
  }

  startTurn(): void {
    this.sentInTurn = false;
    this.turnMedia = [];
  }

  turnDeliveredMediaPaths(): string[] {
    return [...this.turnMedia];
  }

  setRecordChannelDelivery(active: boolean): boolean {
    const previous = this.recordChannelDelivery;
    this.recordChannelDelivery = active;
    return previous;
  }

  resetRecordChannelDelivery(token: boolean): void {
    this.recordChannelDelivery = token;
  }

  private resolveMedia(media: string[]): string[] {
    const resolved: string[] = [];
    for (const item of media) {
      if (isUrl(item)) {
        resolved.push(item);
        continue;
      }

      if (!this.restrictToWorkspace) {
        const expanded = item.startsWith("~/") ? path.join(process.env.HOME ?? "", item.slice(2)) : item;
        resolved.push(path.isAbsolute(expanded) ? expanded : path.join(this.workspace, expanded));
        continue;
      }

      const target = path.resolve(this.workspace, item);
      if (!isPathInside(target, this.workspace)) {
        throw new Error(`${target} is outside allowed directory ${this.workspace}`);
      }
      resolved.push(target);
    }
    return resolved;
  }

  async execute(params: {
    content?: string;
    text?: string;
    channel?: string | null;
    chat_id?: string | null;
    chatId?: string | null;
    message_id?: string | null;
    messageId?: string | null;
    media?: string[] | null;
    buttons?: string[][] | null;
  } = {}): Promise<string> {
    const requestContext = this.requestContext.get();
    const defaultChannel = requestContext?.channel ?? this.defaultChannel;
    const defaultChatId = requestContext?.chatId ?? this.defaultChatId;
    const defaultMessageId = requestContext?.messageId ?? this.defaultMessageId;
    const defaultMetadata = requestContext ? { ...(requestContext.metadata ?? {}) } : { ...this.defaultMetadata };
    const content = stripThink(params.content ?? params.text ?? "");
    const buttons = params.buttons ?? null;
    if (buttons != null && !validateButtons(buttons)) return "Error: buttons must be a list of list of strings";

    const channel = params.channel || defaultChannel;
    const explicitChatId = params.chat_id ?? params.chatId ?? null;
    if (
      defaultChannel === "websocket" &&
      channel === "websocket" &&
      explicitChatId != null &&
      String(explicitChatId).trim() !== "" &&
      String(explicitChatId).trim() !== String(defaultChatId).trim()
    ) {
      return (
        "Error: chat_id does not match the active WebSocket conversation. " +
        "Omit chat_id (and usually channel) so delivery uses the current conversation id from context."
      );
    }

    const chatId = explicitChatId || defaultChatId;
    const sameTarget = channel === defaultChannel && chatId === defaultChatId;
    const messageId = sameTarget ? (params.message_id ?? params.messageId ?? defaultMessageId) : null;

    if (!channel || !chatId) return "Error: No target channel/chat specified";
    if (!this.sendCallback) return "Error: Message sending not configured";

    let media = params.media ?? [];
    if (media.length) {
      try {
        media = this.resolveMedia(media);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return `Error: media path is not allowed: ${reason}`;
      }
    }

    const metadata = sameTarget ? defaultMetadata : {};
    if (messageId) metadata.message_id = messageId;
    if (this.recordChannelDelivery || media.length) metadata.recordChannelDelivery = true;

    const message = new OutboundMessage({
      channel,
      chatId,
      content,
      media,
      buttons: buttons ?? [],
      metadata,
    });

    try {
      await this.sendCallback(message);
      if (sameTarget) {
        this.sentInTurn = true;
        if (media.length) this.turnMedia.push(...media.map((item) => (isUrl(item) ? item : path.resolve(item))));
      }
      const mediaInfo = media.length ? ` with ${media.length} attachments` : "";
      const buttonCount = buttons?.reduce((sum, row) => sum + row.length, 0) ?? 0;
      const buttonInfo = buttonCount ? ` with ${buttonCount} button(s)` : "";
      return `Message sent to ${channel}:${chatId}${mediaInfo}${buttonInfo}`;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return `Error sending message: ${reason}`;
    }
  }
}
